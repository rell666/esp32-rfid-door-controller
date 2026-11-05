// Headless-browser E2E: drives the real compiled UI (src/webh) against the
// device simulator. Exits 0 and prints "UI E2E PASSED" only if every check holds.
//
//   node test/e2e/run.mjs            (needs test/e2e/node_modules: npm ci)
//   CHROMIUM=/path/to/chrome node test/e2e/run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { applyConfigPolicy as simPolicy, policyBoard as simBoard, checkUserRecord as simUserRecord, adminHa1, STEP_UP_COMMANDS, checkUpdateImageHead as simImageHead } from "./device-sim.mjs";
import crypto from "node:crypto";
import http from "node:http";
import { startSim } from "./device-sim.mjs";

// Checks of the Bootstrap 3 / jQuery / FooTable UI that tested library
// mechanics the plain-JS UI no longer has (a record of the 1.5.0 rewrite, ledger H20.1):
/* DROPPED-CHECKS
SPI SS cannot collide with fixed SPI SCK :: the MFRC522, PN532 and RDM6300 readers were removed (2026-10-16, J15): no SPI bus is used; the shared config-policy vectors now check that only Wiegand is accepted
on a desktop labels keep their column :: tested Bootstrap's form-horizontal label column (col-sm-3); the new layout puts every label above its field at every width (phone-first design), and the phone half of the check is kept
*/

const here = path.dirname(fileURLToPath(import.meta.url));
// A setpassword message as the page builds it (core::openPasswordChange):
// for sockets opened from Node, outside the page
const md5n = (s) => crypto.createHash("md5").update(s).digest("hex");
const passwordChange = (newPass, currentPass, token) => {
  const cur = adminHa1(currentPass), next = adminHa1(newPass);
  const key = Buffer.from(md5n(`${cur}:${token}:set-key`), "hex");
  const enc = Buffer.from(next, "hex").map((b, i) => b ^ key[i]).toString("hex");
  return JSON.stringify({ command: "setpassword", ha1enc: enc, proof: md5n(`${cur}:${token}:${next}`), len: newPass.length });
};
const repo = path.resolve(here, "../..");
const shotDir = process.env.E2E_SHOTS || path.join(here, "shots");
fs.mkdirSync(shotDir, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = path.join(os.homedir(), ".cache", "ms-playwright");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(base, d, "chrome-linux64", "chrome");
    if (fs.existsSync(p)) return p;
    const q = path.join(base, d, "chrome-linux", "chrome");
    if (fs.existsSync(q)) return q;
  }
  throw new Error("No Chromium found; set CHROMIUM");
}

// the UI's in-page messages (it shows no alert() / confirm() dialogs)
const msgs = (p) => p.evaluate(() => [...document.querySelectorAll("#msgarea .msgtext")].map((m) => m.textContent));
// the UI's dialogs are native <dialog>s: open means the open attribute
const waitOpen = (p, id, timeout = 5000) => p.waitForSelector(`#${id}[open]`, { timeout });
const waitClosed = (p, id, timeout = 5000) => p.waitForFunction((d) => !document.getElementById(d) || !document.getElementById(d).open, id, { timeout });
const isOpen = (p, id) => p.evaluate((d) => !!document.getElementById(d) && document.getElementById(d).open, id);
// leaving a settings page with edits its Save did not stage asks first (plan
// 1.9 C1): go on without them; true if it asked
// a page's Save stages and opens the review (plan 1.9 C2): closed again, the
// changes stay staged
const savePageClose = async (p, section) => {
  await p.click(`#ajaxcontent [data-onclick="savePage"][data-arg="${section}"]`);
  await p.waitForTimeout(300);
  if (await isOpen(p, "reviewmodal")) {
    await p.click("#reviewmodal .dlg-head [data-close]");
    await p.waitForFunction(() => !document.querySelector("#reviewmodal[open]"));
  }
};
const leaveIfAsked = async (p) => {
  await p.waitForTimeout(150);
  if (!(await isOpen(p, "leavedlg"))) return false;
  await p.click("#leavedlg [data-onclick=leaveGo]");
  return true;
};
// answer the UI's confirmation dialog
async function confirmYes(p) {
  await waitOpen(p, "confirmmodal");
  await p.click("#confirmok");
  await waitClosed(p, "confirmmodal");
}
// a menu link (#sidebar #<id>); on a phone the menu is a drawer, opened first
async function navAsk(p, id) {
  if (((p.viewportSize() || { width: 1280 }).width) < 900) {
    await p.click("#sidebarCollapse");
    await p.waitForTimeout(250);
  }
  await p.click(`#sidebar #${id}`);
}
// a page link; a settings page left with edits not staged asks first (plan
// 1.9 C1, checked on its own with navAsk): here it goes on without them
async function nav(p, id) {
  await navAsk(p, id);
  if (await p.evaluate(() => !!document.getElementById("leavedlg") && document.getElementById("leavedlg").open)) {
    await p.click("#leavedlg [data-onclick=leaveGo]");
  }
}
// the save bar is shown only while settings are staged
const unsavedBar = (p) => p.evaluate(() => !document.querySelector(".footer").hidden);
// a radio of a segmented group, by tapping its visible label
const pickRadio = (p, name, value) => p.click(`#ajaxcontent label:has(> input[name="${name}"][value="${value}"])`);
// sign in on the sign-in dialog
async function signIn(p, password) {
  await waitOpen(p, "signin", 10000);
  await p.fill("#password", password);
  await p.click("#signin button[type=submit]");
}

// let the dialog/page animations finish so screenshots show the final state
const settle = (p) => p.waitForTimeout(600);

let failures = 0;
let checks = 0;
function check(cond, label, detail = "") {
  checks++;
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

// ---- fixtures -------------------------------------------------------------
// the first bytes of firmware images (as in bin/*.bin): an app image for a chip
// (0 = ESP32, 9 = ESP32-S3), and the ESP32-S3 full-flash image (bootloader first)
function imageHead(chip, app = true, size = 64) {
  const b = Buffer.alloc(size);
  b[0] = 0xe9; b[1] = app ? 5 : 3; b[12] = chip;
  if (app) b.writeUInt32LE(0xabcd5432, 32);
  return b;
}
const XSS = '<img src=x onerror="window.__xss=1">';
const XSS_NEWEST = '<img src=x onerror="window.__xss=2">'; // newest entry: first row rendered
const XSS_USER = '<img src=x onerror="window.__xss=4">';
const XSS_SSID = '<img src=x onerror=window.__xss=3>';
const eventLines = [];
for (let i = 0; i < 600; i++) {
  eventLines.push({ type: i % 7 ? "INFO" : "WARN", src: "mqtt", desc: i === 300 ? XSS : i === 599 ? XSS_NEWEST : `event ${i}`, data: `seq-${i}-` + "x".repeat(i % 120), time: 1760000000 + i });
}
const latestLines = [];
for (let i = 0; i < 250; i++) {
  latestLines.push({ uid: (0x10000000 + i).toString(16), username: `User ${i}`, acctype: 1, access: 1, timestamp: 1760000000 + i });
}
const users = [];
for (let i = 0; i < 300; i++) {
  users.push({ uid: (0xa0000000 + i).toString(16), username: i === 0 ? XSS_USER : `Person ${i}`, acctype: 1, acctype2: 0, acctype3: 0, acctype4: 0, validsince: 0, validuntil: 4102444800, pincode: i === 1 ? "2468" : "" });
}

// the simulator's /update head check against the shared vectors (as
// tests.cpp checks core::checkUpdateImageHead; plan 1.9.1 E4)
{
  const vec = JSON.parse(fs.readFileSync(path.join(repo, "test/vectors/update-image-head.json"), "utf8"));
  const wrong = vec.cases.filter((c) => {
    const d = Buffer.alloc(c.len);
    for (const [k, v] of Object.entries(c.set)) d[Number(k)] = v;
    return simImageHead(d, c.chip) !== c.want;
  }).map((c) => c.name);
  check(vec.cases.length >= 10 && wrong.length === 0, `the simulator's image head check matches the shared vectors (${vec.cases.length} cases)`, JSON.stringify(wrong));
}

const sim = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "admin", users, eventLines, latestLines });
sim.state.scanList = [{ ssid: XSS_SSID, bssid: "aa:bb:cc:dd:ee:ff", rssi: "-40" }];

// Minimal RFC 2617 client, used to probe /login the way an attacker would.
function httpPost(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
// The step-up headers for /update (plan 1.9 S1): a challenge from the device
// over a WebSocket of that session, answered with the admin password.
async function stepUpHeaders(port, token, password, action = "update") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: `http://127.0.0.1:${port}` });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const nonce = await new Promise((res) => {
    ws.on("message", (m) => { const o = JSON.parse(String(m)); if (o.command === "stepup") res(o.nonce); });
    ws.send(JSON.stringify({ command: "stepup" }));
  });
  ws.close();
  const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
  return { "X-Admin-Nonce": nonce, "X-Admin-Proof": md5(`${adminHa1(password)}:${token}:${nonce}:${action}`) };
}
function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function digestHeader(port, password) {
  const ch = await httpGet(port, "/login");
  const www = ch.headers["www-authenticate"] || "";
  const get = (k) => (new RegExp(`${k}="([^"]*)"`).exec(www) || [])[1];
  const md5 = (x) => crypto.createHash("md5").update(x).digest("hex");
  const nonce = get("nonce"), opaque = get("opaque"), realm = get("realm");
  const cnonce = crypto.randomBytes(8).toString("hex"), nc = "00000001";
  const resp = md5(`${md5(`admin:${realm}:${password}`)}:${nonce}:${nc}:${cnonce}:auth:${md5("GET:/login")}`);
  return `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="/login", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${resp}", opaque="${opaque}"`;
}
const base = `http://127.0.0.1:${sim.port}`;
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const cspViolations = []; // the UI must work under the firmware's Content-Security-Policy
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
  const frames = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  const dialogs = [];
  // the browser's own "leave the page?" (beforeunload, plan 1.9 C1) is not an
  // alert the page raised: counted apart
  const leavePrompts = [];
  page.on("dialog", (d) => { (d.type() === "beforeunload" ? leavePrompts : dialogs).push(d.message()); d.accept(); });

  // ---- branding --------------------------------------------------------
  console.log("branding");
  const indexResponse = await page.goto(base + "/");
  await waitOpen(page, "signin", 10000);
  {
    const csp = indexResponse.headers()["content-security-policy"] || "";
    check(csp.includes("script-src 'self'") && !/script-src[^;]*unsafe-inline/.test(csp) && csp.includes("frame-ancestors 'none'"),
      "the page is served with a Content-Security-Policy that runs no inline script", csp);
    // negative control: an injected handler and an injected script do not run
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.innerHTML = "<img src=\"/nothing-here\" onerror=\"window.__cspxss = 1\">";
      document.body.appendChild(d);
      const s = document.createElement("script");
      s.textContent = "window.__cspxss = 2";
      document.body.appendChild(s);
    });
    await page.waitForTimeout(500);
    check(await page.evaluate(() => window.__cspxss === undefined) && cspViolations.length >= 2,
      "an injected onerror= or inline <script> is blocked by the policy (negative control)", JSON.stringify(cspViolations));
    cspViolations.length = 0;
  }
  const brand = await page.evaluate(() => {
    const img = document.querySelector("#signin .login-brand img");
    const wm = document.querySelector("#signin .login-brand .if-wordmark");
    return {
      logoLoaded: !!img && img.complete && img.naturalWidth > 0,
      wordmark: wm ? wm.textContent.trim() : "",
      frameColor: wm ? getComputedStyle(wm.querySelector("span")).color : "",
      title: document.title,
      bodyBg: getComputedStyle(document.body).backgroundImage,
      favicon: document.querySelector("link[rel=icon]").getAttribute("href"),
    };
  });
  check(brand.logoLoaded, "Ironframe logo image loads (served from firmware asset)");
  check(brand.wordmark === "IRONFRAME", "wordmark reads IRONFRAME", brand.wordmark);
  check(brand.frameColor === "rgb(245, 158, 11)", "FRAME in brand amber #f59e0b", brand.frameColor);
  check(brand.title === "Ironframe RFID", "page title", brand.title);
  check(brand.bodyBg.includes("rgb(10, 25, 41)"), "Ironframe navy background", brand.bodyBg);
  check(brand.favicon === "favicon.svg", "Ironframe favicon");
  await settle(page); await page.screenshot({ path: path.join(shotDir, "01-login.png") });

  // ---- login + forced password change -----------------------------------
  console.log("login and default password");
  await page.fill("#password", "wrong-password");
  await page.click("#signin button[type=submit]");
  await page.waitForSelector("#loginerror", { state: "visible" });
  check((await page.textContent("#loginerror")).includes("Incorrect"), "wrong password rejected (digest auth)");
  await page.fill("#password", "admin");
  await page.click("#signin button[type=submit]");
  await waitOpen(page, "changepass", 10000);
  check(await page.isVisible("#changepassforced"), "factory password forces the change-password dialog");
  check(!(await page.isVisible("#changepassclose")), "forced dialog cannot be dismissed");
  // device refuses normal commands meanwhile
  const refused = await page.evaluate(() => new Promise((res) => {
    const h = (e) => { const o = JSON.parse(e.data); if (o.resultof === "userlist") { websock.removeEventListener("message", h); res(o); } };
    websock.addEventListener("message", h);
    websock.send(JSON.stringify({ command: "userlist", page: 1 }));
  }));
  check(refused.result === false, "device refuses commands until the password is changed");
  await page.fill("#newpass1", "short");
  await page.fill("#newpass2", "short");
  await page.click("#changepass button[type=submit]");
  await page.waitForTimeout(300);
  const shortBlocked = await page.evaluate(() => !document.getElementById("newpass1").validity.valid || isShown("changepasserror"));
  check(shortBlocked && sim.state.mustChange && sim.state.ha1 === adminHa1("admin"), "too-short password rejected in the UI");
  // bypass the browser's form validation: the device must refuse it too
  const devReply = await page.evaluate(() => new Promise((res) => {
    const h = (e) => { const o = JSON.parse(e.data); if (o.resultof === "setpassword") { websock.removeEventListener("message", h); res(o); } };
    websock.addEventListener("message", h);
    websock.send(passwordChangeMessage("short", adminHa1("admin")));
  }));
  check(devReply.result === false && sim.state.mustChange && sim.state.ha1 === adminHa1("admin"), "device refuses a too-short password");
  {
    const login = await httpGet(sim.port, "/login", { Authorization: await digestHeader(sim.port, "admin") });
    const tok = JSON.parse(login.body).token;
    const up = await httpPost(sim.port, `/update?token=${tok}`, "fake-image");
    check(up.status === 403, "firmware upload refused while the factory password is in force", up.status);
  }
  check(!(await page.isVisible("#currentpass")), "forced change asks for no current password");
  await page.fill("#newpass1", "Site-Door-2026");
  await page.fill("#newpass2", "Site-Door-2026");
  await settle(page); await page.screenshot({ path: path.join(shotDir, "02-change-password.png") });
  await Promise.all([page.waitForNavigation(), page.click("#changepass button[type=submit]")]);
  check(sim.state.ha1 === adminHa1("Site-Door-2026") && !sim.state.mustChange, "new password stored on the device");
  // review 6: neither password crosses the link, the forced change included
  check(sim.state.setpasswords.length > 0 && !JSON.stringify(sim.state.setpasswords).includes("Site-Door-2026") && !JSON.stringify(sim.state.setpasswords).includes("\"admin\""),
    "Change Password sends neither password in clear", JSON.stringify(sim.state.setpasswords.at(-1)));
  // only its Digest HA1 is stored (1.4.2); the factory "admin" the simulator
  // started with was stored in clear, as by 1.4.1, and hashed at start-up
  check(sim.state.migrations === 1 && sim.state.config.general.pswd === adminHa1("Site-Door-2026") && sim.state.config.general.pswdhash === 1 &&
    !("pswdchange" in sim.state.config.general) && !JSON.stringify(sim.state.config).includes("Site-Door-2026"),
    "the stored settings hold the password's digest hash, never the password", JSON.stringify(sim.state.config.general));
  check(sim.state.tokens.size === 0, "all sessions revoked after the password change");
  check(!sim.state.counts.settime, "no settime sent while the factory password is in force", JSON.stringify(sim.state.counts));

  await waitOpen(page, "signin", 10000);
  check(await page.isVisible("#loginnotice") && (await page.textContent("#loginnotice")).includes("Password changed"),
    "after a password change the sign-in dialog says so (it was a blocking alert)");
  await signIn(page, "Site-Door-2026");
  await page.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true, null, { timeout: 10000 });
  check(!(await page.isVisible("#changepass")) && !(await isOpen(page, "changepass")), "no password prompt once changed");

  // ---- status page --------------------------------------------------------
  console.log("clock");
  await nav(page, "status");
  await page.waitForTimeout(800);
  const sent = sim.state.settimes.at(-1);
  check(sim.state.settimes.length >= 1 && Math.abs(sent - Date.now() / 1000) < 60, "browser sets the device clock after login when it is not set", JSON.stringify(sim.state.settimes));
  check((await page.textContent("#clockstate")) === "Set", "Status shows the clock as set", await page.textContent("#clockstate"));
  {
    const w = await page.evaluate(() => document.getElementById("heapbar").style.width);
    check(Math.abs(parseFloat(w) - 100 * 150000 / 380000) < 0.5, "heap bar is scaled to the heap size the device reports", w);
  }
  {
    const n = sim.state.settimes.length;
    await nav(page, "status");
    await page.waitForTimeout(500);
    check(sim.state.settimes.length === n, "no further settime once the device has the time");
  }
  check(!(await page.isVisible("#apopenbanner")), "no open-hotspot warning while the hotspot has a password");
  sim.state.apOpen = true;
  await nav(page, "status");
  await page.waitForTimeout(500);
  check(await page.isVisible("#apopenbanner"), "Status warns that the hotspot has no password");
  {
    sim.state.resetReason = "brown-out (supply voltage dropped)";
    sim.state.crashDump = true;
    await nav(page, "status");
    await page.waitForTimeout(500);
    const why = await page.textContent("#ajaxcontent #resetreason");
    check(why === "brown-out (supply voltage dropped) (crash dump stored)", "Status shows why the board last restarted", why);
    sim.state.resetReason = undefined;
    sim.state.crashDump = false;
  }
  {
    // Wiegand noise counters, one line per running reader; no Wiegand reader: no row
    sim.state.wiegand = [{ reader: 1, glitches: 12, badframes: 3, parity: 1, overruns: 0 }, { reader: 2, glitches: 0, badframes: 0, parity: 0, overruns: 2 }];
    await nav(page, "status");
    await page.waitForTimeout(500);
    const noise = await page.$$eval("#ajaxcontent #wiegandnoise div", (els) => els.map((e) => e.textContent));
    check(noise.length === 2 && noise[0] === "Reader 1: 12 glitches, 3 bad frames, 1 parity errors, 0 frames lost" &&
      noise[1] === "Reader 2: 0 glitches, 0 bad frames, 0 parity errors, 2 frames lost", "Status shows each Wiegand reader's noise counters", JSON.stringify(noise));
    // a reader set to a door that does not exist says so (plan 1.9.1 C3)
    sim.state.wiegand[1].nodoor = true;
    await nav(page, "status");
    await page.waitForTimeout(500);
    const unbound = await page.$$eval("#ajaxcontent #wiegandnoise div", (els) => els.map((e) => e.textContent));
    check(unbound.length === 3 && unbound[2].startsWith("Reader 2: door out of range: it refuses every card"), "Status says a reader's door is out of range", JSON.stringify(unbound));
    sim.state.wiegand = [];
    await nav(page, "status");
    await page.waitForTimeout(500);
    check(!(await page.isVisible("#ajaxcontent #wiegandnoiserow")), "no Wiegand reader: no noise row");
    sim.state.wiegand = undefined;
  }
  {
    // the icons: no icon font any more, an inline SVG sprite (index.html):
    // every icon on the page names a symbol that exists, and is drawn
    const icons = await page.evaluate(() => {
      const uses = [...document.querySelectorAll("svg.icon use")];
      const missing = uses.map((u) => u.getAttribute("href")).filter((h) => !h || !document.querySelector(`symbol${h}`));
      const drawn = [...document.querySelectorAll("#sidebar svg.icon, #ajaxcontent svg.icon")].filter((s) => s.getBoundingClientRect().width >= 12);
      return { n: uses.length, missing, drawn: drawn.length, fontFiles: performance.getEntriesByType("resource").filter((r) => /woff|glyphicon/i.test(r.name)).length };
    });
    check(icons.n > 10 && icons.missing.length === 0 && icons.drawn > 5 && icons.fontFiles === 0, "icon font loads from woff2 alone (woff removed)", JSON.stringify(icons));
  }
  await page.click("#apopenbanner a");
  await page.waitForTimeout(800);
  check(await page.isVisible("#ajaxcontent #wmodeap"), "the warning links to the network page");
  sim.state.apOpen = false;
  await nav(page, "status");
  await page.waitForTimeout(500);
  await settle(page); await page.screenshot({ path: path.join(shotDir, "03-status.png") });

  // ---- event log: complete, no duplicates, fewer round trips ---------------
  console.log("event log");
  sim.state.counts = {};
  await nav(page, "eventlog");
  await page.waitForFunction(() => document.getElementById("loading-img") && document.getElementById("loading-img").style.display === "none" && data.length > 0, null, { timeout: 30000 });
  const ev = await page.evaluate(() => {
    const ids = data.map((l) => JSON.parse(l).data.split("-")[1]);
    return { n: data.length, uniq: new Set(ids).size, first: ids[0], last: ids[ids.length - 1], xss: window.__xss === 1 };
  });
  check(ev.n === 600, "event log: all 600 entries loaded", `got ${ev.n}`);
  check(await page.evaluate(() => [...document.querySelectorAll("#sidebar .navlink.active")].map((a) => a.id).join()) === "eventlog", "sidebar highlights the open page");
  check(ev.uniq === 600, "event log: no duplicate entries", `unique ${ev.uniq}`);
  check(ev.first === "0" && ev.last === "599", "event log: in order, nothing skipped");
  const evTrips = sim.state.counts.geteventlog || 0;
  check(evTrips === 12, "event log: 12 round-trips (upstream needed 60 at 10/page)", `got ${evTrips}`);
  await page.waitForFunction(() => document.querySelectorAll("#ajaxcontent tbody tr td").length > 5, null, { timeout: 10000 });
  const evRender = await page.evaluate(() => ({
    xss: window.__xss,
    img: !!document.querySelector('#ajaxcontent img[src="x"]'),
    shown: [...document.querySelectorAll("#ajaxcontent td")].some((td) => td.textContent.includes('<img src=x onerror="window.__xss=2">')),
  }));
  check(evRender.shown, "positive control: the hostile newest event is on the rendered page, as text");
  check(!evRender.img && evRender.xss === undefined, "event text is not executed as HTML (XSS)", JSON.stringify(evRender));
  await settle(page); await page.screenshot({ path: path.join(shotDir, "04-event-log.png") });

  // two concurrent readers (second tab) do not disturb each other
  console.log("concurrent readers");
  const page2 = await context.newPage();
  page2.on("dialog", (d) => d.accept());
  await page2.goto(base + "/");
  await signIn(page2, "Site-Door-2026"); // sessions are per tab
  await page2.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true, null, { timeout: 10000 });
  await page2.waitForSelector("#systemnamedevice:not(:empty)", { timeout: 10000 }); // the start page is in place
  await Promise.all([
    nav(page, "latestlog"),
    nav(page2, "eventlog"),
  ]);
  const doneCond = () => document.getElementById("loading-img") && document.getElementById("loading-img").style.display === "none" && data.length > 0;
  await page.waitForFunction(doneCond, null, { timeout: 30000 });
  await page2.waitForFunction(doneCond, null, { timeout: 30000 });
  const lat = await page.evaluate(() => ({ n: data.length, uniq: new Set(data).size }));
  const ev2 = await page2.evaluate(() => ({ n: data.length, uniq: new Set(data).size }));
  check(lat.n === 250 && lat.uniq === 250, "tab 1 access log complete while tab 2 reads the event log", JSON.stringify(lat));
  check(ev2.n === 600 && ev2.uniq === 600, "tab 2 event log complete while tab 1 reads the access log", JSON.stringify(ev2));
  await settle(page); await page.screenshot({ path: path.join(shotDir, "05-access-log.png") });
  await page2.close();

  // ---- users ----------------------------------------------------------------
  console.log("users");
  sim.state.counts = {};
  // the user list: rows (li[data-uid]) in #userlist, 25 a page, a search box,
  // and a <dialog> editor; every row of the device's list is in `data`
  const usersLoadedCond = () => typeof usersView !== "undefined" && usersView.loaded && document.getElementById("loading-img") &&
    document.getElementById("loading-img").style.display === "none" && data.length > 0;
  await nav(page, "users");
  try {
    await page.waitForFunction(usersLoadedCond, null, { timeout: 30000 });
  } catch (e) {
    console.log("  diag", JSON.stringify(await page.evaluate(() => ({ page, haspages, n: data.length, li: document.getElementById("loading-img") && document.getElementById("loading-img").style.display, pdr: pageDataReceived, banner: !!document.getElementById("usersbanner") }))), JSON.stringify(sim.state.counts), pageErrors);
    throw e;
  }
  const us = await page.evaluate(() => ({ n: data.length, uniq: new Set(data.map((u) => u.uid)).size }));
  check(us.n === 300 && us.uniq === 300, "user list: 300 users, no duplicates", JSON.stringify(us));
  // PINs never reach the page (review 6): only whether a user has one
  const pinLeak = await page.evaluate(() => data.filter((u) => "pincode" in u).length + " " + data.filter((u) => u.haspin === true).map((u) => u.uid).join(","));
  check(pinLeak === "0 a0000001", "the user list carries no PINs, only whether a user has one", pinLeak);
  await page.waitForFunction(() => document.querySelectorAll("#userlist li").length > 5, null, { timeout: 10000 });
  const usRender = await page.evaluate(() => ({
    xss: window.__xss,
    img: !!document.querySelector('#ajaxcontent img[src="x"]'),
    shown: [...document.querySelectorAll("#userlist li")].some((li) => li.textContent.includes("window.__xss=4")),
  }));
  check(usRender.shown && !usRender.img && usRender.xss === undefined, "user names render as text, not HTML (XSS)", JSON.stringify(usRender));
  check((sim.state.counts.userlist || 0) === 6, "user list: 6 round-trips (upstream needed 30)", `got ${sim.state.counts.userlist}`);
  await settle(page); await page.screenshot({ path: path.join(shotDir, "06-users.png") });

  // A card scanned while Users is open: the device broadcasts "piccscan".
  // 1.2.0 opened New User with the UID empty: FooTable runs addRow a tick
  // after the click (jQuery 3) and its form reset wiped what listSCAN filled.
  const piccscan = (m) => page.evaluate((x) => socketMessageListener({ data: JSON.stringify(x) }), m);
  const closeEditor = async (p = page) => {
    await p.click("#editor-modal .dlg-foot [data-close]");
    await waitClosed(p, "editor-modal");
  };
  await piccscan({ command: "piccscan", uid: "1a2b3c4d", type: "26", known: 0, reader: 1 });
  await waitOpen(page, "editor-modal");
  await page.waitForTimeout(300);
  const scanned = await page.evaluate(() => ({ uid: document.querySelector("#editor #uid").value, type: document.querySelector("#editor #picctype").value, title: document.getElementById("editor-title").textContent }));
  check(scanned.uid === "1a2b3c4d" && scanned.type === "26" && scanned.title === "New user", "an unknown card scanned on Users opens New User with its UID filled in", JSON.stringify(scanned));
  await settle(page); await page.screenshot({ path: path.join(shotDir, "06b-users-scanned.png") });
  await page.click("#editor-modal .dlg-head [data-close]");
  await waitClosed(page, "editor-modal")
    .catch(async (e) => { console.log("  diag", JSON.stringify(await page.evaluate(() => ({ open: document.getElementById("editor-modal").open })))); throw e; });
  await page.click("#newuserbtn");
  await waitOpen(page, "editor-modal");
  await page.waitForTimeout(300);
  const byHand = await page.evaluate(() => document.querySelector("#editor #uid").value);
  check(byHand === "", "New User by hand after a scan starts empty (the scanned UID is used once)", JSON.stringify(byHand));
  await closeEditor();
  // another text input ahead of the list's search box must not get the UID
  await page.evaluate(() => { const d = document.createElement("input"); d.type = "text"; d.id = "decoy"; document.getElementById("ajaxcontent").prepend(d); });
  await piccscan({ command: "piccscan", uid: "a0000005", type: "26", known: 1, acctype: 1, user: "Person 5", reader: 1 });
  await page.waitForTimeout(800);
  const found = await page.evaluate(() => [...document.querySelectorAll("#userlist li")].filter((li) => !li.closest("[hidden]")).map((li) => li.textContent));
  check(found.length === 1 && found[0].includes("a0000005"), "a known card scanned on Users filters the table to that user", JSON.stringify(found));
  check(await page.evaluate(() => { const v = document.getElementById("decoy").value; document.getElementById("decoy").remove(); return v === "" && document.getElementById("usersearch").value === "a0000005"; }), "the known-card search fills the table's own search box, not the first text input on the page");
  await page.fill("#usersearch", "");
  await page.waitForFunction(() => document.querySelectorAll("#userlist li").length === 25, null, { timeout: 5000 });

  // ---- user editor: validity dates are whole local days --------------------
  console.log("user editor");
  // search the user list as the page does for a scanned card (listSCAN)
  const userRows = (p = page) => p.evaluate(() => [...document.querySelectorAll("#userlist li")].filter((li) => !li.closest("[hidden]")).map((li) => li.textContent));
  const searchUsers = async (term, p = page) => {
    let shown = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await p.fill("#usersearch", term);
      await p.waitForTimeout(200);
      shown = await userRows(p);
      if (shown.length && shown.every((t) => t.includes(term))) return;
    }
    throw new Error(`search for ${term} shows ${JSON.stringify(shown).slice(0, 300)}`);
  };
  // Edit: tap the user's row; New: the New user button
  const openEdit = async (uid, p = page) => {
    await searchUsers(uid, p);
    await p.click(`#userlist li[data-uid="${uid}"]`);
    await waitOpen(p, "editor-modal");
  };
  const openNew = async (p = page) => {
    await p.click("#newuserbtn");
    await waitOpen(p, "editor-modal");
  };
  const editorOpen = (p = page) => isOpen(p, "editor-modal");
  // a keypad-only user (UID = PIN) needs 6 digits in the editor (plan 1.9 D4)
  {
    await openNew();
    const sentBefore = sim.state.userfiles.length;
    await page.fill("#uid", "7395");
    await page.fill("#username", "Keypad User");
    await page.fill("#pincode", "7395");
    await page.selectOption("#acctype", "1");
    await page.click("#editor button[type=submit]");
    await page.waitForTimeout(300);
    const err = await page.textContent("#editorerror");
    check(sim.state.userfiles.length === sentBefore && err.includes("at least 6 digits"), "a keypad-only user with a 4-digit PIN is refused in the editor, nothing sent", err);
    await page.click("#editor-modal .dlg-head [data-close]");
    await page.waitForTimeout(200);
  }
  // a new user needs the admin password as well (plan 1.9.1 B1, D1): with
  // none kept the editor asks once, then keeps it for the session
  {
    await page.evaluate(() => { signinHa1 = null; });
    const addUser = async (uid) => {
      await openNew();
      await page.fill("#uid", uid);
      await page.fill("#username", "Step " + uid);
      await page.selectOption("#acctype", "1");
      await page.click("#editor button[type=submit]");
      await page.waitForTimeout(300);
      return isOpen(page, "stepupdlg");
    };
    const askedFirst = await addUser("5e1f00a1");
    if (askedFirst) {
      await page.fill("#stepuppass", "Site-Door-2026");
      await page.click("#stepupdlg button[type=submit]");
    }
    await page.waitForFunction(() => !document.querySelector("#editor-modal[open]"), null, { timeout: 5000 }).catch(() => {});
    const firstStored = sim.state.users.some((u) => u.uid === "5e1f00a1");
    const askedSecond = await addUser("5e1f00a2");
    await page.waitForFunction(() => !document.querySelector("#editor-modal[open]"), null, { timeout: 5000 }).catch(() => {});
    const secondStored = sim.state.users.some((u) => u.uid === "5e1f00a2");
    check(askedFirst && firstStored && !askedSecond && secondStored, "a new user asks for the admin password once when the page holds none, then not again",
      JSON.stringify({ askedFirst, firstStored, askedSecond, secondStored }));
    sim.state.users = sim.state.users.filter((u) => !u.uid.startsWith("5e1f00a"));
    if (await editorOpen()) await closeEditor();
  }
  await openNew();
  await page.fill("#uid", "c0ffee01");
  await page.fill("#username", "Dated User");
  await page.fill("#validsince", "2026-03-01");
  await page.fill("#validuntil", "2026-03-19");
  await page.selectOption("#acctype", "1");
  await page.click("#editor button[type=submit]");
  await page.waitForTimeout(400);
  {
    const sent = sim.state.userfiles.at(-1) || {};
    const local = await page.evaluate(([vs, vu]) => {
      const f = (s) => { const d = new Date(s * 1000); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(","); };
      return { since: f(vs), until: f(vu), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }, [sent.validsince, sent.validuntil]);
    check(sent.uid === "c0ffee01" && local.until === "2026,3,19,23,59,59", "valid until = the end of the chosen day in local time", JSON.stringify(local));
    check(local.since === "2026,3,1,0,0,0", "valid since = the start of the chosen day in local time", JSON.stringify(local));
    // what the list shows: search for the user as listSCAN does for a known
    // card. The row names the last valid day (the dates are past: "Expired
    // 2026-03-19"); the editor opened from the row shows both chosen days.
    await searchUsers("c0ffee01");
    const row = await page.evaluate(() => {
      const li = document.querySelector('#userlist li[data-uid="c0ffee01"]');
      return li ? [...li.querySelectorAll(".badge")].map((b) => b.textContent).join(" | ") : "row not found";
    });
    await page.click('#userlist li[data-uid="c0ffee01"]');
    await waitOpen(page, "editor-modal");
    const days = await page.evaluate(() => document.getElementById("validsince").value + " " + document.getElementById("validuntil").value);
    await closeEditor();
    check(row.includes("2026-03-19") && days === "2026-03-01 2026-03-19", "the table shows the chosen dates", JSON.stringify({ row, days }));
  }
  {
    // Edit (same UID): the list stays
    await page.click('#userlist li[data-uid="c0ffee01"]');
    await waitOpen(page, "editor-modal");
    await page.fill("#username", "Dated User 2");
    await page.click("#editor button[type=submit]");
    await page.waitForTimeout(600);
    const t = await page.evaluate(() => ({ tables: document.querySelectorAll("#ajaxcontent #userlist").length, row: [...document.querySelectorAll("#userlist li")].some((li) => li.textContent.includes("Dated User 2")) }));
    check(t.tables === 1 && t.row, "editing a user keeps the user table on the page (it vanished until a reload)", JSON.stringify(t));
  }
  {
    // a New User after that Edit must not count as editing it
    const removesBefore = sim.state.removes.length;
    await openNew();
    await page.fill("#uid", "c0ffee03");
    await page.fill("#username", "Another User");
    await page.click("#editor button[type=submit]");
    await page.waitForTimeout(600);
    const uids = sim.state.users.map((u) => u.uid);
    check(uids.includes("c0ffee01") && uids.includes("c0ffee03") && sim.state.removes.length === removesBefore,
      "a New User after an Edit leaves the edited user alone", JSON.stringify(sim.state.removes.slice(removesBefore)));
    // Edit waits for the device, as Delete does
    const rowWith = (t) => page.evaluate((t) => [...document.querySelectorAll("#userlist li")].some((li) => li.textContent.includes(t)), t);
    sim.state.holdUserfile = true;
    await openEdit("c0ffee03");
    await page.fill("#username", "Renamed Later");
    await page.click("#editor button[type=submit]");
    await page.waitForTimeout(500);
    check((await rowWith("Another User")) && !(await rowWith("Renamed Later")) && (await editorOpen()),
      "Edit keeps the row as it was until the device confirms (it was replaced before the answer)");
    sim.state.holdUserfile = false;
    sim.state.heldUserfiles.splice(0).forEach((reply) => reply());
    await page.waitForTimeout(600);
    check((await rowWith("Renamed Later")) && !(await editorOpen()), "the row changes once the device confirms the edit");
    // no answer: the editor does not stay on "Saving..." (connection lost, or too long)
    {
      const stuck = async (then) => {
        sim.state.holdUserfile = true;
        await openEdit("c0ffee03");
        await page.fill("#username", "Never Answered");
        await page.click("#editor button[type=submit]");
        await page.waitForTimeout(300);
        const saving = await page.textContent("#editor button[type=submit]");
        await then();
        await page.waitForFunction(() => isShown("editorerror"), null, { timeout: 5000 }).catch(() => {});
        const r = await page.evaluate(() => {
          const b = document.querySelector("#editor button[type=submit]");
          return { btn: b.textContent, disabled: b.disabled, err: document.getElementById("editorerror").textContent, pending: pendingEdit !== null };
        });
        sim.state.holdUserfile = false;
        sim.state.heldUserfiles.splice(0); // never answered
        await closeEditor();
        return { saving, ...r };
      };
      const lost = await stuck(async () => { sim.dropSockets(); });
      check(lost.saving === "Saving..." && lost.btn === "Save changes" && !lost.disabled && !lost.pending && lost.err.includes("connection to the device was lost"),
        "a save whose connection drops stops Saving... and says the user may not be saved", JSON.stringify(lost));
      await page.waitForFunction(() => wsConnectionPresent === true, null, { timeout: 15000 });
      await page.evaluate(() => { USER_SAVE_TIMEOUT_MS = 800; });
      const slow = await stuck(async () => { await page.waitForTimeout(1200); });
      await page.evaluate(() => { USER_SAVE_TIMEOUT_MS = 15000; });
      check(slow.btn === "Save changes" && !slow.disabled && !slow.pending && slow.err.includes("did not answer"),
        "a save with no answer times out with a message", JSON.stringify(slow));
    }
    // a refused edit: the device's reason in the dialog, the list unchanged
    const removesBeforeRefusal = sim.state.removes.length;
    await openEdit("c0ffee03");
    {
      // the editor's own checks: a UID or PIN the device would refuse is
      // never sent (review 4)
      const sentBefore = sim.state.counts.userfile || 0;
      await page.fill("#uid", "not valid!");
      await page.click("#editor button[type=submit]");
      await page.waitForTimeout(300);
      check(await page.evaluate(() => document.querySelector("#uid").matches(":invalid")) && (sim.state.counts.userfile || 0) === sentBefore && (await editorOpen()),
        "a UID with other characters is refused by the editor and not sent");
      await page.fill("#uid", "C0FFEE03");
      check(await page.inputValue("#uid") === "c0ffee03", "a UID is lower-cased as it is typed (the device stores it so)", await page.inputValue("#uid"));
      for (const pin of ["12a4", "123"]) {
        await page.fill("#pincode", pin);
        await page.click("#editor button[type=submit]");
        await page.waitForTimeout(300);
        check(await page.evaluate(() => document.querySelector("#pincode").matches(":invalid")) && (sim.state.counts.userfile || 0) === sentBefore,
          `PIN "${pin}" is refused by the editor (4-12 digits) and not sent`);
      }
      await page.fill("#pincode", "");
    }
    {
      // a device refusal: its reason in the dialog, the user kept
      sim.state.refuseUserfile = "Failed to save user";
      await page.click("#editor button[type=submit]");
      await page.waitForSelector("#editorerror", { state: "visible", timeout: 5000 });
      check((await page.textContent("#editorerror")).includes("Failed to save user") && (await rowWith("c0ffee03")) && sim.state.removes.length === removesBeforeRefusal,
        "a refused edit shows the device's reason in the dialog and keeps the user", await page.textContent("#editorerror"));
    }
    await closeEditor();
    {
      // the device checks the record itself (review 4): a name too long for
      // the user list page is refused with its reason, and what it stores
      // has only the known keys, the uid in lower case
      await openEdit("c0ffee03");
      await page.fill("#username", "é".repeat(33));
      await page.click("#editor button[type=submit]");
      await page.waitForSelector("#editorerror", { state: "visible", timeout: 5000 });
      check((await page.textContent("#editorerror")).includes("User name is too long") && (await rowWith("Renamed Later")),
        "a name too long for the device is refused, with its reason in the dialog", await page.textContent("#editorerror"));
      await page.fill("#username", "Renamed Later");
      await page.click("#editor button[type=submit]");
      await page.waitForTimeout(600);
      const stored = sim.state.storedUsers.at(-1) || {};
      check(JSON.stringify(Object.keys(stored)) === JSON.stringify(["uid", "user", "pincode", "acctype", "acctype2", "acctype3", "acctype4", "validsince", "validuntil"]) && stored.uid === "c0ffee03",
        "the device stores the known keys only (no command)", JSON.stringify(stored));
    }
    {
      // a user with a PIN: the editor shows none; an empty PIN keeps it,
      // Remove PIN clears it (review 6: the page no longer gets PINs)
      const pinOf = () => (sim.state.users.find((x) => x.uid === "a0000001") || {}).pincode;
      const editPinUser = async (name, removePin) => {
        await openEdit("a0000001");
        const shown = await page.evaluate(() => ({ pin: document.getElementById("pincode").value, ph: document.getElementById("pincode").placeholder, remove: !document.getElementById("removepinrow").hidden && isVisible(document.getElementById("removepinrow")) }));
        if (removePin) await page.check("#removepin");
        await page.fill("#username", name);
        await page.click("#editor button[type=submit]");
        await waitClosed(page, "editor-modal");
        return shown;
      };
      const shown = await editPinUser("Pin Kept", false);
      check(shown.pin === "" && shown.ph.includes("PIN set") && shown.remove && sim.state.userfiles.at(-1).keeppin === 1 && pinOf() === "2468",
        "editing a user with a PIN shows no PIN, and an empty PIN keeps the stored one", JSON.stringify({ shown, sent: sim.state.userfiles.at(-1), pin: pinOf() }));
      await editPinUser("Pin Removed", true);
      check(!("keeppin" in sim.state.userfiles.at(-1)) && pinOf() === "",
        "Remove PIN clears a stored PIN", JSON.stringify({ sent: sim.state.userfiles.at(-1), pin: pinOf() }));
    }
    {
      // a new user with a UID that exists: the device refuses (create), the
      // editor warns, and only a second Save replaces that user (review 4)
      const nameOf = (u) => (sim.state.users.find((x) => x.uid === u) || {}).username;
      await openNew();
      await page.fill("#uid", "c0ffee01");
      await page.fill("#username", "Someone Else");
      await page.click("#editor button[type=submit]");
      await page.waitForSelector("#editorerror", { state: "visible", timeout: 5000 });
      check((await page.textContent("#editorerror")).includes("already belongs to another user") && nameOf("c0ffee01") === "Dated User 2" &&
        (await page.textContent("#editor button[type=submit]")) === "Replace user" && sim.state.refusedUserfiles.at(-1) === "exists",
        "New User with an existing UID is refused by the device and the editor warns before replacing", await page.textContent("#editorerror"));
      await page.fill("#username", "Dated User 2");
      await page.click("#editor button[type=submit]");
      await page.waitForTimeout(600);
      check(!(await editorOpen()) && sim.state.userfiles.at(-1).create === undefined && nameOf("c0ffee01") === "Dated User 2" &&
        sim.state.users.filter((u) => u.uid === "c0ffee01").length === 1,
        "a second Save after the warning replaces the user");
      // Edit with the UID changed to one that exists: warned, nothing removed
      const removesBeforeClash = sim.state.removes.length;
      await openEdit("c0ffee03");
      await page.fill("#uid", "c0ffee01");
      await page.click("#editor button[type=submit]");
      await page.waitForSelector("#editorerror", { state: "visible", timeout: 5000 });
      check((await page.textContent("#editorerror")).includes("already belongs to another user") && nameOf("c0ffee01") === "Dated User 2" &&
        nameOf("c0ffee03") === "Renamed Later" && sim.state.removes.length === removesBeforeClash,
        "changing a UID in Edit to one that exists is refused with a warning, both users kept");
      await page.fill("#uid", "c0ffee03");
      check(await page.isHidden("#editorerror") && (await page.textContent("#editor button[type=submit]")) === "Save changes", "changing the UID again clears the warning");
      await closeEditor();
    }
    // Edit with a changed UID: the record moves, the old one does not linger.
    // One userfile command with replaces: the editor used to send "remove"
    // after the save, so a dropped link left the old card valid (review 5)
    await openEdit("c0ffee01");
    await page.fill("#uid", "c0ffee02");
    {
      // the device cannot remove the old record: nothing changes, and the dialog says so
      sim.state.stuckUids = ["c0ffee01"];
      await page.click("#editor button[type=submit]");
      await page.waitForSelector("#editorerror", { state: "visible", timeout: 5000 });
      const uids = sim.state.users.map((u) => u.uid);
      check((await page.textContent("#editorerror")).includes("Could not remove the old UID") && uids.includes("c0ffee01") && !uids.includes("c0ffee02") &&
        (await editorOpen()) && sim.state.refusedUserfiles.at(-1) === "replace",
        "a UID change the device cannot complete changes nothing, and the editor says so", JSON.stringify(uids));
      sim.state.stuckUids = [];
    }
    const removeCount = sim.state.counts.remove || 0;
    await page.click("#editor button[type=submit]");
    await page.waitForTimeout(600);
    const after = sim.state.users.map((u) => u.uid);
    const renameSent = sim.state.userfiles.at(-1) || {};
    check(after.includes("c0ffee02") && !after.includes("c0ffee01") && renameSent.uid === "c0ffee02" && renameSent.replaces === "c0ffee01" &&
      sim.state.removes.length === removesBefore && (sim.state.counts.remove || 0) === removeCount,
      "changing a UID in Edit is one userfile command (replaces): new UID stored, old removed, no separate remove", JSON.stringify({ after, renameSent, removes: sim.state.removes.slice(removesBefore) }));
    check(!(await editorOpen()), "the editor closes once the device confirms the UID change");
    // Delete (in the user's editor): the row stays until the device confirms
    sim.state.holdRemove = true;
    await openEdit("c0ffee02");
    await page.click("#deleteuserbtn");
    await waitOpen(page, "confirmmodal");
    check((await page.textContent("#confirmtext")).includes("c0ffee02 (Dated User 2)"),
      "Delete asks in a dialog on the page, naming the user");
    await confirmYes(page);
    await page.waitForTimeout(400);
    const rowShown = () => page.evaluate(() => [...document.querySelectorAll("#userlist li")].some((li) => li.textContent.includes("c0ffee02")));
    check(sim.state.removes.at(-1) === "c0ffee02" && (await rowShown()), "Delete keeps the row until the device confirms");
    sim.state.holdRemove = false;
    sim.state.heldRemoves.splice(0).forEach((reply) => reply());
    await page.waitForTimeout(400);
    check(!(await rowShown()), "the row goes once the device confirms the removal");

    // Two tabs on Users. The device tells every tab about a removal; each
    // tab dropped its own pending row whoever had been removed, and kept
    // the removed user's row.
    const tab2 = await context.newPage();
    tab2.on("dialog", (d) => d.accept());
    await tab2.goto(base + "/");
    await signIn(tab2, "Site-Door-2026");
    await tab2.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true, null, { timeout: 10000 });
    await tab2.waitForSelector("#systemnamedevice:not(:empty)", { timeout: 10000 });
    await nav(tab2, "users");
    await tab2.waitForFunction(usersLoadedCond, null, { timeout: 30000 });
    // the users the list holds (all of them, not only the rows on screen)
    const uidsOf = (p) => p.evaluate(() => data.map((u) => u.uid));
    const deleteIn = async (p, uid) => {
      await openEdit(uid, p);
      await p.click("#deleteuserbtn");
      await confirmYes(p);
      // sent once the dialog has closed
      for (let i = 0; i < 50 && sim.state.removes.at(-1) !== uid; i++) await p.waitForTimeout(100);
    };
    // tab 1 removes a0000020, the device's answer held back
    sim.state.holdRemove = true;
    await deleteIn(page, "a0000020");
    // tab 2 removes a0000021, answered at once to both tabs
    sim.state.holdRemove = false;
    await deleteIn(tab2, "a0000021");
    await page.waitForTimeout(600);
    const mid1 = await uidsOf(page), mid2 = await uidsOf(tab2);
    check(!mid1.includes("a0000021") && mid1.includes("a0000020") && (await page.evaluate(() => pendingDelete !== null)),
      "a user removed in another tab leaves this tab's list; this tab's own delete still waits for its answer",
      JSON.stringify({ a20: mid1.includes("a0000020"), a21: mid1.includes("a0000021"), pending: await page.evaluate(() => pendingDelete && pendingDelete.value.uid) }));
    check(!mid2.includes("a0000021") && mid2.includes("a0000020"), "the tab that removed a user drops only that row",
      JSON.stringify({ a20: mid2.includes("a0000020"), a21: mid2.includes("a0000021") }));
    sim.state.heldRemoves.splice(0).forEach((reply) => reply());
    await page.waitForTimeout(600);
    const end1 = await uidsOf(page), end2 = await uidsOf(tab2);
    check(!end1.includes("a0000020") && !end2.includes("a0000020") && (await page.evaluate(() => pendingDelete === null)),
      "once the device confirms tab 1's removal, both tabs drop that row");
    await tab2.close();
  }

  // ---- secrets never reach the browser; saving keeps them ------------------
  console.log("secrets");
  const allFrames = frames.join("\n");
  check(!allFrames.includes("wifi-secret-123") && !allFrames.includes("mqtt-secret-456") && !allFrames.includes("Site-Door-2026"), "no stored password appears in any WebSocket frame");
  const cfg = await page.evaluate(() => ({ wifi: config.network.pswd, mqtt: config.mqtt.pswd, admin: config.general.pswd }));
  check(cfg.wifi === "********" && cfg.mqtt === "********" && cfg.admin === "********", "settings page receives masked secrets", JSON.stringify(cfg));
  // save a general-settings change without touching the password
  await nav(page, "general");
  // the UI clones each page <template> into #ajaxcontent
  await page.waitForSelector("#ajaxcontent #hostname", { state: "visible" });
  await page.waitForFunction(() => document.querySelector("#ajaxcontent #hostname").value === "ironframe-rfid", null, { timeout: 10000 });
  check(await page.locator("#ajaxcontent #adminpwd").count() === 0, "General page has no admin password field (Change Password only)");
  {
    // A fresh device has no saved config, so the UI still holds its built-in
    // "admin" default: saving General settings must not be blocked by it.
    const fresh = await page.evaluate(() => {
      const before = document.querySelectorAll("#msgarea .msgtext").length, saved = config.general.pswd;
      config.general.pswd = "admin";
      const realSend = window.sendWebsocket;
      window.sendWebsocket = () => {};
      try { savegeneral(); } finally { window.sendWebsocket = realSend; }
      const sent = config.general.pswd;
      config.general.pswd = saved;
      return { alerts: [...document.querySelectorAll("#msgarea .msgtext")].slice(before).map((m) => m.textContent), sent };
    });
    check(fresh.alerts.length === 0 && fresh.sent === "********", "General save on a fresh device is not blocked by the default password, and sends the mask", JSON.stringify(fresh));
  }
  check(await page.locator("#ajaxcontent #logging").count() === 0, "General page has no Logging control (it is under Logs)");
  await page.locator("#ajaxcontent #hostname").fill("front-door");
  await settle(page); await page.screenshot({ path: path.join(shotDir, "07-settings.png") });
  await page.evaluate(() => savegeneral());
  {
    // review: a plain list of what changed, one click handler however many edits
    // (the bar's handler calls reviewChanges, which builds the list with
    // configChanges once: count those)
    await page.evaluate(() => { window.__reviews = 0; window.__realChanges = configChanges; window.configChanges = (a, b) => { window.__reviews++; return window.__realChanges(a, b); }; markUnsaved(); markUnsaved(); });
    check((await page.textContent("#commit")).includes("Unsaved changes"), "the bar says Unsaved changes", await page.textContent("#commit"));
    await page.click("#commit");
    await waitOpen(page, "reviewmodal");
    const items = await page.$$eval("#changelist li", (li) => li.map((x) => x.textContent));
    check(items.length === 1 && items[0] === "General: Host Name: ironframe-rfid \u2192 front-door", "review lists the one change in plain words", JSON.stringify(items));
    check(!(await page.textContent("#reviewmodal .dlg-body")).includes("{"), "review shows no raw JSON");
    check(await page.evaluate(() => window.__reviews) === 1, "one click opens the review once (handler bound once)");
    check(!(await page.isVisible("#reviewcardwarn")), "no card-number warning when neither card setting changes");
    // a change of either card setting warns that enrolled cards stop
    // matching (2026-10-16); changed back, the warning goes
    const cardWarn = await page.evaluate(() => {
      const h = config.hardware, keep = { mode: h.useridstoragemode, parity: h.removeparitybits }, out = {};
      h.useridstoragemode = keep.mode === "decimal" ? "hexadecimal" : "decimal";
      reviewChanges();
      out.mode = !byId("reviewcardwarn").hidden && byId("reviewcardwarn").textContent;
      h.useridstoragemode = keep.mode;
      h.removeparitybits = !jsonInt(keep.parity, 1);
      reviewChanges();
      out.parity = !byId("reviewcardwarn").hidden && byId("reviewcardwarn").textContent;
      h.removeparitybits = keep.parity;
      reviewChanges();
      out.back = byId("reviewcardwarn").hidden;
      return out;
    });
    check(typeof cardWarn.mode === "string" && cardWarn.mode.includes("User ID storage mode") && cardWarn.mode.includes("enrolled again"),
      "the review warns that cards read as different numbers when User ID storage mode changes", JSON.stringify(cardWarn));
    check(typeof cardWarn.parity === "string" && cardWarn.parity.includes("Remove parity bits (on \u2192 off)"),
      "the review warns the same when Remove parity bits changes", JSON.stringify(cardWarn));
    check(cardWarn.back === true, "changed back, the warning goes");
    await page.evaluate(() => { window.configChanges = window.__realChanges; });
    await page.click("#reviewmodal .dlg-head [data-close]");
    await waitClosed(page, "reviewmodal");
  }
  await page.evaluate(() => withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}));
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 500));
  const saved = sim.state.savedConfigs.at(-1);
  check(saved && saved.general.hostnm === "front-door", "settings change saved", JSON.stringify(saved && saved.general));
  check(saved && saved.general.pswd === adminHa1("Site-Door-2026") && saved.network.pswd === "wifi-secret-123" && saved.mqtt.pswd === "mqtt-secret-456", "masked secrets kept on save (not overwritten with ********)");
  {
    // MQTT door control: off unless turned on (review 4 #2)
    await nav(page, "mqtt");
    await page.waitForSelector("#ajaxcontent input[name=mqttdoorcontrol]", { state: "attached", timeout: 10000 });
    await page.waitForTimeout(300);
    const off = await page.evaluate(() => document.querySelector("input[name=mqttdoorcontrol]:checked").value);
    check(off === "0", "MQTT door control shows Disabled by default", String(off));
    await pickRadio(page, "mqttdoorcontrol", "1");
    await page.evaluate(() => savemqtt());
    await page.evaluate(() => withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}));
    for (let i = 0; i < 20 && sim.state.savedConfigs.at(-1).mqtt.doorcontrol !== 1; i++) await page.waitForTimeout(100);
    check(sim.state.savedConfigs.at(-1).mqtt.doorcontrol === 1, "MQTT door control Enabled is saved as mqtt.doorcontrol 1", JSON.stringify(sim.state.savedConfigs.at(-1).mqtt));
    await pickRadio(page, "mqttdoorcontrol", "0");
    await page.evaluate(() => { savemqtt(); withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}); });
    for (let i = 0; i < 20 && sim.state.savedConfigs.at(-1).mqtt.doorcontrol !== 0; i++) await page.waitForTimeout(100);
    check(sim.state.savedConfigs.at(-1).mqtt.doorcontrol === 0, "and Disabled as 0");
    // card number in MQTT: settings without the key show Last 4 (the device's default)
    check(!("carduid" in sim.state.bootConfig.mqtt), "card number in MQTT: the simulated device's settings predate the key");
    const cuOld = await page.evaluate(() => { const c = JSON.parse(JSON.stringify(savedConfig)); delete c.mqtt.carduid; configReceived(c); return config.mqtt.carduid; });
    check(cuOld === 1, "settings saved before the key are read as Last 4", String(cuOld));
    const cu = await page.evaluate(() => document.getElementById("mqttcarduid").value);
    check(cu === "1", "card number in MQTT shows Last 4 when the stored settings do not have it", String(cu));
    await page.selectOption("#ajaxcontent #mqttcarduid", "2");
    const cuChanges = await page.evaluate(() => { savemqtt(); return configChanges(savedConfig, config); });
    check(cuChanges.filter((c) => c.includes("Card number")).join() === "MQTT: Card number in MQTT: Last 4 → Full", "the review names the card-number change by its label and options", JSON.stringify(cuChanges));
    await page.evaluate(() => withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}));
    for (let i = 0; i < 20 && sim.state.savedConfigs.at(-1).mqtt.carduid !== 2; i++) await page.waitForTimeout(100);
    check(sim.state.savedConfigs.at(-1).mqtt.carduid === 2, "card number Full is saved as mqtt.carduid 2", JSON.stringify(sim.state.savedConfigs.at(-1).mqtt));
    await page.selectOption("#ajaxcontent #mqttcarduid", "0");
    await page.evaluate(() => { savemqtt(); withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}); });
    for (let i = 0; i < 20 && sim.state.savedConfigs.at(-1).mqtt.carduid !== 0; i++) await page.waitForTimeout(100);
    check(sim.state.savedConfigs.at(-1).mqtt.carduid === 0, "and Off as 0");
    await nav(page, "general");
    await page.waitForTimeout(500);
  }

  // ---- Log Settings: the logging switch lives under Logs ---------------------
  console.log("help popovers");
  {
    // help is a button (class help) by its label; a tap shows its text in a
    // .helpbubble under it
    const bubbles = () => page.locator("#ajaxcontent .helpbubble").count();
    const icon = page.locator("#ajaxcontent button.help").first();
    await icon.click();
    await page.waitForTimeout(400);
    check(await bubbles() === 1, "a tap on a help icon shows its help (it needed hover, which phones lack)");
    await page.locator("#ajaxcontent .labelrow > label").first().click({ position: { x: 3, y: 5 } }); // the label text, not the icon
    await page.waitForTimeout(400);
    check(await bubbles() === 0, "a tap elsewhere hides it again");
    // without a mouse: the old hover-only icons could not be focused at all;
    // the help button takes the keyboard focus and Enter shows its help
    await page.evaluate(() => document.querySelector("#ajaxcontent button.help").focus());
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.matches("#ajaxcontent button.help"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    check(focused && await bubbles() === 1, "keyboard focus on a help icon shows its help (no hover needed)", String(focused));
    await page.keyboard.press("Enter"); // and hides it again
    await page.waitForTimeout(200);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(200);
  }

  console.log("phone layout");
  {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => {
      // a field's label line: the label, or its row with the help button (plan 1.9.1 D5)
      const label = [...document.querySelectorAll("#ajaxcontent .field > label, #ajaxcontent .field > .labelrow")].find((e) => e.getBoundingClientRect().width > 0);
      const row = label.closest(".field");
      const field = row.querySelector("input, select");
      return { label: label.getBoundingClientRect().width, row: row.getBoundingClientRect().width, labelTop: label.getBoundingClientRect().top, fieldTop: field ? field.getBoundingClientRect().top : 0 };
    });
    check(w.label > 0.9 * w.row - 30 && w.fieldTop > w.labelTop, "on a phone a label takes its own full-width line above its field (was a quarter of the width)", JSON.stringify(w));
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForTimeout(300);
  }

  console.log("page markup");
  {
    const pagesOf = ["network", "hardware", "general", "mqtt", "ntp"];
    const issues = [];
    const dups = [];
    for (const navId of [...pagesOf, "backup", "logmaintenance", "status"]) {
      await nav(page, navId);
      await page.waitForTimeout(700);
      dups.push(...await page.evaluate((n) => {
        const seen = {}, out = [];
        document.querySelectorAll("[id]").forEach((e) => { if (seen[e.id]) out.push(`${n}: #${e.id}`); seen[e.id] = true; });
        const radios = {};
        document.querySelectorAll("input[type=radio]").forEach((r) => { (radios[r.name] = radios[r.name] || new Set()).add(r.closest("form")); });
        Object.keys(radios).forEach((k) => { if (radios[k].size > 1) out.push(`${n}: radio group ${k} in two forms`); });
        return out;
      }, navId));
    }
    check(dups.length === 0, "every id exists once in the page and no radio group is split (a hidden copy of every page held them twice)", JSON.stringify(dups.slice(0, 6)));
    for (const navId of pagesOf) {
      await nav(page, navId);
      await page.waitForTimeout(700);
      issues.push(...await page.evaluate((n) => {
        const out = [];
        // each field's own label names it (for=), or wraps it
        document.querySelectorAll("#ajaxcontent .field > label").forEach((l) => {
          const row = l.closest(".field");
          const field = row.querySelector("input:not([type=radio]):not([type=hidden]), select, textarea");
          if (row.querySelector("input[type=radio]") || !field || !field.id) return;
          if (l.htmlFor !== field.id && !l.contains(field)) out.push(`${n}: label "${l.textContent.trim()}" not tied to #${field.id}`);
        });
        document.querySelectorAll("#ajaxcontent [aria-hidden=true]").forEach((e) => {
          if (e.tabIndex >= 0) out.push(`${n}: focusable element hidden from screen readers (${e.className})`);
        });
        document.querySelectorAll("#ajaxcontent button.help").forEach((b) => {
          if (b.closest("[aria-hidden=true]")) out.push(`${n}: help button hidden from screen readers`);
        });
        return out;
      }, navId));
    }
    check(issues.length === 0, "settings labels name their fields (for=) and focusable help icons are not aria-hidden", JSON.stringify(issues.slice(0, 5)));
    const hostOpts = await page.evaluate(() => [...document.querySelectorAll("#mastercontent template")].reduce((n, t) => n + [...t.content.querySelectorAll("option")].filter((o) => /^GPIO-/.test(o.textContent)).length, 0));
    check(hostOpts === 0, "the page templates carry no built-in pin lists (menus come from the device)", String(hostOpts));
    await page.setViewportSize({ width: 390, height: 844 });
    await nav(page, "general");
    await page.waitForTimeout(700);
    const wide = await page.evaluate(() => {
      const g = document.getElementById("openinghours");
      let box = g, scrolls = false;
      for (; box && box !== document.body; box = box.parentElement) if (/auto|scroll/.test(getComputedStyle(box).overflowX)) { scrolls = true; break; }
      return { page: document.documentElement.scrollWidth, view: window.innerWidth, grid: g.getBoundingClientRect().width > 0 && (scrolls || g.scrollWidth <= g.clientWidth + 1) };
    });
    check(wide.grid && wide.page <= wide.view, "on a phone the opening-hours grid scrolls in its own box, not the page", JSON.stringify(wide));
    await page.setViewportSize({ width: 1280, height: 860 });
    await nav(page, "status");
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => ({ cpu: document.getElementById("cpu").textContent, name: document.getElementById("systemnamedevice").textContent, side: document.getElementById("systemname").textContent, host: ajaxobj.hostname }));
    check(st.cpu.endsWith(" MHz") && st.name === st.host && st.side === st.host && st.host !== "", "Status spells MHz and System name", JSON.stringify(st));
    await nav(page, "general");
    await page.waitForTimeout(700);
  }

  console.log("swipe");
  {
    const r = await page.evaluate(() => ({
      tableScroll: swipeAction(200, 300, 120, 305, false),   // sideways scroll mid-page
      tiny: swipeAction(10, 300, 14, 300, false),            // first pixels of a move
      edgeOpen: swipeAction(10, 300, 90, 310, false),
      openAgain: swipeAction(10, 300, 90, 310, true),
      close: swipeAction(250, 300, 150, 300, true),
      vertical: swipeAction(10, 300, 70, 420, false),
    }));
    check(r.tableScroll === null && r.tiny === null && r.vertical === null, "sideways scrolling in the page does not open the menu", JSON.stringify(r));
    check(r.edgeOpen === "open" && r.openAgain === null && r.close === "close", "a swipe from the left edge opens it, a left swipe closes it", JSON.stringify(r));
  }

  console.log("relay time");
  await nav(page, "hardware");
  await page.waitForSelector("#ajaxcontent #numrlys");
  {
    const dialogsBefore = dialogs.length;
    await page.click("#ajaxcontent #testb");
    await waitOpen(page, "confirmmodal"); // a real door: asked first (plan 1.9.1 D3)
    await page.click("#confirmok");
    await page.waitForTimeout(400);
    check(JSON.stringify(sim.state.relayTests) === JSON.stringify([{ relay: 1, pin: 21 }]) && dialogs.length === dialogsBefore,
      "Test drives relay 1 on its configured pin", JSON.stringify(sim.state.relayTests));
    check((await msgs(page)).some((m) => m.startsWith("Relay 1 fired")), "Test says the relay was fired (it gave no feedback)", JSON.stringify(await msgs(page)));
  }
  {
    // the review names a change by its field label and option text, not its config key
    await page.selectOption("#ajaxcontent #typerly", "0");
    await page.selectOption("#ajaxcontent #r1ledpin", "4");
    await page.selectOption("#ajaxcontent #wg0pin", "1");
    await page.evaluate(() => savehardware());
    await page.click("#commit");
    await waitOpen(page, "reviewmodal");
    const items = await page.$$eval("#changelist li", (li) => li.map((x) => x.textContent));
    const want = ["Hardware: Relay type (relay 1): Active High \u2192 Active Low", "Hardware: Reader 1 LED line: (not set) \u2192 GPIO 4", "Hardware: Reader 1 D0: GPIO 4 \u2192 GPIO 1"];
    check(want.every((w) => items.includes(w)) && !items.some((t) => /rtype|ledpin|wgd0pin|reader1\./.test(t)),
      "the review uses the form labels and option names (it showed raw keys like reader1.ledpin)", JSON.stringify(items));
    await page.click("#reviewmodal .dlg-head [data-close]");
    await waitClosed(page, "reviewmodal");
  }
  await page.selectOption("#ajaxcontent #numrlys", "2");
  await page.waitForSelector("#ajaxcontent #delay2", { state: "attached" });
  {
    const d2 = await page.evaluate(() => ({ v: document.querySelector("#ajaxcontent #delay2").value, min: document.querySelector("#ajaxcontent #delay2").min, max: document.querySelector("#ajaxcontent #delay2").max }));
    check(d2.v === "3000" && d2.min === "100" && d2.max === "30000", "a newly added relay starts at 3000 ms, limited to 100-30000 ms (was 300)", JSON.stringify(d2));
    const p2 = await page.evaluate(() => ({ pin: document.querySelector("#ajaxcontent #gpiorly2").value, title: document.querySelector("#ajaxcontent #relaytitle2").textContent === "Door 2" }));
    check(p2.pin === "255" && p2.title, "a newly added relay has no pin until one is chosen (was GPIO 4, Wiegand D0's pin)", JSON.stringify(p2));
  }
  await page.selectOption("#ajaxcontent #numrlys", "1");

  console.log("log settings");
  {
    // no footer element any more: nothing the page shows names upstream
    const shown = await page.evaluate(() => document.body.innerText);
    check(!shown.includes("esp-rfid") && (await page.locator("footer").count()) === 0, "no upstream footer line on the page");
  }
  check(await page.locator("#commit").isVisible() && (await page.textContent("#commit")).includes("Unsaved changes"), "unsaved-changes bar still appears after a settings change");
  check((await page.textContent("#logmaintenance")).trim() === "Log Settings", "Logs menu has a Log Settings page", await page.textContent("#logmaintenance"));
  const savesBefore = sim.state.savedConfigs.length;
  await navAsk(page, "logmaintenance");
  // the Doors & Readers page was changed above (number of doors) and not
  // saved: leaving asks first (plan 1.9 C1); Leave goes on without them
  await page.waitForTimeout(200);
  check(await isOpen(page, "leavedlg"), "leaving a settings page with edits not saved asks first");
  await page.click("#leavedlg [data-onclick=leaveGo]");
  await page.waitForSelector("#ajaxcontent #logging", { state: "attached" });
  // the logging switch: a checkbox whose value is "1" or "0"
  check(await page.evaluate(() => { const b = document.querySelector("#ajaxcontent #logging"); return b.checked && b.value === "1"; }), "logging shows Enabled for a config saved before the setting existed");
  await page.click("#ajaxcontent label.switch[for=logging]");
  await page.waitForSelector("#ajaxcontent #loggingsaved", { state: "visible", timeout: 5000 });
  await settle(page); await page.screenshot({ path: path.join(shotDir, "07b-log-settings.png") });
  check(sim.state.config.general.logging === 0 && (sim.state.loggingChanges || []).join() === "0", "logging switched off from Logs is stored on the device as the number 0", JSON.stringify(sim.state.loggingChanges));
  check(sim.state.savedConfigs.length === savesBefore, "switching logging needs no full settings save (no restart)");
  check(await page.evaluate(() => config.general.logging) === 0, "page remembers the new logging state");
  check(await page.evaluate(() => savedConfig && savedConfig.general.logging) === 0, "and as saved: a later review does not list it as an unsaved change (review 7)");

  // Status: the doors and the last card for the owner (plan 1.9 C3)
  {
    sim.state.lastAccess = { uid: "04a1b2c3", name: "Alice", door: "Front door", granted: true, time: 1792398711 };
    sim.state.doorsOpen = [0];
    await page.evaluate(() => openMenuPage("status"));
    await page.waitForSelector("#ajaxcontent #doorlist li", { state: "attached", timeout: 5000 }).catch(() => {});
    const st = await page.evaluate(() => ({
      setup: !document.getElementById("setupcard").hidden,
      doors: [...document.querySelectorAll("#ajaxcontent #doorlist li")].map((li) => li.textContent),
      last: document.getElementById("lastaccess").textContent,
    }));
    check(!st.setup && st.doors.length >= 1 && /Locked/.test(st.doors[0]) && st.last.includes("Alice") && st.last.includes("let in"),
      "Status shows each door locked or not, and the last card", JSON.stringify(st));
    sim.state.lastAccess = null;
    sim.state.doorsOpen = [];
  }
  // the phone's Back button goes back a page (plan 1.9 C4)
  {
    await nav(page, "users");
    await page.waitForTimeout(400);
    await nav(page, "ntp");
    await page.waitForSelector("#ajaxcontent #ntpserver", { state: "attached" });
    await page.goBack();
    await page.waitForTimeout(500);
    const back = await page.evaluate(() => ({ page: currentPage, hash: location.hash, users: !!document.querySelector("#ajaxcontent #userlist, #ajaxcontent #newuserbtn") }));
    check(back.page === "users" && back.hash === "#users" && back.users, "Back returns to the page before (it left the app)", JSON.stringify(back));
  }
  // a reload with settings staged and not saved: the browser asks first (C1)
  {
    const before = leavePrompts.length;
    await page.evaluate(() => markUnsaved());
    await page.reload().catch(() => {});
    await page.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    check(leavePrompts.length === before + 1, "a reload with unsaved settings gets the browser's leave warning", leavePrompts.length - before);
    // a reload keeps the session but not the password's hash (memory only):
    // the next step-up would ask; set it as a sign-in would
    check(await page.evaluate(() => signinHa1 === null), "after a reload the page holds no password hash");
    await page.evaluate(() => { signinHa1 = adminHa1("Site-Door-2026"); });
  }
  // ---- WiFi scan results are text --------------------------------------------
  console.log("wifi scan");
  await nav(page, "network");
  await page.waitForSelector("#ajaxcontent #scanb", { state: "visible" });
  // the scan results: a list of buttons (#ssid li button), strongest first
  await page.click("#ajaxcontent #scanb");
  await page.waitForFunction(() => document.querySelectorAll("#ajaxcontent #ssid li").length > 0, null, { timeout: 5000 });
  const scan = await page.evaluate(() => ({ xss: window.__xss, img: !!document.querySelector('#ajaxcontent img[src="x"]'), text: document.querySelector("#ajaxcontent #ssid li .title").textContent }));
  check(scan.text.includes("window.__xss=3") && !scan.img && scan.xss === undefined, "scanned SSIDs render as text, not HTML (XSS)", JSON.stringify(scan));
  {
    // choosing a scanned network does not lock the device to that access
    // point: the scan used to fill the BSSID unseen, and the firmware then
    // joined only that one (review 5). Locking is the visible box, off.
    const scanListBefore = sim.state.scanList;
    sim.state.scanList = [{ ssid: "site-wifi", bssid: "11:22:33:44:55:66", rssi: "-50" }, { ssid: "site-wifi", bssid: "11:22:33:44:55:77", rssi: "-70" }];
    await page.click("#ajaxcontent #scanb");
    await page.waitForFunction(() => document.querySelectorAll("#ajaxcontent #ssid li").length === 2, null, { timeout: 5000 });
    await page.click("#ajaxcontent #ssid li:nth-child(2) button"); // the weaker one: ...:77
    const ui = await page.evaluate(() => ({ lock: document.getElementById("bssidlock").checked, lockShown: isVisible(document.querySelector("label[for=bssidlock]")) && !document.getElementById("bssidlock").closest("[hidden]"), bssidShown: isVisible(document.getElementById("wifibssid")), bssid: document.getElementById("wifibssid").value }));
    check(!ui.lock && ui.lockShown && !ui.bssidShown && ui.bssid === "", "Lock to this access point is shown, off, and a scanned network does not fill the BSSID", JSON.stringify(ui));
    const saveNetwork = async () => {
      const n = sim.state.savedConfigs.length;
      await page.evaluate(() => { savenetwork(); withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}); });
      for (let i = 0; i < 20 && sim.state.savedConfigs.length === n; i++) await page.waitForTimeout(100);
      return sim.state.savedConfigs.at(-1).network;
    };
    let net = await saveNetwork();
    check(net.ssid === "site-wifi" && net.bssid === "", "choosing a scanned network saves an empty BSSID (any access point of the network)", JSON.stringify(net));
    await page.check("#ajaxcontent #bssidlock");
    const locked = await page.evaluate(() => ({ bssidShown: isVisible(document.getElementById("wifibssid")), bssid: document.getElementById("wifibssid").value }));
    check(locked.bssidShown && locked.bssid === "11:22:33:44:55:77", "ticking the box shows the BSSID, filled from the chosen scanned network", JSON.stringify(locked));
    net = await saveNetwork();
    check(net.bssid === "11:22:33:44:55:77", "with the box ticked the BSSID is saved", JSON.stringify(net));
    await page.uncheck("#ajaxcontent #bssidlock");
    net = await saveNetwork();
    check(net.bssid === "" && !(await page.isVisible("#ajaxcontent #wifibssid")), "unticking it saves an empty BSSID again", JSON.stringify(net));
    // the fallback hotspot is never open (review 6): fallback mode needs its own password
    const savesBefore = sim.state.savedConfigs.length;
    await pickRadio(page, "fallbackmode", "1");
    await page.fill("#ajaxcontent #fallbackpass", "");
    await page.evaluate(() => savenetwork());
    const refused = { msgs: await msgs(page), staged: await page.evaluate(() => config.network.fallbackmode) };
    check(refused.msgs.some((m) => m.includes("fallback hotspot password of 8-63 characters")) && refused.staged !== 1,
      "fallback mode with no fallback hotspot password is not staged", JSON.stringify(refused));
    await page.fill("#ajaxcontent #fallbackpass", "Hotspot-2026");
    net = await saveNetwork();
    check(net.fallbackmode === 1 && net.fallbackpswd === "Hotspot-2026" && sim.state.savedConfigs.length > savesBefore,
      "with a fallback hotspot password it is saved", JSON.stringify(net));
    await pickRadio(page, "fallbackmode", "0");
    net = await saveNetwork();
    // Wi-Fi idle-off (opt-in, 2026-10-17): a tick box and its minutes;
    // it replaces WiFi Timeout (seconds of router time, never a hotspot)
    const idle0 = await page.evaluate(() => ({ ticked: document.getElementById("idleoff").checked, minsShown: isVisible(document.getElementById("idlemins")),
      mins: document.getElementById("idlemins").value, old: !!document.getElementById("disable_wifi_after_seconds") }));
    check(!idle0.ticked && !idle0.minsShown && idle0.mins === "15" && !idle0.old,
      "Turn Wi-Fi off when nobody is connected: unticked by default with 15 min, the old WiFi Timeout menu is gone", JSON.stringify(idle0));
    await page.check("#ajaxcontent #idleoff");
    const idleShown = await page.evaluate(() => ({ minsShown: isVisible(document.getElementById("idlemins")), note: document.getElementById("idleoffnote").textContent }));
    check(idleShown.minsShown && /MQTT \(Home Assistant\) and NTP time stop/.test(idleShown.note) && /scan an admin card or switch the reader off and on/.test(idleShown.note),
      "ticking it shows the minutes, what stops while Wi-Fi is off and how to turn it back on", JSON.stringify(idleShown));
    for (const bad of ["0", "1441", ""]) {
      await page.fill("#ajaxcontent #idlemins", bad);
      await page.evaluate(() => savenetwork());
      const r = { msgs: await msgs(page), staged: await page.evaluate(() => config.network.idleoff) };
      check(r.msgs.some((m) => m.includes("Turn Wi-Fi off after must be 1-1440 minutes")) && r.staged !== 1, `idle-off with "${bad}" minutes is not staged`, JSON.stringify(r));
    }
    await page.fill("#ajaxcontent #idlemins", "20");
    net = await saveNetwork();
    check(net.idleoff === 1 && net.idlemins === 20 && !("offtime" in net), "ticked with 20 min it is saved as idleoff 1, idlemins 20 (no offtime)", JSON.stringify(net));
    const idleReview = await page.evaluate(() => configChanges({ network: { idleoff: 0, idlemins: 15, offtime: 600 } }, { network: { idleoff: 1, idlemins: 20 } }));
    check(idleReview.includes("Wireless Network: Turn Wi-Fi off when nobody is connected: off → on") && idleReview.includes("Wireless Network: Turn Wi-Fi off after: 15 → 20") &&
      idleReview.some((t) => t.startsWith("Wireless Network: WiFi Timeout (replaced")), "the review names the idle-off changes by their labels", JSON.stringify(idleReview));
    check(await page.evaluate(() => !settingsNeedRestart({ network: { idleoff: 0, idlemins: 15 } }, { network: { idleoff: 1, idlemins: 20 } })), "idle-off is saved without a restart");
    await page.uncheck("#ajaxcontent #idleoff");
    check(!(await page.isVisible("#ajaxcontent #idlemins")), "unticked, the minutes are hidden");
    net = await saveNetwork();
    check(net.idleoff === 0 && net.idlemins === 20, "unticking it saves idleoff 0 and keeps the minutes", JSON.stringify(net));
    // Hotspot mode does not read the DHCP radios: a save there keeps DHCP as
    // saved (it wrote 0, a restart, and a fixed address on a later switch to
    // Client; bench run, ledger H25)
    await pickRadio(page, "wmode", "1");
    net = await saveNetwork();
    check(net.wmode === 1 && net.dhcp === 1, "a Save in Hotspot mode keeps DHCP on", JSON.stringify(net));
    await pickRadio(page, "wmode", "0");
    net = await saveNetwork();
    check(net.wmode === 0 && net.dhcp === 1, "back in Client mode DHCP is still on", JSON.stringify(net));
    sim.state.scanList = scanListBefore;
  }

  // a maglock on NO (relay on = locked) unlocks while the reader restarts:
  // every place a restart starts says so; Test asks first (review 8 V8,
  // plan 1.9.1 D3)
  {
    const texts = async () => page.evaluate(() => {
      const out = {};
      savedConfig.hardware.rpin = 16;
      out.restart = (function() { restartESP(); const t = document.getElementById("confirmtext").textContent; closeDialog("confirmmodal"); return t; })();
      openUpdate();
      out.update = document.getElementById("updatemaglock").hidden ? "" : document.getElementById("updatemaglock").textContent;
      closeDialog("update");
      out.warning = maglockRestartWarning();
      return out;
    });
    const hold0 = await page.evaluate(() => { const was = JSON.stringify(savedConfig.hardware); savedConfig.hardware.rhold = 0; return was; });
    const off = await texts();
    await page.evaluate(() => { savedConfig.hardware.rhold = 1; });
    const on = await texts();
    check(off.warning === "" && off.update === "" && !off.restart.includes("unlocked") && !off.restart.includes("do not respond"),
      "no maglock on NO: no unlock warning, and Restart no longer says the doors do not respond", JSON.stringify(off));
    check(on.warning.startsWith("Door 1 is held locked by its relay: it will be unlocked") && on.restart.includes(on.warning) && on.update === on.warning,
      "a maglock on NO: Restart and Update say the door unlocks while the reader restarts", JSON.stringify(on));
    await nav(page, "general");
    await page.waitForTimeout(400);
    const autoHint = await page.evaluate(() => { const e = document.getElementById("autorestartmaglock"); return e && !e.hidden ? e.textContent : ""; });
    check(autoHint === on.warning, "the Auto Restart field says it too", autoHint);
    // Test asks first; Cancel fires nothing, OK fires the relay
    const before = sim.state.counts.testrelay1 || 0;
    const asked = await page.evaluate(() => { savedConfig.hardware.rtime = 3000; savedConfig.hardware.ltype = 0; testRelay(1); return document.getElementById("confirmmodal").open ? document.getElementById("confirmtext").textContent : ""; });
    await page.evaluate(() => closeDialog("confirmmodal"));
    await page.waitForTimeout(300);
    const afterCancel = sim.state.counts.testrelay1 || 0;
    await page.evaluate(() => testRelay(1));
    await page.click("#confirmok");
    await page.waitForTimeout(500);
    check(asked.startsWith("Unlock ") && asked.includes(" for 3 s? The real lock will release.") && afterCancel === before,
      "Test asks before it unlocks a real door, and Cancel fires nothing", JSON.stringify({ asked, before, afterCancel }));
    check((sim.state.counts.testrelay1 || 0) === before + 1, "confirmed, Test goes to the reader", String((sim.state.counts.testrelay1 || 0) - before));
    await page.evaluate((was) => { savedConfig.hardware = JSON.parse(was); }, hold0);
    await nav(page, "status");
  }

  // the opening-hours grid fires click, not input: an hour, All day,
  // Closed or a copy still counts as an edit, and leaving asks first
  // (review 8 V12, plan 1.9.1 D4)
  {
    const asks = [];
    for (const act of ["hour", "allday", "closed", "copy"]) {
      await nav(page, "general");
      await page.waitForSelector("#ajaxcontent #openinghours .set-hour");
      if (act === "hour") await page.click("#ajaxcontent #openinghours .set-day:nth-child(2) .set-hour:nth-child(3)");
      if (act === "allday") await page.click("#ajaxcontent #openinghours .set-day:nth-child(3) [data-day-set=open]");
      if (act === "closed") await page.click("#ajaxcontent #openinghours .set-day:nth-child(4) [data-day-set=closed]");
      if (act === "copy") await page.evaluate(() => copyMonday("weekdays"));
      await navAsk(page, "users");
      const asked = await leaveIfAsked(page);
      asks.push(act + ":" + asked);
    }
    check(asks.every((a) => a.endsWith(":true")), "an opening-hours edit (hour, All day, Closed, copy) asks before leaving the page", JSON.stringify(asks));
    await nav(page, "status");
  }

  // ---- plan 1.9.1 D5: the small page fixes --------------------------------
  {
    // help buttons sit beside their labels, not inside, each naming its label
    await nav(page, "hardware");
    await page.waitForSelector("#ajaxcontent #numrlys");
    const help = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#ajaxcontent button.help")];
      return { n: all.length, inLabel: all.filter((b) => b.closest("label")).length,
        named: all.filter((b) => { const id = b.getAttribute("aria-describedby"); return id && document.getElementById(id); }).length };
    });
    check(help.n > 10 && help.inLabel === 0 && help.named === help.n, "no help button inside a label; each one's aria-describedby names its label", JSON.stringify(help));
    // Save means the same on every page, said under its button
    const hints = [];
    for (const p of ["general", "network", "mqtt", "ntp", "hardware"]) {
      await nav(page, p);
      await page.waitForSelector(`#ajaxcontent [data-onclick="savePage"]`);
      hints.push(await page.evaluate(() => { const b = document.querySelector('#ajaxcontent [data-onclick="savePage"]'); const h = b.parentElement.querySelector("p"); return h ? h.textContent : ""; }));
    }
    check(hints.every((h) => h === "Save shows what changes for you to confirm; nothing is stored on the reader until you do."), "every settings page says what Save does, in the same words", JSON.stringify(hints));
    // the time zone list has Europe/London, offered from this browser's zone
    await nav(page, "ntp");
    await page.waitForSelector("#ajaxcontent #DropDownTimezone");
    const zone = await page.evaluate(() => {
      const o = zoneOptionFor("Europe/London"), d = zoneOptionFor("Europe/Dublin"), x = zoneOptionFor("Mars/Olympus");
      return { london: o && o.textContent, dublin: d && d.textContent, none: x, western: [...document.querySelectorAll("#DropDownTimezone option")].some((e) => e.textContent === "Europe/Western") };
    });
    check(zone.london === "Europe/London (UK, Ireland, Portugal)" && zone.dublin === zone.london && zone.none === null && !zone.western, "the time zone list names Europe/London and finds it from the browser's zone", JSON.stringify(zone));
    // the factory reset is confirmed with the name the reader runs with, not a staged one
    await nav(page, "backup");
    const destroy = await page.evaluate(() => {
      const staged = config.general.hostnm;
      config.general.hostnm = "staged-new-name";
      const out = {};
      byId("compare").value = "staged-new-name"; compareDestroy(); out.staged = byId("destroybtn").disabled;
      byId("compare").value = ajaxobj.hostname; compareDestroy(); out.running = byId("destroybtn").disabled;
      byId("compare").value = ""; compareDestroy();
      config.general.hostnm = staged;
      return out;
    });
    check(destroy.staged === true && destroy.running === false, "the factory reset asks for the host name the reader runs with, not the staged one", JSON.stringify(destroy));
    // a cancelled step-up closes the progress dialog quietly
    await page.evaluate(() => { clearMessages(); signinHa1 = null; inProgress("restart"); });
    await waitOpen(page, "stepupdlg");
    await page.click("#stepupdlg [data-onclick=stepUpCancel]");
    await page.waitForTimeout(400);
    const cancel = await page.evaluate(() => ({ progress: !!document.querySelector("#progressmodal[open]"), msgs: [...document.querySelectorAll("#msgarea .toast")].map((m) => m.className + ": " + m.textContent) }));
    check(!cancel.progress && cancel.msgs.some((m) => m.includes("Cancelled") && !/danger/.test(m)), "a cancelled step-up closes the progress dialog and says so quietly", JSON.stringify(cancel));
    await page.evaluate(() => { signinHa1 = adminHa1("Site-Door-2026"); });
    // the user editor does not close on Escape or a backdrop tap once typed in
    await nav(page, "users");
    await page.click("#newuserbtn");
    await waitOpen(page, "editor-modal");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const cleanCloses = !(await isOpen(page, "editor-modal"));
    await page.click("#newuserbtn");
    await waitOpen(page, "editor-modal");
    await page.fill("#username", "Half typed");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5); // the backdrop
    await page.waitForTimeout(200);
    const dirtyStays = await isOpen(page, "editor-modal");
    await page.click("#editor-modal .dlg-head [data-close]");
    await page.waitForTimeout(200);
    check(cleanCloses && dirtyStays && !(await isOpen(page, "editor-modal")), "the user editor closes on Escape while empty, stays open once typed in, closes with its button", JSON.stringify({ cleanCloses, dirtyStays }));
    await nav(page, "status");
  }

  // a granted card is not a Test: no "relay fired" toast for it (an old
  // reader's bare giveAccess is ignored); Test's reply still shows one
  // (review 8 V7, plan 1.9.1 D2)
  {
    await page.evaluate(() => clearMessages());
    sim.broadcast(JSON.stringify({ command: "giveAccess" }));
    await page.waitForTimeout(400);
    const afterCard = (await msgs(page)).filter((m) => m.includes("fired"));
    sim.broadcast(JSON.stringify({ command: "giveAccess", relay: 2 }));
    await page.waitForTimeout(400);
    const afterTest = (await msgs(page)).filter((m) => m.includes("fired"));
    check(afterCard.length === 0 && afterTest.length === 1 && afterTest[0].startsWith("Relay 2 fired"), "a granted card shows no relay toast; Test's reply does", JSON.stringify({ afterCard, afterTest }));
  }

  console.log("reconnect");
  {
    // a Wi-Fi blip: the device is out of reach for a while, the session is still good
    sim.state.offline = true;
    sim.dropSockets();
    await page.waitForTimeout(7000); // at least one failed reconnect
    const blip = await page.evaluate(() => ({ token: sessionToken !== "", stored: !!sessionStorage.getItem("ifrfid-token"), signin: !!document.querySelector("#signin[open]"), present: wsConnectionPresent }));
    check(blip.token && blip.stored && !blip.signin && !blip.present, "a failed reconnect while the device is out of reach keeps the session (no sign-in)", JSON.stringify(blip));
    sim.state.offline = false;
    await page.waitForFunction(() => wsConnectionPresent === true, null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => wsConnectionPresent === true && !document.querySelector("#signin[open]")), "once the device is back the page reconnects with the same session");
    // the device answers but will not take the WebSocket for a while: the
    // session is still good, so the page keeps it and retries (it threw the
    // sign-in away whenever the device answered at all, 2026-10-16)
    sim.state.refuseUpgrades = true;
    const sessionChecks = sim.state.counts.session || 0;
    const failedBefore = sim.state.failures;
    sim.dropSockets();
    await page.waitForTimeout(7000); // at least one refused reconnect
    const busy = await page.evaluate(() => ({ token: sessionToken !== "", stored: !!sessionStorage.getItem("ifrfid-token"), signin: !!document.querySelector("#signin[open]"), present: wsConnectionPresent }));
    check(busy.token && busy.stored && !busy.signin && !busy.present && (sim.state.counts.session || 0) > sessionChecks,
      "a WebSocket refused while the session is still good keeps the sign-in (the page asks /session)", JSON.stringify(busy));
    check(sim.state.failures === failedBefore, "asking /session is not counted as a failed login");
    sim.state.refuseUpgrades = false;
    await page.waitForFunction(() => wsConnectionPresent === true, null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => wsConnectionPresent === true && !document.querySelector("#signin[open]")), "once the device takes the WebSocket again the page reconnects with the same session");
    // a slow connect: the 5 s retry timer must not open a second socket beside it
    sim.state.upgradeDelayMs = 6500;
    const upgrades = sim.state.wsUpgrades;
    sim.dropSockets();
    await page.waitForFunction(() => wsConnectionPresent === true, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
    check(sim.state.wsUpgrades - upgrades === 1, "a reconnect still connecting is not joined by a second socket", String(sim.state.wsUpgrades - upgrades));
    // a connect that hangs 8 s and then fails (longer than the 5 s retry
    // timer): the page tries again and reconnects; it stalled on
    // "Reconnecting..." until a reload (review 8 V6, plan 1.9.1 D1)
    sim.state.upgradeDropMs = 8000;
    const upgradesHung = sim.state.wsUpgrades;
    sim.dropSockets();
    await page.waitForFunction(() => wsConnectionPresent === true, null, { timeout: 25000 }).catch(() => {});
    const back = await page.evaluate(() => wsConnectionPresent === true && !document.querySelector("#signin[open]"));
    check(back && sim.state.wsUpgrades - upgradesHung >= 2, "a connect that hangs and fails is followed by another attempt that reconnects", JSON.stringify({ back, attempts: sim.state.wsUpgrades - upgradesHung }));
    // a bad frame neither throws nor stops the listener
    const errorsBefore = pageErrors.length;
    sim.broadcast("{not json");
    sim.broadcast(JSON.stringify({ command: "gettime", epoch: 1700000123 }));
    await page.waitForFunction(() => utcSeconds === 1700000123, null, { timeout: 5000 }).catch(() => {});
    check(pageErrors.length === errorsBefore && await page.evaluate(() => utcSeconds === 1700000123), "a frame that is not JSON is ignored and the next one handled", JSON.stringify(pageErrors.slice(errorsBefore)));
  }

  // ---- WebSocket hijack attempts ---------------------------------------------
  console.log("websocket access control");
  const tryWs = (url, origin) => new Promise((res) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("open", () => { ws.close(); res("open"); });
    ws.on("error", () => res("refused"));
    ws.on("unexpected-response", () => res("refused"));
  });
  const goodToken = await page.evaluate(() => sessionToken);
  check((await tryWs(`ws://127.0.0.1:${sim.port}/ws`, null)) === "refused", "WebSocket without a token is refused");
  check((await tryWs(`ws://127.0.0.1:${sim.port}/ws?token=${"0".repeat(32)}`, null)) === "refused", "WebSocket with a forged token is refused");
  check((await tryWs(`ws://127.0.0.1:${sim.port}/ws?token=${goodToken}`, "http://evil.example")) === "refused", "cross-site WebSocket (foreign Origin) is refused");
  check((await tryWs(`ws://127.0.0.1:${sim.port}/ws?token=${goodToken}`, `http://127.0.0.1:${sim.port}`)) === "open", "same-origin WebSocket with a valid token is accepted (positive control)");

  // a message the device cannot read is answered, and the page shows it (it used to wait for ever)
  await page.evaluate(() => { clearMessages(); websock.send("{\"command\":\"userfile\",\"uid\":"); });
  await page.waitForFunction(() => [...document.querySelectorAll("#msgarea .msgtext")].some((m) => m.textContent.includes("could not read the message")), null, { timeout: 5000 }).catch(() => {});
  check((await msgs(page)).some((m) => m.includes("could not read the message (not valid JSON)")), "a message the device cannot parse gets an error the page shows", JSON.stringify(await msgs(page)));
  await page.evaluate(() => websock.send("{\"uid\":\"1234\"}"));
  await page.waitForFunction(() => [...document.querySelectorAll("#msgarea .msgtext")].some((m) => m.textContent.includes("no command")), null, { timeout: 5000 }).catch(() => {});
  check((await msgs(page)).some((m) => m.includes("The message has no command")), "a message with no command gets an error too");
  // an unknown command was dropped with no answer (ledger H27.1)
  await page.evaluate(() => websock.send("{\"command\":\"nosuchcommand\"}"));
  await page.waitForFunction(() => [...document.querySelectorAll("#msgarea .msgtext")].some((m) => m.textContent.includes("Unknown command")), null, { timeout: 5000 }).catch(() => {});
  check((await msgs(page)).some((m) => m.includes("Unknown command")), "an unknown command gets an error too");

  // ---- digest replay / Basic -----------------------------------------------------
  console.log("login protocol");
  const good = await digestHeader(sim.port, "Site-Door-2026");
  const first = await httpGet(sim.port, "/login", { Authorization: good });
  check(first.status === 200 && JSON.parse(first.body).token, "digest login with a fresh nonce succeeds (positive control)", first.status);
  const replay = await httpGet(sim.port, "/login", { Authorization: good });
  check(replay.status === 401, "replaying a captured digest login is refused", replay.status);
  const basic = await httpGet(sim.port, "/login", { Authorization: "Basic " + Buffer.from("admin:Site-Door-2026").toString("base64") });
  check(basic.status === 401, "Basic auth (password in clear) is refused", basic.status);
  sim.state.failures = 0; // the two refusals above are not part of the throttling test
  {
    const tok = JSON.parse(first.body).token;
    const pw = "Site-Door-2026";
    // a session alone no longer installs firmware: the admin password too (plan 1.9 S1)
    const bare = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9));
    check(bare.status === 403 && bare.body.includes("admin password was not confirmed"), "a firmware upload with a session but no admin password is refused (403)", JSON.stringify(bare));
    const wrong = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9), await stepUpHeaders(sim.port, tok, "not-the-password"));
    check(wrong.status === 403, "and with a wrong password", wrong.status);
    const stale = await stepUpHeaders(sim.port, tok, pw);
    const up = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9), stale);
    check(up.status === 200, "firmware upload accepted once the password is changed (positive control)", up.status);
    const replayed = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9), stale);
    check(replayed.status === 403, "a step-up answer works once (a captured one cannot be replayed)", replayed.status);
    const junk = await httpPost(sim.port, `/update?token=${tok}`, "fake-image".repeat(8), await stepUpHeaders(sim.port, tok, pw));
    check(junk.status === 400 && junk.body.includes("does not start with 0xE9"), "a file that is not an image is refused with the reason, not a bare FAIL", JSON.stringify(junk));
    const full = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9, false), await stepUpHeaders(sim.port, tok, pw));
    check(full.status === 400 && full.body.includes("full-flash"), "a full-flash image (bootloader first) is refused with the reason", JSON.stringify(full));
    const other = await httpPost(sim.port, `/update?token=${tok}`, imageHead(0), await stepUpHeaders(sim.port, tok, pw));
    check(other.status === 400 && other.body.includes("another chip"), "an image for the other chip is refused with the reason", JSON.stringify(other));
    sim.state.updateBusy = true;
    const busy = await httpPost(sim.port, `/update?token=${tok}`, imageHead(9), await stepUpHeaders(sim.port, tok, pw));
    sim.state.updateBusy = false;
    check(busy.status === 409 && busy.body.includes("Another firmware upload"), "a second upload while one runs is told so (409), not 401", JSON.stringify(busy));
    const noTok = await httpPost(sim.port, "/update", "fake-image");
    check(noTok.status === 401, "firmware upload without a session refused", noTok.status);
    // a factory reset and a network or MQTT change need the password too
    const ws = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${tok}`, { origin: `http://127.0.0.1:${sim.port}` });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const answer = (of) => new Promise((res) => {
      const on = (m) => { const o = JSON.parse(String(m)); if (o.resultof === of) { ws.off("message", on); res(o); } };
      ws.on("message", on);
    });
    let a = answer("destroy");
    ws.send(JSON.stringify({ command: "destroy" }));
    const destroyed = await a;
    check(destroyed.result === false && /admin password was not confirmed/.test(destroyed.message) && !sim.state.destroys, "a factory reset with a session but no admin password is refused", JSON.stringify(destroyed));
    const netChange = JSON.parse(JSON.stringify(sim.state.config));
    netChange.command = "configfile";
    netChange.network.ssid = "someone-elses-wifi";
    a = answer("configfile");
    ws.send(JSON.stringify(netChange));
    const netSaved = await a;
    check(netSaved.result === false && /admin password was not confirmed/.test(netSaved.message) && sim.state.config.network.ssid !== "someone-elses-wifi",
      "a network change with a session but no admin password is refused, nothing stored", JSON.stringify(netSaved));
    const mqttChange = JSON.parse(JSON.stringify(sim.state.config));
    mqttChange.command = "configfile";
    mqttChange.mqtt = Object.assign({}, mqttChange.mqtt, { enabled: 1, host: "203.0.113.9", doorcontrol: 1 });
    a = answer("configfile");
    ws.send(JSON.stringify(mqttChange));
    const mqttSaved = await a;
    check(mqttSaved.result === false && sim.state.config.mqtt.host !== "203.0.113.9", "so is pointing MQTT at another broker", JSON.stringify(mqttSaved));
    // since 1.9.1 also a Doors & Readers change (pins, relay time, PIN rules: review 8 V1)
    const hwChange = JSON.parse(JSON.stringify(sim.state.config));
    hwChange.command = "configfile";
    hwChange.hardware = Object.assign({}, hwChange.hardware, { rtime: (Number(hwChange.hardware && hwChange.hardware.rtime) || 3000) + 1000 });
    a = answer("configfile");
    ws.send(JSON.stringify(hwChange));
    const hwSaved = await a;
    check(hwSaved.result === false && /admin password was not confirmed/.test(hwSaved.message) && JSON.stringify(sim.state.config.hardware) !== JSON.stringify(hwChange.hardware),
      "a Doors & Readers change with a session but no admin password is refused, nothing stored", JSON.stringify(hwSaved));

    // ---- plan 1.9.1 B1: a session alone does not open a door, restart, remove
    // a user, erase a log or switch logging; each is refused without the
    // admin password and accepted with it (review 8 V1)
    const nextMsg = (pred, ms = 3000) => new Promise((res) => {
      const t = setTimeout(() => { ws.off("message", on); res(null); }, ms);
      const on = (m) => { const o = JSON.parse(String(m)); if (pred(o)) { clearTimeout(t); ws.off("message", on); res(o); } };
      ws.on("message", on);
    });
    const proofFor = async (action) => {
      const n = nextMsg((o) => o.command === "stepup");
      ws.send(JSON.stringify({ command: "stepup" }));
      const nonce = (await n || {}).nonce;
      return { stepnonce: nonce, stepproof: md5n(`${adminHa1(pw)}:${tok}:${nonce}:${action}`) };
    };
    const refusedForPassword = (o) => !!o && o.command === "result" && o.result === false && /admin password was not confirmed/.test(o.message || "");
    const kept = { files: JSON.stringify(sim.state.files), logging: sim.state.config.general.logging, relayTests: sim.state.relayTests.length,
      removes: sim.state.removes.length, restartPending: sim.state.restartPending, timeTrusted: sim.state.timeTrusted, settimes: sim.state.settimes.length, users: JSON.stringify(sim.state.users) };
    check(STEP_UP_COMMANDS.length === 9, "the step-up commands: Test x4, Restart, remove, clear both logs, logging", STEP_UP_COMMANDS.join());
    for (const cmd of STEP_UP_COMMANDS) {
      const of = cmd.startsWith("testrelay") ? "testrelay" : cmd;
      const extra = cmd === "remove" ? { uid: "ffff0001" } : cmd === "setlogging" ? { enabled: kept.logging === 0 ? 0 : 1 } : {};
      const before = JSON.stringify([sim.state.relayTests.length, sim.state.removes.length, sim.state.restartPending, sim.state.files, sim.state.loggingChanges || []]);
      let got = nextMsg((o) => (o.command === "result" && o.resultof === of) || o.command === "giveAccess");
      ws.send(JSON.stringify({ command: cmd, ...extra }));
      const bare = await got;
      const after = JSON.stringify([sim.state.relayTests.length, sim.state.removes.length, sim.state.restartPending, sim.state.files, sim.state.loggingChanges || []]);
      check(refusedForPassword(bare) && bare.resultof === of && before === after, `${cmd} with a session but no admin password is refused, nothing done`, JSON.stringify(bare));
      got = nextMsg((o) => (o.command === "result" && o.resultof === of) || o.command === "giveAccess");
      ws.send(JSON.stringify({ command: cmd, ...extra, ...(await proofFor(cmd)) }));
      const ok = await got;
      check(!!ok && !refusedForPassword(ok), `${cmd} with the admin password goes through`, JSON.stringify(ok));
      if (cmd === "restart") {
        got = nextMsg((o) => o.command === "result" && o.resultof === of);
        const replay = await proofFor(cmd);
        ws.send(JSON.stringify({ command: cmd, ...replay }));
        await got;
        got = nextMsg((o) => o.command === "result" && o.resultof === of);
        ws.send(JSON.stringify({ command: cmd, ...replay }));
        check(refusedForPassword(await got), "a step-up answer for a command works once (a captured one cannot be replayed)");
      }
    }
    // userfile (D1): a new user, admin access or a PIN change needs it; a name on a stored user does not
    const sendUser = (rec) => {
      const g = nextMsg((o) => o.command === "result" && o.resultof === "userfile");
      ws.send(JSON.stringify({ command: "userfile", user: "Step Up", acctype: 1, validuntil: 1900000000, ...rec }));
      return g;
    };
    const has = (uid) => sim.state.users.some((u) => u.uid === uid);
    let u = await sendUser({ uid: "5e1f0001", create: 1 });
    check(refusedForPassword(u) && !has("5e1f0001"), "adding a user with a session but no admin password is refused", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001" });
    check(refusedForPassword(u) && !has("5e1f0001"), "so is adding one without the create flag (the device checks what it stores)", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", create: 1, ...(await proofFor("userfile")) });
    check(u && u.result === true && has("5e1f0001"), "adding a user with the admin password is stored", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", user: "Renamed" });
    check(u && u.result === true && sim.state.users.find((x) => x.uid === "5e1f0001").username === "Renamed", "renaming a stored user needs only the session", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", pincode: "4321" });
    check(refusedForPassword(u) && !sim.state.users.find((x) => x.uid === "5e1f0001").pincode, "setting a PIN without the admin password is refused", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", acctype: 99 });
    check(refusedForPassword(u) && sim.state.users.find((x) => x.uid === "5e1f0001").acctype !== 99, "giving admin access without the admin password is refused", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", acctype: 99, pincode: "4321", ...(await proofFor("userfile")) });
    check(u && u.result === true && sim.state.users.find((x) => x.uid === "5e1f0001").acctype === 99, "and accepted with it", JSON.stringify(u));
    u = await sendUser({ uid: "5e1f0001", acctype: 99, keeppin: 1, pincode: "", user: "Admin Renamed" });
    check(refusedForPassword(u), "an admin user's record keeps needing it (any access 99)", JSON.stringify(u));
    // settime: a lost clock is set with the session, a set one moves only with the password
    sim.state.timeTrusted = true;
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    let t = nextMsg((o) => (o.command === "result" && o.resultof === "settime") || o.command === "gettime");
    ws.send(JSON.stringify({ command: "settime", epoch }));
    const tBare = await t;
    check(refusedForPassword(tBare) && !sim.state.settimes.includes(epoch), "moving a set clock with a session but no admin password is refused", JSON.stringify(tBare));
    t = nextMsg((o) => (o.command === "result" && o.resultof === "settime") || o.command === "gettime");
    ws.send(JSON.stringify({ command: "settime", epoch, ...(await proofFor("settime")) }));
    const tOk = await t;
    check(tOk && tOk.command === "gettime" && sim.state.settimes.includes(epoch), "and moved with it", JSON.stringify(tOk));
    sim.state.timeTrusted = false;
    t = nextMsg((o) => (o.command === "result" && o.resultof === "settime") || o.command === "gettime");
    ws.send(JSON.stringify({ command: "settime", epoch: epoch + 1 }));
    const tLost = await t;
    check(tLost && tLost.command === "gettime" && sim.state.settimes.includes(epoch + 1), "a lost clock is set with the session alone", JSON.stringify(tLost));
    // the checks above leave the shared simulator as it was
    sim.state.files = JSON.parse(kept.files);
    sim.state.config.general.logging = kept.logging;
    sim.state.relayTests.splice(kept.relayTests);
    sim.state.removes.splice(kept.removes);
    sim.state.restartPending = kept.restartPending;
    sim.state.timeTrusted = kept.timeTrusted;
    sim.state.settimes.splice(kept.settimes);
    sim.state.users = JSON.parse(kept.users);
    ws.close();
  }
  // after a reload the page holds no password: it asks once, then goes on
  {
    const asked = await page.evaluate(() => {
      signinHa1 = null;
      window.__stepOk = null;
      withStepUp("settings", (s) => { window.__stepOk = s; }, () => { window.__stepOk = "failed"; });
      return document.getElementById("stepupdlg").open;
    });
    check(asked, "with no password kept, a step-up asks for it", asked);
    await page.fill("#stepuppass", "Site-Door-2026");
    await page.click("#stepupdlg button[type=submit]");
    await page.waitForFunction(() => window.__stepOk !== null, null, { timeout: 5000 }).catch(() => {});
    const got = await page.evaluate(() => ({ step: window.__stepOk, kept: signinHa1 === adminHa1("Site-Door-2026") }));
    check(got.step && got.step.stepnonce && got.step.stepproof && got.kept, "and answers the challenge with it", JSON.stringify(got));
    // Test asks for it too when it is not kept (plan 1.9.1 B1); Cancel sends nothing
    const relays = sim.state.relayTests.length;
    await page.evaluate(() => { clearMessages(); signinHa1 = null; testRelay(1); });
    if (await isOpen(page, "confirmmodal")) await page.click("#confirmok"); // Test is confirmed first (plan 1.9.1 D3)
    await page.waitForTimeout(300);
    const askedForTest = await isOpen(page, "stepupdlg");
    await page.click("#stepupdlg [data-onclick=stepUpCancel]");
    await page.waitForTimeout(300);
    check(askedForTest && sim.state.relayTests.length === relays && (await msgs(page)).some((m) => m.includes("Cancelled")), "Test asks for the admin password when the page holds none; Cancel fires nothing",
      JSON.stringify({ askedForTest, msgs: await msgs(page) }));
    await page.evaluate(() => { signinHa1 = adminHa1("Site-Door-2026"); });
  }

  // ---- a user-list page too large for the device: the reason, at once, no
  // retries (review 8 V16, plan 1.9.1 C5)
  {
    sim.state.userlistOverflow = true;
    const before = (sim.state.counts.userlist || 0);
    const t0 = Date.now();
    await nav(page, "users");
    await page.waitForFunction(() => [...document.querySelectorAll("#msgarea .msgtext")].some((m) => m.textContent.includes("too large to send")), null, { timeout: 3000 }).catch(() => {});
    const shownAfter = Date.now() - t0;
    const shown = (await msgs(page)).some((m) => m.includes("too large to send; shorten some names"));
    await page.waitForTimeout(1500);
    const asked = (sim.state.counts.userlist || 0) - before;
    const spinner = await page.evaluate(() => { const l = document.getElementById("loading-img"); return !!l && l.style.display !== "none" && l.offsetParent !== null; });
    check(shown && shownAfter < 2000 && asked === 1 && !spinner, "a user page too large for the device shows the reason at once, asked once, no spinner", JSON.stringify({ shown, shownAfter, asked, spinner }));
    sim.state.userlistOverflow = false;
    await nav(page, "status").catch(() => {});
  }

  // ---- a huge user-list page is answered at once: an empty list and the real
  // page count, not an int overflow and a 45 s wait (review 8 V19, plan 1.9.1 B6)
  {
    const login = await httpGet(sim.port, "/login", { Authorization: await digestHeader(sim.port, "Site-Door-2026") });
    const ptok = JSON.parse(login.body).token;
    const pws = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${ptok}`, { origin: `http://127.0.0.1:${sim.port}` });
    await new Promise((res, rej) => { pws.on("open", res); pws.on("error", rej); });
    const got = { list: null, result: null };
    const t0 = Date.now();
    const done = new Promise((res) => {
      const t = setTimeout(res, 3000);
      pws.on("message", (m) => {
        const o = JSON.parse(String(m));
        if (o.command === "userlist") got.list = o;
        if (o.command === "result" && o.resultof === "userlist") { got.result = o; clearTimeout(t); res(); }
      });
    });
    pws.send(JSON.stringify({ command: "userlist", page: 2147483647 }));
    await done;
    pws.close();
    const want = Math.ceil(sim.state.users.length / 50);
    check(got.list && got.list.list.length === 0 && got.list.haspages === want && got.result && got.result.result === true && Date.now() - t0 < 3000,
      "user list page 2147483647: an empty list and the real page count, answered at once", JSON.stringify({ list: got.list && { n: got.list.list.length, haspages: got.list.haspages }, want, result: got.result }));
  }

  // ---- a session token sent as a header on the upgrade is tracked: logout
  // on that socket ends the session (review 8 V18, plan 1.9.1 B5) ---------
  {
    const login = await httpGet(sim.port, "/login", { Authorization: await digestHeader(sim.port, "Site-Door-2026") });
    const htok = JSON.parse(login.body).token;
    const hws = new WebSocket(`ws://127.0.0.1:${sim.port}/ws`, { origin: `http://127.0.0.1:${sim.port}`, headers: { "X-Session-Token": htok } });
    const opened = await new Promise((res) => { hws.on("open", () => res(true)); hws.on("error", () => res(false)); });
    const closed = new Promise((res) => hws.on("close", () => res(true)));
    if (opened) hws.send(JSON.stringify({ command: "logout" }));
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
    const after = await httpGet(sim.port, `/session?token=${htok}`).catch(() => ({ status: 0 }));
    check(opened && !sim.state.tokens.has(htok), "a WebSocket opened with the token in X-Session-Token can log out: its session ends", JSON.stringify({ opened, live: sim.state.tokens.has(htok), session: after.status }));
  }

  // ---- a password change ends every open session -------------------------------
  console.log("password change ends sessions");
  const otherToken = JSON.parse(first.body).token;
  const other = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${otherToken}`);
  await new Promise((r) => other.on("open", r));
  const otherClosed = new Promise((r) => { other.on("close", () => r(true)); setTimeout(() => r(false), 4000); });
  {
    const wrong = await page.evaluate(() => new Promise((res) => {
      const h = (e) => { const o = JSON.parse(e.data); if (o.resultof === "setpassword") { websock.removeEventListener("message", h); res(o); } };
      websock.addEventListener("message", h);
      websock.send(passwordChangeMessage("Site-Door-2027", adminHa1("not-the-password")));
    }));
    check(wrong.result === false && sim.state.ha1 === adminHa1("Site-Door-2026"), "password change refused with a wrong current password", JSON.stringify(wrong));
    const noCurrent = await page.evaluate(() => new Promise((res) => {
      const h = (e) => { const o = JSON.parse(e.data); if (o.resultof === "setpassword") { websock.removeEventListener("message", h); res(o); } };
      websock.addEventListener("message", h);
      websock.send(JSON.stringify({ command: "setpassword", password: "Site-Door-2027" }));
    }));
    check(noCurrent.result === false && sim.state.ha1 === adminHa1("Site-Door-2026"), "password change refused in the old plain form (no current password, the new one in clear)");
  }
  await page.evaluate(() => sendWebsocket(passwordChangeMessage("Site-Door-2027", adminHa1("Site-Door-2026"))));
  check(await otherClosed, "another open session is disconnected when the password changes");
  check(sim.state.config.general.pswd === adminHa1("Site-Door-2027") && !JSON.stringify(sim.state.config).includes("Site-Door-202"),
    "a password change stores the new password's hash, not the password");
  await page.waitForSelector("#signin[open]", { timeout: 10000 });
  check(await fetch(`http://127.0.0.1:${sim.port}/session`, { headers: { "X-Session-Token": "0".repeat(32) } }).then((r) => r.status) === 401,
    "/session answers 401 for a token the device does not hold (the page then signs in again)");

  // ---- logout revokes the token on the device ------------------------------------
  console.log("logout");
  await page.fill("#password", "Site-Door-2027");
  await page.click("#signin button[type=submit]");
  await page.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true, null, { timeout: 10000 });
  const tokenBeforeLogout = await page.evaluate(() => sessionToken);
  const failuresBefore = sim.state.failures;
  // a second socket on the same session (another tab): logout must end it
  // too, as the token is only checked when a socket opens (review 4)
  const otherTab = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${tokenBeforeLogout}`, { origin: `http://127.0.0.1:${sim.port}` });
  const otherTabClosed = new Promise((res) => otherTab.on("close", (code) => res(code)));
  await new Promise((res, rej) => { otherTab.on("open", res); otherTab.on("error", rej); });
  await page.evaluate(() => logout());
  await page.waitForTimeout(800);
  const otherCode = await Promise.race([otherTabClosed, new Promise((res) => setTimeout(() => res("still open"), 2000))]);
  check(otherCode === 1008, "logout closes every socket opened with that session, not just its own", String(otherCode));
  check((await tryWs(`ws://127.0.0.1:${sim.port}/ws?token=${tokenBeforeLogout}`, `http://127.0.0.1:${sim.port}`)) === "refused", "token is unusable after logout");
  check(sim.state.failures === failuresBefore, "logout is not counted as a failed login");
  {
    // the socket's own session ends, whatever token the message names (a
    // stale one closed the socket and left the session valid, review 7)
    const login = await httpGet(sim.port, "/login", { Authorization: await digestHeader(sim.port, "Site-Door-2027") });
    const tok = login.status === 200 ? JSON.parse(login.body).token : "";
    const s = new WebSocket(`ws://127.0.0.1:${sim.port}/ws?token=${tok}`, { origin: `http://127.0.0.1:${sim.port}` });
    await new Promise((res, rej) => { s.on("open", res); s.on("error", rej); });
    const closed = new Promise((res) => s.on("close", res));
    s.send(JSON.stringify({ command: "logout", token: "0".repeat(32) }));
    await closed;
    check(tok && (await tryWs(`ws://127.0.0.1:${sim.port}/ws?token=${tok}`, `http://127.0.0.1:${sim.port}`)) === "refused", "logout ends the socket's own session, not the token in the message", login.status);
  }

  // ---- login throttling ------------------------------------------------------
  console.log("login throttling");
  const tryLogin = (pw) => page.evaluate((pw) => new Promise((res) => {
    const x = new XMLHttpRequest();
    x.open("get", "/login", true, "admin", pw);
    x.onload = () => res(x.status);
    x.send();
  }), pw);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push(await tryLogin("bad-" + i));
  statuses.push(await tryLogin("Site-Door-2027"));
  check(statuses.slice(0, 5).every((s) => s === 401), "wrong passwords get 401", statuses.join(","));
  check(statuses[5] === 429, "after 5 failures even the right password is refused (429)", statuses.join(","));
  {
    const blocked = await httpGet(sim.port, "/login");
    const ra = Number(blocked.headers["retry-after"]);
    check(blocked.status === 429 && ra > 240 && ra <= 300, "a refused login says how long the block lasts (Retry-After)", JSON.stringify([blocked.status, blocked.headers["retry-after"]]));
    const said = await page.evaluate(() => new Promise((res) => {
      document.getElementById("password").value = "Site-Door-2027";
      login();
      setTimeout(() => res(document.getElementById("loginerror").textContent), 1000);
    }));
    check(said === "Too many failed attempts. Wait 5 minutes and try again.", "the sign-in page says the wait the device reports", said);
    // no answer from the device: the sign-in page said nothing at all
    await page.route("**/login", (r) => r.abort("connectionrefused"));
    const unreachable = await page.evaluate(() => new Promise((res) => {
      setText("loginerror", ""); hide("loginerror");
      login();
      setTimeout(() => res(isShown("loginerror") ? document.getElementById("loginerror").textContent : "(nothing shown)"), 1000);
    }));
    await page.unroute("**/login");
    check(unreachable.startsWith("The device did not answer."), "a sign-in the device never answers says so", unreachable);
  }

  // ---- VOANZO ESP32 2-relay board with two Wiegand readers ---------------------
  console.log("config policy vectors (shared with the firmware)");
  {
    const vec = JSON.parse(fs.readFileSync(path.join(repo, "test", "vectors", "config-policy.json"), "utf8"));
    const pinsH = path.join(repo, "src", "core", "pins.h");
    const at = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
    const build = (c) => {
      const cfg = structuredClone(vec.base);
      for (const [p, val] of Object.entries(c.set)) {
        const keys = p.split("."), last = keys.pop();
        let o = cfg;
        for (const k of keys) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
        if (val === null) delete o[last]; else o[last] = structuredClone(val);
      }
      return cfg;
    };
    const bad = [];
    for (const c of vec.cases) {
      const cfg = build(c);
      // the vector's password in force, stored as the device stores it
      const r = simPolicy(cfg, simBoard(c.chip, pinsH), adminHa1(c.password), c.mustchange ?? !(c.password !== "admin" && c.password.length >= 8 && c.password.length <= 64));
      if (r.problem !== c.problem) bad.push(`${c.name}: ${JSON.stringify(r.problem)}`);
      else if (c.problem === null)
        for (const [p, want] of Object.entries(c.expect || {})) {
          const got = p === "warn" ? r.ignoredPassword : at(cfg, p) ?? null; // null: the key is absent
          if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${c.name}: ${p}=${JSON.stringify(got)}`);
        }
    }
    check(bad.length === 0 && vec.cases.length >= 30, `simulator agrees with the firmware policy on all ${vec.cases.length} shared vectors`, bad.join(" | "));
    // the web UI checks a save before sending it (configProblem): the same
    // vectors, except the admin-password rule, which only the device can judge,
    // and the whole-file rule (a page's Save checks its own section only)
    const wholeFile = "The settings have no network or hardware section";
    const uiCases = vec.cases.filter((c) => c.password && c.password !== "admin" && c.password.length >= 8 && !c.mustchange && c.problem !== wholeFile)
      .map((c) => ({ name: c.name, problem: c.problem, cfg: build(c), board: simBoard(c.chip, pinsH) }));
    const uiBad = await page.evaluate((cases) => cases
      .map((c) => ({ name: c.name, want: c.problem, got: configProblem(c.cfg, c.board) }))
      .filter((r) => r.got !== r.want), uiCases);
    check(uiBad.length === 0 && uiCases.length >= vec.cases.length - 5, `the web UI's own check agrees with the firmware policy on ${uiCases.length} shared vectors`, JSON.stringify(uiBad));
  }
  {
    const vec = JSON.parse(fs.readFileSync(path.join(repo, "test", "vectors", "user-records.json"), "utf8"));
    const bad = [];
    for (const c of vec.cases) {
      const msg = structuredClone(vec.base);
      for (const [k, v] of Object.entries(c.set)) if (v === null) delete msg[k]; else msg[k] = v;
      const r = simUserRecord(msg);
      if ((r.problem ?? null) !== c.problem) bad.push(`${c.name}: ${JSON.stringify(r.problem)}`);
      else if (c.problem === null && JSON.stringify(r.stored) !== JSON.stringify(c.stored)) bad.push(`${c.name}: stored ${JSON.stringify(r.stored)}`);
    }
    check(bad.length === 0 && vec.cases.length >= 25, `simulator agrees with the firmware on all ${vec.cases.length} user-record vectors`, bad.join(" | "));
  }

  console.log("restart before the first save");
  {
    const sim3 = await startSim({ webhDir: path.join(repo, "src", "webh"), config: null });
    try {
      const login = async (pw) => httpGet(sim3.port, "/login", { Authorization: await digestHeader(sim3.port, pw) });
      const first = await login("admin");
      const tok = JSON.parse(first.body).token;
      const sock = new WebSocket(`ws://127.0.0.1:${sim3.port}/ws?token=${tok}`);
      await new Promise((r) => sock.on("open", r));
      const reply = new Promise((r) => sock.on("message", (m) => { const o = JSON.parse(String(m)); if (o.resultof === "setpassword") r(o); }));
      sock.send(passwordChange("Fresh-Board-2026", "admin", tok));
      check((await reply).result === true, "fresh device: new password accepted before any settings save");
      sock.close();
      sim3.restart();
      check((await login("admin")).status === 401, "after a restart the factory password is refused (it came back on 1.0)");
      check((await login("Fresh-Board-2026")).status === 200, "after a restart the new password still works");
      check(sim3.state.nvs.adminha1 === adminHa1("Fresh-Board-2026") && !JSON.stringify(sim3.state.nvs).includes("Fresh-Board-2026"),
        "a password set before the first save waits in NVS as its hash only", JSON.stringify(sim3.state.nvs));
    } finally {
      await sim3.close();
    }
  }

  console.log("admin password stored in clear by 1.4.1: hashed once at start-up");
  {
    // config.json from 1.4.1 (password in clear), and a fresh board's
    // pending NVS copy from 1.4.1 (also in clear)
    const simA = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Legacy-Door-2026" });
    const simB = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Legacy-Pending-1", config: null });
    try {
      const g = simA.state.config.general;
      check(simA.state.migrations === 1 && g.pswd === adminHa1("Legacy-Door-2026") && g.pswdhash === 1 && !("pswdchange" in g) && !simA.state.mustChange,
        "a password in clear in config.json is replaced by its hash at start-up", JSON.stringify(g));
      check((await httpGet(simA.port, "/login", { Authorization: await digestHeader(simA.port, "Legacy-Door-2026") })).status === 200,
        "the same password still signs in after the migration");
      simA.restart();
      check(simA.state.migrations === 1 && simA.state.config.general.pswd === adminHa1("Legacy-Door-2026"), "the migration runs once (a restart leaves the hash alone)");
      check(simB.state.migrations === 1 && simB.state.nvs.adminha1 === adminHa1("Legacy-Pending-1") && !("adminpw" in simB.state.nvs),
        "a pending password in clear in NVS is replaced by its hash", JSON.stringify(simB.state.nvs));
      check((await httpGet(simB.port, "/login", { Authorization: await digestHeader(simB.port, "Legacy-Pending-1") })).status === 200,
        "the pending password still signs in after the migration");
    } finally {
      await simA.close();
      await simB.close();
    }
    // the factory password stored in clear stays one to change
    const simC = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "admin" });
    try {
      check(simC.state.mustChange && simC.state.config.general.pswdchange === 1 && simC.state.config.general.pswd === adminHa1("admin"),
        "a factory password in clear is hashed and flagged must-change", JSON.stringify(simC.state.config.general));
    } finally {
      await simC.close();
    }
  }

  console.log("fresh device: every settings page saves");
  {
    // no config.json yet (as on the board after a flash): each page's Save,
    // then Save & Reboot, with no alert. On the board General refused to save
    // while the page still held the factory "admin" password (ledger H5).
    const sim4 = await startSim({ webhDir: path.join(repo, "src", "webh"), chip: "esp32", password: "Fresh-Pass-2026", config: null });
    const pf = await context.newPage();
    const pfDialogs = [], pfErrors = [];
    pf.on("dialog", (d) => { pfDialogs.push(d.message()); d.accept(); });
    pf.on("pageerror", (e) => pfErrors.push(String(e)));
    try {
      await pf.goto(`http://127.0.0.1:${sim4.port}/`);
      await pf.waitForSelector("#signin[open]", { timeout: 10000 });
      await pf.fill("#password", "Fresh-Pass-2026");
      await pf.click("#signin button[type=submit]");
      await pf.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && ajaxobj && ajaxobj.chip === "esp32", null, { timeout: 10000 });
      await pf.waitForSelector("#ajaxcontent #setupcard", { state: "attached", timeout: 5000 }).catch(() => {});
      check(await pf.evaluate(() => !!document.getElementById("setupcard") && !document.getElementById("setupcard").hidden), "a reader with no settings shows the setup card on Status (plan 1.9 C3)");
      const pages = ["general", "network", "hardware", "mqtt", "ntp"];
      const done = [], pageMsgs = [], reviewed = [];
      for (const navId of pages) {
        await nav(pf, navId);
        const btn = `#ajaxcontent [data-onclick="savePage"][data-arg="${navId}"]`;
        await pf.waitForSelector(btn, { state: "visible", timeout: 10000 });
        await pf.waitForTimeout(300);
        await pf.click(btn);
        await pf.waitForTimeout(300);
        // a page's Save stages and opens the review (plan 1.9 C2); closed
        // here, the changes stay staged for the next pages
        if (await isOpen(pf, "reviewmodal")) {
          reviewed.push(navId);
          await pf.click("#reviewmodal .dlg-head [data-close]");
          await pf.waitForTimeout(200);
        }
        // messages belong to the open page (the next page clears them): read them here
        pageMsgs.push(...(await msgs(pf)).map((m) => navId + ": " + m));
        done.push(navId + (pfDialogs.length ? ":" + pfDialogs.at(-1) : ""));
      }
      done.push(...pageMsgs);
      check(pfDialogs.length === 0 && pageMsgs.length === 0, "fresh device: Save on General, Network, Hardware, MQTT and NTP raises no alert", JSON.stringify(done));
      check(reviewed.length === pages.length, "a page's Save opens the review straight away, every page", JSON.stringify(reviewed));
      await pf.click("#commit");
      await pf.waitForSelector("#reviewmodal[open]");
      const firstReview = await pf.$$eval("#changelist li", (els) => els.map((e) => e.textContent));
      check(firstReview.some((t) => /Require pin code after RFID card: off$/.test(t)) && firstReview.some((t) => /MQTT door control: Disabled$/.test(t)),
        "fresh device: the first-save review names PIN required (off) and MQTT door control (Disabled)", JSON.stringify(firstReview));
      // and the network it will be on, with the setup hotspot password (plan 1.9.1 D5)
      check(firstReview.some((t) => /IRONFRAME-RFID-ddeeff$/.test(t)) && firstReview.some((t) => t.startsWith("Hotspot password: the setup default (ironframe-setup)")),
        "fresh device: the first-save review names the hotspot and says its password is the setup default", JSON.stringify(firstReview));
      await pf.click("#savereboot");
      await pf.waitForFunction(() => true);
      for (let i = 0; i < 20 && sim4.state.savedConfigs.length === 0; i++) await pf.waitForTimeout(250);
      check(sim4.state.savedConfigs.length === 1 && sim4.state.rejectedConfigs.length === 0 && pfDialogs.length === 0 && (await msgs(pf)).length === 0,
        "fresh device: Save & Reboot stores the settings", JSON.stringify({ saved: sim4.state.savedConfigs.length, rejected: sim4.state.rejectedConfigs, dialogs: pfDialogs }));
      const sv = sim4.state.savedConfigs[0] || {};
      check(sv.mqtt && sv.mqtt.doorcontrol === 0, "fresh device: MQTT door control is saved off", JSON.stringify(sv.mqtt));
      check(sv.hardware && !sv.hardware.requirepincodeafterrfid, "fresh device: PIN required is saved off (the page defaulted it on, so the first save refused every card with no PIN)", JSON.stringify(sv.hardware && sv.hardware.requirepincodeafterrfid));
      check(sv.network && sv.network.wmode === 1 && sv.network.ssid === "IRONFRAME-RFID-ddeeff",
        "fresh device: the first save keeps the hotspot name the board broadcasts (it renamed it to IRONFRAME-RFID)", JSON.stringify(sv.network));
      check(sv.network && sv.network.pswd === "ironframe-setup",
        "fresh device: the first save keeps the setup hotspot's password (it saved an open hotspot)", JSON.stringify(sv.network && sv.network.pswd));
      check(sv.general && sv.general.hostnm === "ironframe-rfid" && sv.general.openinghours.length === 7 && sv.hardware.rpin === 16 && sv.hardware.relay2.rpin === 17,
        "fresh device: the stored settings are the filled-in page values (ESP32 preset relays 16/17)", JSON.stringify(sv.general) + " " + JSON.stringify(sv.hardware && [sv.hardware.rpin, sv.hardware.relay2]));
      check(pfErrors.length === 0, "fresh device: no JavaScript errors", JSON.stringify(pfErrors));
    } finally {
      await pf.close();
      await sim4.close();
    }
  }

  console.log("reader 2 off: a door-name save");
  {
    // 1.4's page stored reader 2's door as null while reader 2 was off; a
    // door-name-only save listed "Reader 2 opens" as a second change
    const r1 = { door: -1, ledpin: 255, beeperpin: 255, feedbackactivehigh: 1, direction: 0 };
    const r2 = (door) => ({ enabled: 0, wgd0pin: 255, wgd1pin: 255, door, ledpin: 255, beeperpin: 255, feedbackactivehigh: 1, direction: 0 });
    const relay2 = { rpin: 17, ltype: 0, rtype: 1, rtime: 400, doorname: "Back", doorstatpin: 255, openlockpin: 255 };
    const cases = [
      ["two doors, door stored as null", { numrelays: 2, relay2, reader1: r1, reader2: r2(null) }, 1],
      ["one door, door 1 stored", { reader1: r1, reader2: r2(0) }, 0]
    ];
    for (const [name, hw, wantDoor] of cases) {
      const sim7 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Door-Name-2026" });
      Object.assign(sim7.state.config.hardware, hw);
      const pd = await context.newPage();
      const pdErrors = [];
      pd.on("pageerror", (e) => pdErrors.push(String(e)));
      try {
        await pd.goto(`http://127.0.0.1:${sim7.port}/`);
        await pd.waitForSelector("#signin[open]", { timeout: 10000 });
        await pd.fill("#password", "Door-Name-2026");
        await pd.click("#signin button[type=submit]");
        await pd.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice, null, { timeout: 10000 });
        await nav(pd, "hardware");
        await pd.waitForSelector("#ajaxcontent #doorname", { state: "visible" });
        await pd.waitForTimeout(300);
        await pd.fill("#ajaxcontent #doorname", "Front");
        await pd.evaluate(() => savehardware());
        const door = await pd.evaluate(() => config.hardware.reader2.door);
        await pd.click("#commit");
        await waitOpen(pd, "reviewmodal");
        const items = await pd.$$eval("#changelist li", (li) => li.map((x) => x.textContent));
        check(items.length === 1 && items[0] === "Hardware: Door name (relay 1): Door → Front" && door === wantDoor && pdErrors.length === 0,
          `reader 2 off, ${name}: a door-name-only Hardware save lists exactly one change and keeps reader 2's door (${wantDoor})`, JSON.stringify({ items, door, pdErrors }));
        // settings stored before 1.7 (no rhold): shown as Unlocked, not added by a save; a door added now defaults to Locked
        const hold = await pd.evaluate(() => ({ shown: document.getElementById("holdrly").value, staged: "rhold" in config.hardware, r2: config.hardware.relay2 ? "rhold" in config.hardware.relay2 : null }));
        await pd.click("#reviewmodal .dlg-head [data-close]").catch(() => {});
        await pd.selectOption("#ajaxcontent #numrlys", String(Number(await pd.evaluate(() => numRelays)) + 1));
        const added = await pd.evaluate((n) => document.getElementById("holdrly" + n).value, await pd.evaluate(() => numRelays));
        check(hold.shown === "0" && !hold.staged && hold.r2 !== true && added === "1",
          `${name}: stored settings without rhold show Unlocked and a save does not add it; a door added with Doors defaults to Locked`, JSON.stringify({ hold, added }));
      } finally {
        await pd.close();
        await sim7.close();
      }
    }
  }

  console.log("reader 1's default door");
  {
    // no stored reader 1 door with two doors: door 1, as the firmware reads it
    // (it was every permitted door); a stored -1 stays every door
    const relay2 = { rpin: 17, ltype: 0, rtype: 1, rtime: 400, doorname: "Back", doorstatpin: 255, openlockpin: 255 };
    const cases = [
      ["two doors, no reader 1 settings", { numrelays: 2, relay2 }, "0"],
      ["two doors, every door stored", { numrelays: 2, relay2, reader1: { door: -1, ledpin: 255, beeperpin: 255, feedbackactivehigh: 1, direction: 0 } }, "-1"],
      ["one door, no reader 1 settings", {}, "-1"]
    ];
    for (const [name, hw, want] of cases) {
      const sim8 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Door-One-2026" });
      Object.assign(sim8.state.config.hardware, hw);
      const pr = await context.newPage();
      try {
        await pr.goto(`http://127.0.0.1:${sim8.port}/`);
        await pr.waitForSelector("#signin[open]", { timeout: 10000 });
        await pr.fill("#password", "Door-One-2026");
        await pr.click("#signin button[type=submit]");
        await pr.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice, null, { timeout: 10000 });
        await nav(pr, "hardware");
        await pr.waitForSelector("#ajaxcontent #doorname", { state: "visible" });
        await pr.waitForTimeout(300);
        const v = await pr.evaluate(() => document.getElementById("r1door").value);
        check(v === want, `reader 1 opens, ${name}: ${want === "0" ? "door 1" : "every door"}`, v);
      } finally {
        await pr.close();
        await sim8.close();
      }
    }
  }

  console.log("RTC on the Time page");
  {
    // a DS3231 on the Time page: its pins in the same check as Doors & Readers
    // (relay 1 is on GPIO21 in this config, the RTC's default SDA)
    const simR = await startSim({ webhDir: path.join(repo, "src", "webh"), chip: "esp32", password: "Rtc-Clock-2026" });
    Object.assign(simR.state.config.hardware, { wgd0pin: 34, wgd1pin: 35 });
    simR.state.rtc = { state: "ok", time: 1792179605 }; // 2026-10-16 19:40:05 UTC
    const pt = await context.newPage();
    const ptErrors = [];
    pt.on("pageerror", (e) => ptErrors.push(String(e)));
    try {
      await pt.goto(`http://127.0.0.1:${simR.port}/`);
      await pt.waitForSelector("#signin[open]", { timeout: 10000 });
      await pt.fill("#password", "Rtc-Clock-2026");
      await pt.click("#signin button[type=submit]");
      await pt.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice && ajaxobj && ajaxobj.chip === "esp32", null, { timeout: 10000 });
      await nav(pt, "ntp");
      await pt.waitForSelector("#ajaxcontent #rtctype", { state: "visible" });
      await pt.waitForTimeout(300);
      const st = await pt.evaluate(() => ({ status: document.getElementById("rtcstatus").textContent, pins: !document.getElementById("rtcpins").hidden, type: document.getElementById("rtctype").value,
        others: [rtcStatusText({ state: "missing", time: 0 }), rtcStatusText({ state: "lost", time: 0 }), rtcStatusText({ state: "off", time: 0 })] }));
      check(st.status.startsWith("RTC found: 2026-10-16 ") && !st.pins && st.type === "0", "the Time page shows the RTC the reader found at start, its pins hidden while the type is None", JSON.stringify(st));
      check(st.others[0].startsWith("RTC not found") && st.others[1].includes("lost the time: battery?") && st.others[2].startsWith("No RTC"), "the RTC status line says not found, lost the time (battery?) and none", JSON.stringify(st.others));
      await pt.selectOption("#ajaxcontent #rtctype", "1");
      const clash = () => pt.evaluate(() => ({
        pins: !document.getElementById("rtcpins").hidden, sda: document.getElementById("rtcsdapin").value, scl: document.getElementById("rtcsclpin").value,
        marked: [...document.querySelectorAll("#ajaxcontent .field.pin-clash select")].map((e) => e.id),
        note: (document.querySelector("#ajaxcontent .pin-clash-msg") || {}).textContent || null,
        banner: isShown("ntpproblem") ? document.getElementById("ntpproblemtext").textContent : "",
        opt21: document.querySelector('#rtcsclpin option[value="21"]').textContent,
      }));
      const c1 = await clash();
      check(c1.pins && c1.sda === "21" && c1.scl === "22" && JSON.stringify(c1.marked) === JSON.stringify(["rtcsdapin"]) && c1.note === "GPIO 21 is also Relay 1" &&
        c1.banner === "GPIO 21 is used twice: Relay 1 and RTC SDA." && c1.opt21 === "GPIO-21 — in use: Relay 1, RTC SDA",
        "a DS3231 on its default pins: SDA 21 / SCL 22, and the clash with relay 1 on GPIO21 is marked on the SDA field, in the banner and in the menus", JSON.stringify(c1));
      // the clash on a phone does not scroll the page sideways
      await pt.setViewportSize({ width: 390, height: 844 });
      await pt.waitForTimeout(300);
      const wide = await pt.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth, marked: document.querySelectorAll("#ajaxcontent .field.pin-clash").length }));
      await pt.setViewportSize({ width: 1280, height: 860 });
      check(wide.marked === 1 && wide.page <= wide.view, "on a phone (390 px) the Time page's RTC clash does not scroll the page sideways", JSON.stringify(wide));
      await pt.evaluate(() => saventp());
      check((await msgs(pt)).some((m) => m.includes("Not staged: GPIO 21 is used twice: Relay 1 and RTC SDA")) && !(await pt.evaluate(() => "rtc" in config.ntp)),
        "Save refuses the clashing RTC pin with the reason", JSON.stringify(await msgs(pt)));
      await pt.selectOption("#ajaxcontent #rtcsdapin", "18");
      const c2 = await clash();
      check(c2.marked.length === 0 && c2.banner === "" && c2.note === null, "a free SDA pin clears the marks at once", JSON.stringify(c2));
      await pt.evaluate(() => saventp());
      const staged = await pt.evaluate(() => config.ntp.rtc);
      check(JSON.stringify(staged) === JSON.stringify({ type: 1, sdapin: 18, sclpin: 22 }), "the RTC is staged as ntp.rtc {type, sdapin, sclpin}", JSON.stringify(staged));
      // Doors & Readers checks against the staged RTC pins
      await nav(pt, "hardware");
      await pt.waitForSelector("#ajaxcontent #openlockpin", { state: "attached" });
      await pt.waitForTimeout(300);
      await pt.selectOption("#ajaxcontent #openlockpin", "18");
      const hw = await pt.evaluate(() => ({
        marked: [...document.querySelectorAll("#ajaxcontent .field.pin-clash select")].map((e) => e.id),
        note: (document.querySelector("#ajaxcontent .pin-clash-msg") || {}).textContent || null,
        banner: isShown("hwproblem") ? document.getElementById("hwproblemtext").textContent : "",
        opt: document.querySelector('#wifipin option[value="18"]').textContent,
      }));
      check(JSON.stringify(hw.marked) === JSON.stringify(["openlockpin"]) && hw.note === "GPIO 18 is also RTC SDA" && hw.banner.includes("GPIO 18 is used twice: Open button and RTC SDA") &&
        hw.opt === "GPIO-18 — in use: Open button, RTC SDA", "Doors & Readers marks a pin the staged RTC uses, and its menus say so", JSON.stringify(hw));
      await pt.evaluate(() => savehardware());
      check((await msgs(pt)).some((m) => m.includes("Not staged: GPIO 18 is used twice: Open button and RTC SDA")) && (await pt.evaluate(() => config.hardware.openlockpin)) === 255,
        "Doors & Readers refuses to stage an exit button on the RTC's pin, with the reason", JSON.stringify(await msgs(pt)));
      await pt.selectOption("#ajaxcontent #openlockpin", "255");
      // the review names the RTC; Save & Reboot stores it (a restart: read at start only)
      await pt.click("#commit");
      await waitOpen(pt, "reviewmodal");
      const items = await pt.$$eval("#changelist li", (li) => li.map((x) => x.textContent));
      check(items.includes("Time: RTC module: (not set) → DS3231") && items.includes("Time: RTC SDA pin: (not set) → GPIO 18") && items.includes("Time: RTC SCL pin: (not set) → GPIO 22"),
        "the review names the RTC module and its pins", JSON.stringify(items));
      await pt.click("#savereboot");
      for (let i = 0; i < 20 && simR.state.savedConfigs.length === 0; i++) await pt.waitForTimeout(250);
      const sv = simR.state.savedConfigs.at(-1);
      check(sv && JSON.stringify(sv.ntp.rtc) === JSON.stringify({ type: 1, sdapin: 18, sclpin: 22 }) && simR.state.configSaves.at(-1).restart === true,
        "the RTC is saved and the save restarts the reader (the RTC is read at start only)", JSON.stringify([sv && sv.ntp, simR.state.configSaves.at(-1)]));
      check(ptErrors.length === 0, "RTC on the Time page: no JavaScript errors", JSON.stringify(ptErrors));
    } finally {
      await pt.close();
      await simR.close();
    }
  }

  console.log("user backup while another page opens");
  {
    // the backup and the open page shared one row list: opening the Event Log
    // during a backup put its events into the backup file
    const bkUsers = [];
    for (let i = 0; i < 120; i++) bkUsers.push({ uid: (0xb0000000 + i).toString(16), username: `Backup ${i}`, acctype: 1, acctype2: 0, acctype3: 0, acctype4: 0, validsince: 0, validuntil: 4102444800, pincode: i === 5 ? "1357" : "" });
    const bkEvents = [];
    for (let i = 0; i < 30; i++) bkEvents.push({ type: "INFO", src: "sys", desc: `bk event ${i}`, data: "", time: 1760000000 + i });
    const sim9 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Backup-Mix-2026", users: bkUsers, eventLines: bkEvents });
    const pb = await context.newPage();
    const pbErrors = [];
    pb.on("pageerror", (e) => pbErrors.push(String(e)));
    try {
      await pb.goto(`http://127.0.0.1:${sim9.port}/`);
      await pb.waitForSelector("#signin[open]", { timeout: 10000 });
      await pb.fill("#password", "Backup-Mix-2026");
      await pb.click("#signin button[type=submit]");
      await pb.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice, null, { timeout: 10000 });
      await nav(pb, "backup");
      await pb.waitForSelector("#ajaxcontent [data-onclick=\"backupuser\"]", { state: "visible" });
      await pb.waitForTimeout(300);
      // the file the page saves (the browser keeps downloads in its own /tmp)
      await pb.evaluate(() => { window.__saved = []; const orig = saveLogfile; saveLogfile = function(obj, a, f) { window.__saved.push({ f, obj: JSON.parse(JSON.stringify(obj)) }); return orig.apply(this, arguments); }; });
      sim9.state.userlistDelayMs = 400; // three pages: the Event Log opens while they come in
      const dl = pb.waitForEvent("download", { timeout: 15000 });
      await pb.click("#ajaxcontent [data-onclick=\"backupuser\"]");
      await pb.waitForTimeout(150);
      await nav(pb, "eventlog");
      await dl;
      const list = (await pb.evaluate(() => window.__saved.at(-1).obj)).list;
      const uids = list.map((u) => u.uid);
      check(list.length === 120 && new Set(uids).size === 120 && uids.every((u) => /^b00000/.test(u)) && list.every((u) => !("desc" in u)) && (list.find((u) => u.uid === "b0000005") || {}).pincode === "1357",
        "a user backup with the Event Log opened during it holds exactly the users, no events", JSON.stringify({ n: list.length, first: list[0], stray: list.filter((u) => !/^b00000/.test(u.uid || "")).slice(0, 2) }));
      // event log rows are the device's lines, as text
      await pb.waitForFunction(() => document.getElementById("loading-img") && document.getElementById("loading-img").style.display === "none" && data.length > 0, null, { timeout: 15000 }).catch(() => {});
      const ev = await pb.evaluate(() => data.filter((l) => typeof l === "string" && JSON.parse(l).desc.startsWith("bk event")).length);
      check(ev === 30, "the Event Log opened during the backup still loads all its events", String(ev));
      // the Users page opened during a backup loads once the backup ends
      await nav(pb, "backup");
      await pb.waitForSelector("#ajaxcontent [data-onclick=\"backupuser\"]", { state: "visible" });
      await pb.waitForTimeout(300);
      const dl2 = pb.waitForEvent("download", { timeout: 15000 });
      await pb.click("#ajaxcontent [data-onclick=\"backupuser\"]");
      await pb.waitForTimeout(150);
      await nav(pb, "users");
      await dl2;
      const list2 = (await pb.evaluate(() => window.__saved.at(-1).obj)).list;
      await pb.waitForFunction(() => usersView.loaded && data.length === 120, null, { timeout: 15000 }).catch(() => {});
      const shown = await pb.evaluate(() => ({ n: data.length, pins: data.filter((u) => u && "pincode" in u).length }));
      check(list2.length === 120 && shown.n === 120 && shown.pins === 0,
        "the Users page opened during a backup loads after it, without the backup's PINs", JSON.stringify({ file: list2.length, shown }));
      check(pbErrors.length === 0, "backup while paging: no JavaScript errors", JSON.stringify(pbErrors));
    } finally {
      await pb.close();
      await sim9.close();
    }
  }

  console.log("host check and login nonces");
  {
    // DNS rebinding: another site's name for the device gets 421; its IP,
    // 192.168.4.1 and its name still work. A /login flood from one address
    // cannot evict another address's nonce between challenge and answer.
    const sim10 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Host-Check-2026" });
    const get = (pathname, host, localAddress) => new Promise((resolve, reject) => {
      const rq = http.request({ host: "127.0.0.1", port: sim10.port, path: pathname, headers: host ? { Host: host } : {}, localAddress }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body }));
      });
      rq.on("error", reject);
      rq.end();
    });
    const md5h = (t) => crypto.createHash("md5").update(t).digest("hex");
    const answer = (challenge) => {
      const f = (k) => (new RegExp(k + "=\"([^\"]*)\"").exec(challenge) || [])[1];
      const nonce = f("nonce"), opaque = f("opaque"), realm = f("realm"), cnonce = "0a1b2c3d", nc = "00000001";
      const response = md5h(`${adminHa1("Host-Check-2026")}:${nonce}:${nc}:${cnonce}:auth:${md5h("GET:/login")}`);
      return `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="/login", algorithm=MD5, response="${response}", opaque="${opaque}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    };
    const loginWith = (auth, localAddress) => new Promise((resolve, reject) => {
      const rq = http.request({ host: "127.0.0.1", port: sim10.port, path: "/login", headers: { Authorization: auth }, localAddress }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode, body }));
      });
      rq.on("error", reject);
      rq.end();
    });
    try {
      const evil = await get("/", "evil.example");
      const evilPort = await get("/login", `rebind.example:${sim10.port}`);
      check(evil.status === 421 && evilPort.status === 421, "a request naming another site in Host is refused (421), the login included", JSON.stringify([evil.status, evilPort.status]));
      const byIp = await get("/", `127.0.0.1:${sim10.port}`), byAp = await get("/", "192.168.4.1"), byName = await get("/", "ironframe-rfid.local"), bare = await get("/", "IronFrame-RFID");
      check([byIp, byAp, byName, bare].every((r) => r.status === 200), "the device's IP, 192.168.4.1, its name and name.local are served", JSON.stringify([byIp.status, byAp.status, byName.status, bare.status]));
      // a WebSocket with a valid session but another site's name is refused too
      const first = await get("/login");
      const ok = await loginWith(answer(first.headers["www-authenticate"]));
      const token = ok.status === 200 ? JSON.parse(ok.body).token : "";
      const wsTry = (host) => new Promise((resolve) => {
        const w = new WebSocket(`ws://127.0.0.1:${sim10.port}/ws?token=${token}`, { headers: { Host: host } });
        w.on("open", () => { w.close(); resolve("open"); });
        w.on("error", () => resolve("refused"));
        w.on("unexpected-response", () => resolve("refused"));
      });
      const wsEvil = await wsTry("evil.example"), wsGood = await wsTry(`127.0.0.1:${sim10.port}`);
      check(ok.status === 200 && wsEvil === "refused" && wsGood === "open", "the WebSocket is refused for another site's name, accepted by IP", JSON.stringify({ login: ok.status, wsEvil, wsGood }));
      // the flood: 127.0.0.2 asks for 30 challenges between 127.0.0.1's challenge and its answer
      const mine = await get("/login");
      for (let i = 0; i < 30; i++) await get("/login", undefined, "127.0.0.2");
      const after = await loginWith(answer(mine.headers["www-authenticate"]));
      check(mine.status === 401 && after.status === 200 && sim10.state.nonces.size <= 8,
        "a /login flood from one address does not break another address's login", JSON.stringify({ status: after.status, nonces: sim10.state.nonces.size }));
    } finally {
      await sim10.close();
    }
  }

  console.log("save path keeps the work");
  {
    const sim5 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Keep-Work-2026" });
    const pk = await context.newPage();
    const pkErrors = [], pkDialogs = [];
    pk.on("pageerror", (e) => pkErrors.push(String(e)));
    pk.on("dialog", (d) => { pkDialogs.push(d.message()); d.accept(); });
    try {
      await pk.goto(`http://127.0.0.1:${sim5.port}/`);
      await pk.waitForSelector("#signin[open]", { timeout: 10000 });
      await pk.fill("#password", "Keep-Work-2026");
      await pk.click("#signin button[type=submit]");
      await pk.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice, null, { timeout: 10000 });
      // a 7-character hotspot password: the device would refuse it
      await nav(pk, "network");
      await pk.waitForSelector("#ajaxcontent #wmodeap", { state: "attached" });
      await pk.waitForTimeout(300);
      await pickRadio(pk, "wmode", "1"); // Hotspot
      await pk.fill("#ajaxcontent #wifipass", "1234567");
      await savePageClose(pk, "network");
      await pk.waitForTimeout(300);
      const pageSave = await pk.evaluate(() => ({ wmode: config.network.wmode, pass: config.network.pswd, unsaved: !document.querySelector(".footer").hidden }));
      const pkMsgs = await msgs(pk);
      check(pkDialogs.length === 0 && pkMsgs.some((d) => d.includes("Access point password must be empty (open) or 8-63 characters")) && pageSave.wmode === 0 && pageSave.pass === "********" && !pageSave.unsaved,
        "a refused Save on a settings page stages nothing (the bad values stayed staged)", JSON.stringify([pkMsgs, pageSave]));
      // settings staged without a page's Save (a restored backup) are checked in the review
      await navAsk(pk, "backup");
      check(await leaveIfAsked(pk), "the refused values are still on the page: leaving asks first");
      await pk.waitForSelector("#ajaxcontent #restoreSet", { state: "attached" });
      await pk.waitForTimeout(300);
      const badBackup = await pk.evaluate(() => { const c = JSON.parse(JSON.stringify(savedConfig)); c.network.wmode = 1; c.network.pswd = "1234567"; return JSON.stringify(c); });
      await pk.setInputFiles("#ajaxcontent #restoreSet", { name: "settings.json", mimeType: "application/json", buffer: Buffer.from(badBackup) });
      await confirmYes(pk);
      await pk.waitForFunction(() => !document.querySelector(".footer").hidden, null, { timeout: 5000 });
      await pk.click("#commit");
      await pk.waitForSelector("#reviewmodal[open]");
      const review = await pk.evaluate(() => ({ problem: isShown("reviewproblem") ? document.getElementById("reviewproblem").textContent : "", disabled: document.getElementById("savereboot").disabled }));
      check(review.problem.includes("Access point password must be empty (open) or 8-63 characters") && review.disabled && !sim5.state.counts.configfile,
        "the review shows why the device would refuse the settings, and nothing is sent", JSON.stringify(review));
      await pk.click("#reviewmodal .dlg-head [data-close]");
      await pk.waitForFunction(() => !document.querySelector("#reviewmodal[open]"));
      await nav(pk, "network");
      await pk.waitForSelector("#ajaxcontent #wmodeap", { state: "attached" });
      await pk.waitForTimeout(300);
      await pk.fill("#ajaxcontent #wifipass", "long-enough-1");
      await savePageClose(pk, "network");
      await nav(pk, "general");
      await pk.waitForSelector("#ajaxcontent #hostname", { state: "visible" });
      await pk.waitForTimeout(300);
      await pk.fill("#ajaxcontent #hostname", "kept-name");
      await savePageClose(pk, "general");
      // Backup Settings with a change staged: the file is the device's stored settings
      await nav(pk, "backup");
      await pk.waitForSelector("#ajaxcontent [data-onclick=\"backupset\"]", { state: "visible" });
      await pk.waitForTimeout(300);
      const getconfsBefore = sim5.state.counts.getconf || 0;
      const [download] = await Promise.all([pk.waitForEvent("download", { timeout: 5000 }), pk.click("#ajaxcontent [data-onclick=\"backupset\"]")]);
      // the file's content is the data: URL the page handed the browser
      const backedUp = await pk.evaluate(() => JSON.parse(decodeURIComponent(document.getElementById("downloadSet").getAttribute("href").replace(/^data:[^,]*,/, ""))));
      const bkMsgs = await msgs(pk);
      const bkPage = await pk.evaluate(() => ({ host: config.general.hostnm, unsaved: !document.querySelector(".footer").hidden }));
      check(download.suggestedFilename() === "ironframe-rfid-settings.json" && backedUp.command === "configfile" && backedUp.general.hostnm === "ironframe-rfid" &&
        backedUp.general.pswd === "********" && (sim5.state.counts.getconf || 0) === getconfsBefore + 1,
        "Backup Settings saves the device's stored settings (asked for with getconf, passwords masked), not the staged copy", JSON.stringify([download.suggestedFilename(), backedUp.general]));
      check(bkMsgs.some((m) => m.includes("not your unsaved changes")) && bkPage.host === "kept-name" && bkPage.unsaved,
        "a backup taken with changes staged says it holds the saved settings, and the staged changes are kept", JSON.stringify([bkMsgs, bkPage]));
      await nav(pk, "general");
      await pk.waitForSelector("#ajaxcontent #hostname", { state: "visible" });
      await pk.waitForTimeout(300);
      // the device refuses for a reason the page cannot know
      sim5.state.refuseConfig = "Settings storage is full";
      await pk.click("#commit");
      await pk.waitForSelector("#reviewmodal[open]");
      await pk.click("#savereboot");
      await pk.waitForSelector("#progressclose", { state: "visible", timeout: 10000 });
      const refused = await pk.evaluate(() => ({
        msg: document.getElementById("progressmsg").textContent, app: !!document.getElementById("sidebar") && !!document.querySelector("#ajaxcontent #hostname"),
        host: config.general.hostnm, pass: config.network.pswd, ap: config.network.wmode, unsaved: !document.querySelector(".footer").hidden,
      }));
      check(refused.msg.includes("Settings storage is full") && refused.app,
        "a refused Save & Reboot shows the device's reason over the app, which stays (it was replaced by a dead page)", JSON.stringify(refused));
      check(refused.host === "kept-name" && refused.pass === "long-enough-1" && refused.ap === 1 && refused.unsaved,
        "a refused save keeps every staged change", JSON.stringify(refused));
      await settle(pk); await pk.screenshot({ path: path.join(shotDir, "10-save-refused.png") });
      await pk.click("#progressclose");
      await pk.waitForFunction(() => !document.querySelector("#progressmodal[open]"));
      await pk.click("#commit");
      await pk.waitForSelector("#reviewmodal[open]");
      await pk.click("#savereboot");
      for (let i = 0; i < 20 && sim5.state.savedConfigs.length === 0; i++) await pk.waitForTimeout(250);
      const sv = sim5.state.savedConfigs.at(-1) || {};
      check(sv.general && sv.general.hostnm === "kept-name" && sv.network.wmode === 1 && sv.network.pswd === "long-enough-1",
        "after the refusal the same staged changes save on the next try", JSON.stringify(sv.network));
      await pk.waitForFunction(() => /restarting/.test(document.getElementById("updateproglabel").textContent), null, { timeout: 5000 });
      const after = await pk.evaluate(() => ({ bar: document.getElementById("updateproglabel").textContent, href: document.querySelector("#reconnect a").getAttribute("href"), origin: location.origin }));
      check(after.bar === "Saved, restarting..." && after.href === after.origin + "/",
        "after the save the overlay says Saved, restarting and links to this origin (not http://<host>.local)", JSON.stringify(after));
      await pk.evaluate(() => { window.__beforeRestart = 1; });
      sim5.restart(); // the board reboots: connection dropped, sessions gone
      await pk.waitForSelector("#signin[open]", { timeout: 20000 });
      check(await pk.evaluate(() => window.__beforeRestart === undefined),
        "once the device answers again the page reloads by itself and asks for the password");
      check(pkErrors.length === 0, "save path: no JavaScript errors", JSON.stringify(pkErrors));
    } finally {
      await pk.close();
      await sim5.close();
    }
  }

  console.log("save without a restart (live settings)");
  {
    // A save that changes only settings the firmware applies at once (door
    // name, unlock time, opening hours ...: core/livesettings.h) is answered
    // restart:false: nothing restarts, the page stays signed in. A pin change
    // still restarts the reader, and the page asks for the password again.
    // (The simulated device's stored settings predate the reader1/reader2
    // keys the Hardware page writes, so the first Hardware save restarts in
    // any case: the pin change goes first.)
    const sim7 = await startSim({ webhDir: path.join(repo, "src", "webh"), password: "Live-Save-2026" });
    const pl = await context.newPage();
    const plErrors = [], plDialogs = [], plFrames = [];
    pl.on("pageerror", (e) => plErrors.push(String(e)));
    pl.on("dialog", (d) => { plDialogs.push(d.message()); d.accept(); });
    pl.on("websocket", (ws) => ws.on("framereceived", (f) => { try { plFrames.push(JSON.parse(String(f.payload))); } catch (e) {} }));
    const lastAnswer = () => plFrames.filter((f) => f.resultof === "configfile").at(-1) || {};
    const openHardware = async () => {
      await pl.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && configFromDevice, null, { timeout: 10000 });
      await pl.waitForSelector("#systemnamedevice:not(:empty)", { timeout: 10000 });
      await nav(pl, "hardware");
      await pl.waitForSelector("#ajaxcontent #doorname", { state: "visible" });
      await pl.waitForTimeout(300);
    };
    const stageAndReview = async () => {
      await savePageClose(pl, "hardware");
      await pl.waitForTimeout(300);
      await pl.click("#commit");
      await waitOpen(pl, "reviewmodal");
      return pl.evaluate(() => ({ items: [...document.querySelectorAll("#changelist li")].map((l) => l.textContent), btn: document.getElementById("savereboot").textContent.trim(), disabled: document.getElementById("savereboot").disabled, note: document.getElementById("reviewnote").textContent }));
    };
    try {
      await pl.goto(`http://127.0.0.1:${sim7.port}/`);
      await signIn(pl, "Live-Save-2026");
      await openHardware();

      // a pin change: Save & Reboot, the device restarts
      const pin = await pl.evaluate(() => {
        const used = new Set([4, 5, 10, 18, 21, 255].map(String));
        const o = [...document.querySelectorAll("#ajaxcontent #gpiorly option")].find((x) => !used.has(x.value));
        return o ? o.value : null;
      });
      await pl.selectOption("#ajaxcontent #gpiorly", pin);
      const rv1 = await stageAndReview();
      await pl.evaluate(() => { window.__beforeSave = 1; });
      await pl.click("#savereboot");
      for (let i = 0; i < 40 && sim7.state.savedConfigs.length === 0; i++) await pl.waitForTimeout(100);
      await pl.waitForFunction(() => /restarting/.test(document.getElementById("updateproglabel").textContent), null, { timeout: 5000 }).catch(() => {});
      const answer1 = lastAnswer();
      const sv1 = sim7.state.savedConfigs.at(-1) || {};
      const shown1 = await pl.evaluate(() => document.getElementById("updateproglabel").textContent);
      check(rv1.btn === "Save & Reboot" && !rv1.disabled && rv1.items.some((t) => t.startsWith("Hardware: Relay pin (relay 1): GPIO 21 → GPIO " + pin)) &&
        answer1.result === true && answer1.restart === true && sv1.hardware && String(sv1.hardware.rpin) === pin &&
        sim7.state.configSaves.at(-1).restart === true && shown1 === "Saved, restarting...",
        "a pin change still asks for Save & Reboot and the device answers restart:true", JSON.stringify({ rv1, answer1, pin, shown1 }));
      sim7.restart(); // the board reboots: connection dropped, sessions gone
      await waitOpen(pl, "signin", 20000).catch(() => {});
      const back = await pl.evaluate(() => ({ reloaded: window.__beforeSave === undefined, signin: document.getElementById("signin").open, token: sessionToken }));
      check(back.reloaded && back.signin && back.token === "" && sim7.state.restarts === 1,
        "after a pin change the device restarts and the page asks to sign in again", JSON.stringify(back));

      // a door name: Save, applied at once
      await signIn(pl, "Live-Save-2026");
      await openHardware();
      await pl.fill("#ajaxcontent #doorname", "Front door");
      const rv = await stageAndReview();
      check(rv.btn === "Save" && !rv.disabled && rv.note.includes("without a restart") && rv.items.length === 1 && rv.items[0] === "Hardware: Door name (relay 1): Door → Front door",
        "the review offers Save (not Save & Reboot) for live-only changes", JSON.stringify(rv));
      const tokenBefore = await pl.evaluate(() => { window.__beforeLive = 1; return sessionToken; });
      const savesBefore = sim7.state.savedConfigs.length;
      await pl.click("#savereboot");
      await pl.waitForFunction(() => [...document.querySelectorAll("#msgarea .msgtext")].some((m) => m.textContent.startsWith("Saved.")), null, { timeout: 10000 }).catch(() => {});
      await waitClosed(pl, "progressmodal", 10000).catch(() => {});
      await pl.waitForTimeout(1500); // long enough for a reload or a sign-in to show, if one were coming
      const answer = lastAnswer();
      const sv = sim7.state.savedConfigs.at(-1) || {};
      check(answer.result === true && answer.restart === false && sim7.state.savedConfigs.length === savesBefore + 1 && sv.hardware && sv.hardware.doorname === "Front door" &&
        sim7.state.configSaves.at(-1).restart === false && sim7.state.liveApplies === 1 && !sim7.state.restartPending && sim7.state.restarts === 1,
        "a live-only save (door name) answers restart:false and the device applies it without a restart", JSON.stringify({ answer, saves: sim7.state.configSaves }));
      const live = await pl.evaluate(() => ({ same: window.__beforeLive === 1, token: sessionToken, stored: sessionStorage.getItem("ifrfid-token"), ws: wsConnectionPresent, signin: document.getElementById("signin").open, progress: document.getElementById("progressmodal").open, rebooting }));
      check(live.same && live.token === tokenBefore && live.stored === tokenBefore && live.ws && !live.signin && !live.progress && !live.rebooting && sim7.state.tokens.size >= 1,
        "a live-only save keeps the session: no reload, no sign-in", JSON.stringify(live));
      const after = await pl.evaluate(() => ({ bar: !document.querySelector(".footer").hidden, msgs: [...document.querySelectorAll("#msgarea .msgtext")].map((m) => m.textContent), saved: savedConfig.hardware.doorname, page: !!document.querySelector("#ajaxcontent #doorname") }));
      check(!after.bar && after.msgs.some((m) => m.startsWith("Saved.") && m.includes("no restart")) && after.saved === "Front door" && after.page,
        "after a live-only save the save bar is hidden and the page says Saved", JSON.stringify(after));
      await settle(pl); await pl.screenshot({ path: path.join(shotDir, "11-live-save.png") });
      check(plErrors.length === 0 && plDialogs.length === 0, "live save: no JavaScript errors and no blocking dialogs", JSON.stringify([plErrors, plDialogs]));
    } finally {
      await pl.close();
      await sim7.close();
    }
  }

  console.log("restore settings on a fresh device");
  {
    const sim6 = await startSim({ webhDir: path.join(repo, "src", "webh"), chip: "esp32", password: "Restore-Pass-2026", config: null });
    const pr = await context.newPage();
    const prErrors = [];
    pr.on("pageerror", (e) => prErrors.push(String(e)));
    try {
      await pr.goto(`http://127.0.0.1:${sim6.port}/`);
      await pr.waitForSelector("#signin[open]", { timeout: 10000 });
      await pr.fill("#password", "Restore-Pass-2026");
      await pr.click("#signin button[type=submit]");
      await pr.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && ajaxobj && ajaxobj.chip === "esp32", null, { timeout: 10000 });
      await nav(pr, "backup");
      await pr.waitForSelector("#ajaxcontent #restoreSet", { state: "attached" });
      await pr.waitForTimeout(300);
      const restoreFile = (obj) => pr.setInputFiles("#ajaxcontent #restoreSet", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(obj)) });
      await restoreFile({ type: "esp-rfid-userbackup", version: "v0.6", list: [] });
      await pr.waitForTimeout(500);
      const wrong = { msgs: await msgs(pr), confirm: await pr.isVisible("#confirmmodal[open]"), unsaved: await pr.isVisible(".footer") };
      check(wrong.msgs.some((m) => m.includes("this is a user backup")) && !wrong.confirm && !wrong.unsaved,
        "a file that is not a settings backup is reported, not silently ignored", JSON.stringify(wrong));
      // a user backup with users the device now refuses: those are skipped and named, the rest restored
      const restoreUsers = async (list) => {
        await pr.setInputFiles("#ajaxcontent #restoreUser", { name: "users.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ type: "esp-rfid-userbackup", version: "v0.6", list })) });
        await confirmYes(pr);
        await pr.waitForSelector("#restoreclose", { state: "visible", timeout: 10000 });
        // the progress bar (#dynamic) and its text (#restorestate)
        const shown = await pr.evaluate(() => ({ bar: document.getElementById("restorestate").textContent, cls: document.getElementById("dynamic").className, skipped: document.getElementById("restoreskipped").textContent }));
        await pr.click("#restoreclose");
        await pr.waitForFunction(() => !document.querySelector("#restoremodal[open]"));
        return shown;
      };
      const ru = (uid, extra) => ({ uid, username: "R " + uid, acctype: 1, validsince: 0, validuntil: 4102444800, pincode: "", ...extra });
      const before = sim6.state.storedUsers.length;
      const skip = await restoreUsers([ru("aa01"), ru("aa02", { pincode: "12" }), ru("aa03"), ru("aa04", { username: "x".repeat(65) })]);
      check(sim6.state.storedUsers.length - before === 2 && sim6.state.storedUsers.map((u) => u.uid).join().includes("aa01,aa03"),
        "a user restore skips the users the device refuses and restores the rest", JSON.stringify(sim6.state.storedUsers.map((u) => u.uid)));
      check(skip.bar.includes("2 restored, 2 skipped") && skip.cls.includes("warning") && skip.skipped.includes("aa02 (R aa02): PIN must be 4-12 digits") && skip.skipped.includes("aa04") && skip.skipped.includes("too long") && !skip.skipped.includes("aa01"),
        "the restore says how many users were skipped and which, with the reason", JSON.stringify(skip));
      sim6.state.refuseUserfile = "Failed to save user"; // a storage failure is not the user's fault: the restore stops
      const stop = await restoreUsers([ru("bb01"), ru("bb02")]);
      check(stop.cls.includes("danger") && stop.bar.includes("Failed to save user") && !sim6.state.storedUsers.some((u) => u.uid === "bb02") && stop.skipped === "",
        "a restore still stops at a user the device could not store", JSON.stringify(stop));
      // Backup Users asks for the PINs: the user list carries them for a backup only
      sim6.state.users.push({ uid: "cc01", username: "Pin User", acctype: 1, acctype2: 0, acctype3: 0, acctype4: 0, validsince: 0, validuntil: 4102444800, pincode: "2468" });
      sim6.state.userlistRequests = [];
      await pr.evaluate(() => { window.__saved = []; const orig = saveLogfile; saveLogfile = function(obj, a, f) { window.__saved.push({ f, obj: JSON.parse(JSON.stringify(obj)) }); return orig.apply(this, arguments); }; });
      await Promise.all([pr.waitForEvent("download", { timeout: 10000 }), pr.evaluate(() => backupuser())]);
      const bkList = (await pr.evaluate(() => window.__saved.at(-1).obj)).list;
      const bk = { reqs: sim6.state.userlistRequests, pin: (bkList.find((u) => u.uid === "cc01") || {}).pincode };
      check(bk.reqs.length > 0 && bk.reqs.every((r) => r.backup) && bk.pin === "2468",
        "Backup Users asks for the PINs and gets them", JSON.stringify(bk));
      const pins = { wifipin: 255, doorstatpin: 255, doorbellpin: 255, openlockpin: 255, accessdeniedpin: 255, beeperpin: 255, ledwaitingpin: 255 };
      const backup = {
        command: "configfile",
        network: { ssid: "site-wifi", pswd: "********", wmode: 0, dhcp: 1, bssid: "", hide: 0, idleoff: 0, idlemins: 15, fallbackmode: 0, apip: "192.168.4.1", apsubnet: "255.255.255.0", ip: "", subnet: "", gateway: "", dns: "" },
        hardware: { readertype: 1, wgd0pin: 34, wgd1pin: 35, rdm6300pin: 255, sspin: 255, rfidgain: 32, rpin: 16, rtype: 1, ltype: 0, rtime: 3000, doorname: "Front", numrelays: 2,
          relay2: { rpin: 17, rtype: 1, ltype: 0, rtime: 4000, doorname: "Back" }, ...pins, maxOpenDoorTime: 0, useridstoragemode: "hexadecimal", removeparitybits: 1, requirepincodeafterrfid: 0, allowpincodeonly: 0,
          reader1: { door: 0, ledpin: 25, beeperpin: 26, feedbackactivehigh: 1 }, reader2: { enabled: 1, wgd0pin: 32, wgd1pin: 33, door: 1, ledpin: 27, beeperpin: 14, feedbackactivehigh: 1 } },
        general: { hostnm: "restored-door", restart: 0, pswd: "********", logging: 1, openinghours: Array(7).fill("000000001111111111000000") },
        mqtt: { enabled: 0, host: "", port: 1883, topic: "", autotopic: 0, user: "", pswd: "********", syncrate: 180, mqttlog: 0, mqttha: 0, remoteadmin: 0 },
        ntp: { server: "pool.ntp.org", interval: 30, tzinfo: "GMT+0BST-1,M3.5.0/01:00:00,M10.5.0/02:00:00" },
      };
      await restoreFile(backup);
      await confirmYes(pr);
      await pr.waitForSelector(".footer", { state: "visible", timeout: 5000 });
      await pr.click("#commit");
      await pr.waitForSelector("#reviewmodal[open]");
      await pr.click("#savereboot");
      for (let i = 0; i < 20 && sim6.state.savedConfigs.length === 0; i++) await pr.waitForTimeout(250);
      const sv = sim6.state.savedConfigs[0] || {};
      check(sv.general && sv.general.hostnm === "restored-door" && sv.general.openinghours[0] === "000000001111111111000000" && sv.hardware.relay2.rtime === 4000 && sv.hardware.reader2.wgd0pin === 32 && sv.ntp.tzinfo === backup.ntp.tzinfo,
        "a settings backup restored on a fresh device is what gets saved", JSON.stringify(sv.general));
      check(sv.general && sv.general.pswd === adminHa1("Restore-Pass-2026") && sv.network.pswd === undefined && sv.mqtt.pswd === undefined,
        "the restore keeps the device's admin password and stores no masked ******** as a Wi-Fi or MQTT password", JSON.stringify([sv.general && sv.general.pswd, sv.network && sv.network.pswd, sv.mqtt && sv.mqtt.pswd]));
      check(prErrors.length === 0, "restore: no JavaScript errors", JSON.stringify(prErrors));
    } finally {
      await pr.close();
      await sim6.close();
    }
  }

  console.log("esp32 two-door board");
  const sim2 = await startSim({
    webhDir: path.join(repo, "src", "webh"), chip: "esp32", password: "Bench-Pass-2026", config: null,
    latestLines: [
      { uid: "a1b2c3", username: "Alice", acctype: 1, access: 1, timestamp: 1760000000, door: "Door 1" },
      { uid: "a1b2c3", username: "Alice", acctype: 1, access: 1, timestamp: 1760000050, door: "Door 1", dir: "out" },
      { uid: "d4e5f6", username: "Bob", acctype: 0, access: 0, timestamp: 1760000100, door: "Door 2" },
    ],
  });
  try {
    const pg = await context.newPage();
    const pgErrors = [];
    const pgDialogs = [];
    pg.on("pageerror", (e) => pgErrors.push(String(e)));
    pg.on("dialog", (d) => { pgDialogs.push(d.message()); d.accept(); });
    const base2 = `http://127.0.0.1:${sim2.port}`;
    await pg.goto(base2 + "/");
    await pg.waitForSelector("#signin[open]", { timeout: 10000 });
    await pg.fill("#password", "Bench-Pass-2026");
    await pg.click("#signin button[type=submit]");
    await pg.waitForFunction(() => typeof wsConnectionPresent !== "undefined" && wsConnectionPresent === true && ajaxobj && ajaxobj.chip === "esp32", null, { timeout: 10000 });
    // before any save: Test must not drive anything, and must say why
    await pg.evaluate(() => testRelay(1));
    await pg.waitForTimeout(400);
    check(sim2.state.relayTests.length === 0 && (await msgs(pg)).some((d) => d.includes("no pin yet")), "fresh device: Test drives no relay and says the relay has no pin yet", JSON.stringify(await msgs(pg)));
    // first save straight from the Network page, before Hardware was ever
    // opened: the built-in defaults put Wiegand D1 on GPIO5, which the ESP32
    // refuses, so this failed on a real board until the chip preset was
    // applied as soon as the device reported its chip
    await pg.evaluate(() => withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}));
    await pg.waitForTimeout(500);
    check(sim2.state.rejectedConfigs.length === 0 && sim2.state.savedConfigs.length === 1,
      "fresh ESP32 device: the first save from the Network page is accepted (chip preset applied on status)",
      JSON.stringify(sim2.state.rejectedConfigs));
    await nav(pg, "updatelink");
    await waitOpen(pg, "update");
    const upText = await pg.textContent("#update .dlg-body p");
    check(/ironframe-rfid-<version>\.bin/.test(upText) && !/esp32s3\.bin/.test(upText), "ESP32 board: Update asks for the release file ironframe-rfid-<version>.bin", upText);
    // the page checks the file before sending it
    const pick = async (name, buffer) => {
      await pg.setInputFiles("#binform", { name, mimeType: "application/octet-stream", buffer });
      await pg.waitForTimeout(300);
      return pg.evaluate(() => ({ check: isShown("upcheck") ? document.getElementById("upcheck").textContent : "", disabled: document.getElementById("upbtn").disabled }));
    };
    const pFull = await pick("ironframe-rfid-1.4.0-full-flash.bin", imageHead(0));
    check(pFull.disabled && pFull.check.includes("full-flash image"), "Update refuses a file named -full-flash before uploading", JSON.stringify(pFull));
    const pS3 = await pick("esp32s3.bin", imageHead(9));
    check(pS3.disabled && pS3.check.includes("another chip, not the ESP32 (WROOM)"), "Update refuses an image for another chip before uploading", JSON.stringify(pS3));
    const pJunk = await pick("notes.bin", Buffer.from("not a firmware image at all, just text"));
    check(pJunk.disabled && pJunk.check.includes("0xE9"), "Update refuses a file that does not start with 0xE9", JSON.stringify(pJunk));
    const pBig = await pick("ironframe-rfid-1.4.0.bin", imageHead(0, true, 2200001));
    check(pBig.disabled && pBig.check.includes("larger than the update slot"), "Update refuses an image larger than the update slot", JSON.stringify(pBig));
    const pGood = await pick("ironframe-rfid-1.4.0.bin", imageHead(0));
    check(!pGood.disabled && pGood.check === "", "a good image for this chip can be uploaded (positive control)", JSON.stringify(pGood));
    sim2.state.updateFlashError = "Not Enough Space";
    await pg.click("#upbtn");
    await pg.waitForSelector("#progressclose", { state: "visible", timeout: 10000 });
    const upFail = await pg.evaluate(() => document.getElementById("progressmsg").textContent);
    sim2.state.updateFlashError = null;
    check(upFail === "Firmware update failed: Writing the image failed: Not Enough Space", "a failed update shows the device's reason", upFail);
    await pg.click("#progressclose");
    await pg.waitForFunction(() => !document.querySelector("#progressmodal[open]"));
    await nav(pg, "updatelink");
    await waitOpen(pg, "update");
    await pg.click("#update .dlg-head [data-close]");
    await waitClosed(pg, "update");
    await nav(pg, "hardware");
    await pg.waitForSelector("#ajaxcontent #r2enabled", { state: "attached" });
    await pg.waitForFunction(() => document.querySelector("#ajaxcontent #gpiorly2") !== null, null, { timeout: 10000 });
    const hw = await pg.evaluate(() => {
      const opts = (id) => [...document.querySelectorAll(`#ajaxcontent #${id} option`)].map((o) => Number(o.value));
      const v = (id) => document.querySelector(`#ajaxcontent #${id}`).value;
      return {
        relayOpts: opts("gpiorly"), d0Opts: opts("wg0pin"),
        rpin: v("gpiorly"), rpin2: v("gpiorly2"), numr: v("numrlys"), wg0: v("wg0pin"), wg1: v("wg1pin"),
        r2on: document.querySelector("#ajaxcontent #r2enabled").value === "1", r2d0: v("r2wg0pin"), r2d1: v("r2wg1pin"),
        r1door: v("r1door"), r2door: v("r2door"), r1led: v("r1ledpin"), r2buz: v("r2beeperpin"),
      };
    });
    check(hw.relayOpts.includes(16) && hw.relayOpts.includes(17) && hw.relayOpts.includes(25), "ESP32 board: relay menu offers GPIO 16/17/25");
    check(![6, 7, 8, 9, 10, 11, 12, 0, 2, 5, 15, 1, 3].some((p) => hw.relayOpts.includes(p) || hw.d0Opts.includes(p)), "ESP32 board: flash, strapping and serial pins are not offered", JSON.stringify(hw.d0Opts));
    check(hw.d0Opts.includes(34) && !hw.relayOpts.includes(34), "ESP32 board: input-only GPIO34 offered for reader data, not for relays");
    check(hw.rpin === "16" && hw.rpin2 === "17" && hw.numr === "2", "fresh ESP32 device: relays preset to GPIO16/17 (VOANZO board)", JSON.stringify(hw));
    check(hw.wg0 === "34" && hw.wg1 === "35" && hw.r2on && hw.r2d0 === "32" && hw.r2d1 === "33", "fresh ESP32 device: two Wiegand readers preset (34/35 and 32/33, edge header)");
    check(hw.r1door === "0" && hw.r2door === "1" && hw.r1led === "25" && hw.r2buz === "14", "reader 1 opens door 1, reader 2 opens door 2, LED/buzzer lines preset");
    // a new board: both doors Locked when the relay is on (maglock on NO, released if the controller fails)
    {
      const first = sim2.state.savedConfigs[0].hardware;
      const page = await pg.evaluate(() => ({ h1: document.getElementById("holdrly").value, h2: document.getElementById("holdrly2").value,
        label: document.querySelector('label[for="holdrly"]').textContent.trim(), opts: [...document.querySelectorAll("#holdrly option")].map((o) => o.textContent),
        typeHelp: document.querySelector('label[for="typerly"] + .help').getAttribute("data-content") }));
      check(first.rhold === 1 && first.relay2.rhold === 1 && page.h1 === "1" && page.h2 === "1",
        "a new ESP32 board defaults both doors to Locked when the relay is on (saved rhold 1)", JSON.stringify({ first: [first.rhold, first.relay2.rhold], page }));
      check(page.label === "When the relay is on, the door is" && JSON.stringify(page.opts) === JSON.stringify(["Unlocked (electric strike, or maglock on NC)", "Locked (maglock on NO: released if the controller fails or loses power)"]) &&
        page.typeHelp.startsWith("The pin level that switches this board's relay on (the VOANZO board: Active High)."),
        "the door setting is worded as decided, and Relay type is the pin level that switches the relay on", JSON.stringify(page));
      await pg.evaluate(() => { window.__hwBefore = JSON.parse(JSON.stringify(config)); });
      await pg.selectOption("#ajaxcontent #holdrly", "0");
      await pg.evaluate(() => savehardware());
      const rev = await pg.evaluate(() => [configChanges(window.__hwBefore, config), config.hardware.rhold, config.hardware.relay2.rhold]);
      check(rev[0].includes("Hardware: When the relay is on, the door is (relay 1): Locked (maglock on NO: released if the controller fails or loses power) \u2192 Unlocked (electric strike, or maglock on NC)") && rev[1] === 0 && rev[2] === 1,
        "changing door 1 to Unlocked is staged as rhold 0 and the review names it in words", JSON.stringify(rev));
      await pg.selectOption("#ajaxcontent #holdrly", "1");
      await pg.evaluate(() => savehardware());
    }
    await settle(pg); await pg.screenshot({ path: path.join(shotDir, "08-esp32-hardware.png"), fullPage: true });

    // the page: Setup, the doors (one panel per door holding its reader(s)), then Common to all doors
    {
      const inPanel = (block) => pg.evaluate((b) => { const p = document.getElementById(b).closest(".if-door, #readerpark"); return p ? p.id : null; }, block);
      const ids = await pg.evaluate(() => { const all = [...document.querySelectorAll("#ajaxcontent [id]")].map((e) => e.id); return all.filter((x, i) => all.indexOf(x) !== i); });
      check(ids.length === 0, "the Hardware page has no duplicate ids", JSON.stringify(ids));
      const order = await pg.evaluate(() => [...document.querySelectorAll("#ajaxcontent .if-hw-head")].map((h) => h.textContent));
      check(JSON.stringify(order) === JSON.stringify(["Setup", "Doors", "Common to all doors"]), "Hardware page sections: Setup, Common to all doors, Doors", JSON.stringify(order));
      const d0d1 = await pg.evaluate(() => [...document.querySelectorAll("#ajaxcontent label")].filter((l) => l.offsetParent && /\bD[01]$/.test(l.textContent.trim())).map((l) => l.textContent.trim()));
      check(JSON.stringify(d0d1) === JSON.stringify(["Reader 1 D0", "Reader 1 D1", "Reader 2 D0", "Reader 2 D1"]), "two readers show two D0/D1 pairs, each named by its reader", JSON.stringify(d0d1));
      check(await inPanel("reader1block") === "relayform" && await inPanel("reader2block") === "relayform2", "two doors: reader 1 sits in door 1's panel, reader 2 in door 2's");
      check((await pg.textContent("#ajaxcontent #setupnote")).includes("reader 2 opens Door 2"), "the setup line says which reader opens which door", await pg.textContent("#ajaxcontent #setupnote"));

      // one door, a reader each side: In and Out are suggested, both readers in door 1's panel
      await pg.selectOption("#ajaxcontent #numrlys", "1");
      const one = await pg.evaluate(() => ({ r1dir: document.getElementById("r1dir").value, r2dir: document.getElementById("r2dir").value, r2door: document.getElementById("r2door").value, door2: !!document.getElementById("relayform2"), note: document.getElementById("setupnote").textContent }));
      check(one.r1dir === "1" && one.r2dir === "2" && one.r2door === "0" && !one.door2, "one door with two readers: reader 1 In, reader 2 Out, both on door 1", JSON.stringify(one));
      check(await inPanel("reader1block") === "relayform" && await inPanel("reader2block") === "relayform", "one door: both readers sit in its panel (the door 2 panel went without taking reader 2 with it)");
      check(one.note.includes("a reader on each side") && one.note.includes("reader 1 logs In, reader 2 logs Out"), "the setup line describes the in/out door", one.note);
      await pg.evaluate(() => savehardware());
      const io = await pg.evaluate(() => [config.hardware.numrelays, config.hardware.reader1, config.hardware.reader2]);
      check(io[0] === 1 && io[1].door === 0 && io[1].direction === 1 && io[2].enabled === 1 && io[2].door === 0 && io[2].direction === 2,
        "the in/out door is saved: one relay, both readers on door 1, directions 1 and 2", JSON.stringify(io));
      const rev = await pg.evaluate(() => configChanges(savedConfig, config));
      check(rev.some((t) => t.startsWith("Hardware: Reader 2 side: ") && t.endsWith("\u2192 Out (leaving)")) && rev.some((t) => t.startsWith("Hardware: Door 1 sensor pin: ")), "the review names the reader side by its label and option, and door 1's sensor as door 1's", JSON.stringify(rev));

      // one reader: reader 2 leaves the page (kept hidden for Save); every-door reader gets its own panel
      await pg.selectOption("#ajaxcontent #r2enabled", "0");
      check(await inPanel("reader2block") === "readerpark" && !(await pg.isVisible("#ajaxcontent #r2wg0pin")), "one reader: reader 2's fields are hidden");
      await pg.selectOption("#ajaxcontent #r1door", "-1");
      check(await inPanel("reader1block") === "alldoorsreaders" && await pg.isVisible("#ajaxcontent #alldoorsreaders"), "a reader for every door sits in its own panel above the doors");
      await pg.evaluate(() => savehardware());
      check(await pg.evaluate(() => config.hardware.reader2.enabled === 0 && config.hardware.reader1.door === -1), "one reader for every door saved", JSON.stringify(await pg.evaluate(() => [config.hardware.reader1, config.hardware.reader2])));

      // back to the preset's two doors, one reader each, for the checks below
      await pg.selectOption("#ajaxcontent #numrlys", "2");
      await pg.evaluate(() => {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }; // bubbles, as a browser sends it: the UI listens on document
        set("r2enabled", "1"); set("r1door", "0"); set("r2door", "1"); set("r1dir", "0"); set("r2dir", "0"); set("gpiorly2", "17");
      });
      await pg.evaluate(() => savehardware());
      check(await inPanel("reader2block") === "relayform2", "two doors again: reader 2 back in door 2's panel");
    }

    // a duplicate pin is refused before anything is sent
    await pg.selectOption("#ajaxcontent #r2wg0pin", "34");
    await pg.evaluate(() => savehardware());
    check((await msgs(pg)).some((d) => d.includes("GPIO 34 is used twice")), "a pin used twice is refused", JSON.stringify(await msgs(pg)));
    check(await pg.evaluate(() => config.hardware.reader2.wgd0pin === 32), "a refused hardware save leaves the staged settings as they were (the bad pin stayed staged)");
    // the clash is shown on both fields, in their cards' titles and in the banner
    {
      const clash = () => pg.evaluate(() => {
        const box = (id) => document.getElementById(id).closest(".field");
        const msg = (id) => { const m = box(id).querySelector(".pin-clash-msg"); return m ? m.textContent : null; };
        const opt = (id, v) => document.querySelector(`#${id} option[value="${v}"]`).textContent;
        return {
          marked: [...document.querySelectorAll("#ajaxcontent .field.pin-clash select")].map((e) => e.id),
          r1: msg("wg0pin"), r2: msg("r2wg0pin"),
          heads: [...document.querySelectorAll("#ajaxcontent .pin-clash-mark")].map((m) => (m.closest(".hw-reader") || m.closest(".card")).id),
          banner: isShown("hwproblem") ? document.getElementById("hwproblemtext").textContent : "",
          outline: getComputedStyle(document.getElementById("r2wg0pin")).borderTopColor,
          inUse: opt("r2wg1pin", 34), free: opt("r2wg1pin", 4), own: opt("wg0pin", 34),
        };
      });
      const c = await clash();
      check(JSON.stringify(c.marked.sort()) === JSON.stringify(["r2wg0pin", "wg0pin"]) && c.r1 === "GPIO 34 is also Reader 2 D0" && c.r2 === "GPIO 34 is also Reader 1 D0" && c.outline === "rgb(245, 101, 101)",
        "a clashing pin marks both fields in red, each saying what else uses the GPIO", JSON.stringify(c));
      check(c.heads.includes("reader1block") && c.heads.includes("reader2block") && c.heads.includes("relayform") && c.heads.includes("relayform2"),
        "the reader and door cards holding the clashing fields show a marker in their titles", JSON.stringify(c.heads));
      check(c.banner === "GPIO 34 is used twice: Reader 1 D0 and Reader 2 D0.", "the banner above Save names the clash", c.banner);
      check(c.inUse === "GPIO-34 (input only) \u2014 in use: Reader 1 D0, Reader 2 D0" && c.free === "GPIO-4" && c.own === "GPIO-34 (input only) \u2014 in use: Reader 2 D0",
        "pin menus mark the GPIOs already in use, and by what (not counting the field itself)", JSON.stringify([c.inUse, c.free, c.own]));
      // a second clash at the same time: both listed, all four fields marked
      await pg.selectOption("#ajaxcontent #exitpinrly2", "17");
      const c2 = await clash();
      check(c2.marked.length === 4 && c2.banner === "GPIO 34 is used twice: Reader 1 D0 and Reader 2 D0. GPIO 17 is used twice: Relay 2 and Door 2 exit button.",
        "two clashes at once: every field marked, the banner lists both", JSON.stringify(c2));
      await pg.setViewportSize({ width: 390, height: 844 });
      await pg.waitForTimeout(300);
      const wide = await pg.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
      await pg.setViewportSize({ width: 1280, height: 860 });
      check(wide.page <= wide.view, "on a phone (390 px) the marked fields and their notes do not scroll the page sideways", JSON.stringify(wide));
      await pg.selectOption("#ajaxcontent #exitpinrly2", "255");
      await pg.selectOption("#ajaxcontent #r2wg0pin", "32");
      const c3 = await clash();
      check(c3.marked.length === 0 && c3.heads.length === 0 && c3.banner === "" && c3.r1 === null,
        "choosing a free pin clears the marks and the banner at once", JSON.stringify(c3));
    }
    // only Wiegand readers are left: no reader type menu, no SPI or RDM6300 fields, and a
    // board that stored another type is saved as Wiegand
    {
      const shown = await pg.evaluate(() => ({ menu: !!document.querySelector("#ajaxcontent #readertype"), old: ["gpioss", "gain", "rdm6300pin"].filter((id) => document.getElementById(id)), badge: document.querySelector("#reader1block .hw-rtype").textContent, pins: !document.getElementById("wiegandPins").hidden }));
      await pg.evaluate(() => { config.hardware.readertype = 0; savehardware(); });
      const saved = await pg.evaluate(() => config.hardware.readertype);
      check(!shown.menu && shown.old.length === 0 && shown.badge === "Wiegand" && shown.pins && saved === 1,
        "Doors & Readers offers Wiegand only, and saves a stored MFRC522 as Wiegand", JSON.stringify({ shown, saved }));
    }
    const restoreTimeout = await pg.evaluate(() => {
      var bar = document.getElementById("dynamic");
      if (!bar) { bar = document.createElement("div"); bar.id = "dynamic"; document.body.appendChild(bar); }
      // the restore dialog's text (#restorestate) says what happened
      var state = document.getElementById("restorestate");
      if (!state) { state = document.createElement("div"); state.id = "restorestate"; document.body.appendChild(state); }
      var close = document.getElementById("restoreclose");
      if (!close) { close = document.createElement("button"); close.id = "restoreclose"; document.body.appendChild(close); }
      bar.className = ""; bar.textContent = ""; state.textContent = ""; close.hidden = true;
      restorestarted = true; slot = 1; recordstorestore = 2;
      pendingRequest = { message: "{}", tries: 3, timer: setTimeout(function(){}, 60000) };
      retryPendingRequest();
      return { restorestarted, text: state.textContent, danger: bar.className, close: close.hidden ? "hidden" : "shown" };
    });
    check(!restoreTimeout.restorestarted && restoreTimeout.text.includes("did not acknowledge") && restoreTimeout.danger.includes("danger") && restoreTimeout.close === "shown",
      "restore transport timeout is visible and exits progress state", JSON.stringify(restoreTimeout));
    // the opening-hours grid is on the General page (each page exists only while it is open)
    await nav(pg, "general");
    await pg.waitForFunction(() => document.querySelector("#ajaxcontent #openinghours") && document.querySelector("#ajaxcontent #openinghours").children.length >= 7, null, { timeout: 10000 });
    const missingHours = await pg.evaluate(() => {
      var saved = config.general.openinghours;
      delete config.general.openinghours;
      var table = document.getElementById("openinghours");
      table.innerHTML = "";
      populateOpeningHours();
      var extracted = extractOpeningHours();
      config.general.openinghours = saved;
      table.innerHTML = "";
      populateOpeningHours();
      return extracted;
    });
    check(missingHours.length === 7 && missingHours.every((day) => day === "000000000000000000000000"),
      "missing opening hours render fail-closed, not 24/7", JSON.stringify(missingHours));
    await nav(pg, "hardware");
    await pg.waitForSelector("#ajaxcontent #gpiorly2", { state: "attached" });
    await pg.waitForTimeout(300);
    await pg.evaluate(() => savehardware());
    await pg.evaluate(() => withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}));
    await pg.waitForTimeout(500);
    const saved2 = sim2.state.savedConfigs.at(-1);
    const hwSaved = saved2 && saved2.hardware;
    check(hwSaved && hwSaved.relay2.rpin === 17 && typeof hwSaved.relay2.rtime === "number" && hwSaved.relay2.rtype === 1,
      "relay 2 saved as numbers (upstream saved strings; the firmware read GPIO0)", JSON.stringify(hwSaved && hwSaved.relay2));
    check(hwSaved && hwSaved.reader1.door === 0 && hwSaved.reader2.enabled === 1 && hwSaved.reader2.wgd0pin === 32 && hwSaved.reader2.door === 1,
      "two-reader configuration saved", JSON.stringify(hwSaved && [hwSaved.reader1, hwSaved.reader2]));
    // door 2 has its own contact and exit button (door 1's are Door Status / Open Lock)
    check(await pg.isVisible("#ajaxcontent #doorpinrly2") && await pg.isVisible("#ajaxcontent #exitpinrly2") && !(await pg.isVisible("#ajaxcontent #doorpinrly")),
      "door 2 shows its own sensor and exit button fields; relay 1 does not");
    await pg.selectOption("#ajaxcontent #doorpinrly2", "21");
    await pg.selectOption("#ajaxcontent #exitpinrly2", "22");
    await pg.evaluate(() => { savehardware(); withStepUp("settings", (s) => sendWebsocket(JSON.stringify(Object.assign({}, config, s))), () => {}); });
    await pg.waitForTimeout(500);
    const saved3 = sim2.state.savedConfigs.at(-1);
    check(saved3 && saved3.hardware.relay2.doorstatpin === 21 && saved3.hardware.relay2.openlockpin === 22,
      "door 2 sensor and exit button pins saved", JSON.stringify(saved3 && saved3.hardware.relay2));
    await pg.selectOption("#ajaxcontent #doorpinrly2", "16"); // relay 1's pin
    const conflict = await pg.evaluate(() => configProblem(Object.assign({}, config, { hardware: Object.assign({}, config.hardware, { relay2: Object.assign({}, config.hardware.relay2, { doorstatpin: 16 }) }) }), deviceBoard()));
    check(conflict === "GPIO 16 is used twice: Relay 1 and Door 2 sensor", "the page refuses a door 2 sensor on a pin already in use, with the device's message", conflict);
    await pg.selectOption("#ajaxcontent #doorpinrly2", "21");

    // the access log says which door was used
    await nav(pg, "latestlog");
    await pg.waitForFunction(() => document.querySelectorAll("#ajaxcontent tbody tr td").length > 5, null, { timeout: 10000 });
    const doorCol = await pg.evaluate(() => ({
      head: [...document.querySelectorAll("#ajaxcontent thead th")].map((t) => t.textContent.trim()),
      cells: [...document.querySelectorAll("#ajaxcontent tbody td")].map((t) => t.textContent.trim()),
    }));
    check(doorCol.head.includes("Door") && doorCol.cells.includes("Door 2") && doorCol.cells.includes("Door 1"), "access log shows which door each entry was for", JSON.stringify(doorCol.head));
    check(doorCol.head.includes("In/Out") && doorCol.cells.includes("Out"), "access log shows In/Out for a reader with a side", JSON.stringify(doorCol.head));
    await settle(pg); await pg.screenshot({ path: path.join(shotDir, "09-esp32-access-log.png") });
    check(pgErrors.length === 0, "no JavaScript errors on the ESP32 device page", pgErrors.join(" | "));
    check(pgDialogs.length === 0, "no blocking alert/confirm dialogs on the ESP32 device page", JSON.stringify(pgDialogs));
    await pg.close();
  } finally {
    await sim2.close();
  }

  check(pageErrors.length === 0, "no JavaScript errors in the page", pageErrors.join(" | "));
  check(cspViolations.length === 0, "no Content-Security-Policy violations in the whole run", cspViolations.join(" | "));
  check(dialogs.length === 0, "no blocking alert/confirm dialogs at all (messages and confirmations are in the page)", JSON.stringify(dialogs));
} finally {
  await browser.close();
  await sim.close();
}

console.log(`${checks} checks, ${failures} failures (screenshots in ${shotDir})`);
if (failures === 0 && checks >= 30) {
  console.log("UI E2E PASSED");
  process.exit(0);
}
process.exit(1);
