// Checks README-IRONFRAME.md covers what an installer needs and that its
// concrete claims match the code: default pins vs the UI defaults, the offered
// pin list vs the hardware page, log/user page sizes vs the firmware, and the
// "not yet on hardware" warning.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = fs.readFileSync(path.join(repo, "README-IRONFRAME.md"), "utf8");
// the UI's scripts (src/websrc/js/*.js, bundled into the served esprfid.js)
const jsDir = path.join(repo, "src/websrc/js");
const js = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort().map((f) => fs.readFileSync(path.join(jsDir, f), "utf8")).join("\n");
// the page templates (src/websrc/pages/*.htm, served together as esprfid.htm)
const pagesDir = path.join(repo, "src/websrc/pages");
const htm = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".htm")).sort().map((f) => fs.readFileSync(path.join(pagesDir, f), "utf8")).join("\n");
const logEsp = fs.readFileSync(path.join(repo, "src/log.esp"), "utf8");
const usersEsp = fs.readFileSync(path.join(repo, "src/wsResponses.esp"), "utf8");
const cfgEsp = fs.readFileSync(path.join(repo, "src/config.esp"), "utf8");
const settingsH = fs.readFileSync(path.join(repo, "src/core/settings.h"), "utf8");
const pinsH = fs.readFileSync(path.join(repo, "src/core/pins.h"), "utf8");
const pinArr = (name) => (new RegExp(`${name}\\[\\] = \\{([^}]*)\\}`).exec(pinsH)[1]).split(",").map((x) => Number(x.trim()));

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : " " + detail}`);
  if (!cond) failures++;
};

for (const h of ["## Hardware", "### Default pins (ESP32-S3)", "## Two doors: VOANZO ESP32 2-relay board + two standalone Wiegand readers",
  "### Wiring (the preset)", "### Reader LED and buzzer", "### Reader setup", "### Locks", "### Flashing the VOANZO board", "## Flashing", "## First boot", "### Moving from an ESP8266 esp-rfid", "## What changed", "### Logs", "### Speed", "### Security", "### Residual risks", "## Tests"]) {
  check(doc.includes(h + "\n") || doc.includes(h + " "), `section "${h}"`);
}
check(/write_flash 0x0 bin\/esp32s3-full\.bin/.test(doc), "first-flash command with offset 0x0");
{
  // the setup hotspot's password: the firmware's, the UI's copy and the README's first-boot step
  const wifiH = fs.readFileSync(path.join(repo, "src/core/wifi.h"), "utf8");
  const fw = (/SETUP_HOTSPOT_PASSWORD\[\] = "([^"]+)"/.exec(wifiH) || [])[1];
  const ui = (/var SETUP_HOTSPOT_PASSWORD = "([^"]+)"/.exec(js) || [])[1];
  const firstBoot = doc.slice(doc.indexOf("## First boot"), doc.indexOf("### Saving settings"));
  check(!!fw && fw.length >= 8 && ui === fw, `setup hotspot password: firmware and UI agree (${fw})`, String(ui));
  check(!!fw && firstBoot.includes("`" + fw + "`") && /closes after 15 minutes/.test(firstBoot), "First boot gives the setup hotspot password and its 15-minute close", firstBoot.slice(0, 300));
  check(!/starts an open access point/.test(doc) && !/open setup hotspot/.test(doc) && !/still opens an open hotspot/.test(doc), "no claim left that the setup hotspot is open");
}
check(/not 5 V tolerant/.test(doc), "5 V level-shifting warning");
check(/B0DS6SB1XB/.test(doc) && /303E32DC210/.test(doc), "exact VOANZO listing and schematic board identifier documented");
check(/GPIO34\/35 have no internal pull-ups/.test(doc) && /four-channel open-drain 5 V-to-3\.3 V level shifter/.test(doc), "external Wiegand pull-up and level-shifter requirement documented");
check(/preset starts both doors at 3000 ms/.test(doc) && /in \*\*milliseconds\*\*/.test(doc), "relay timing units and preset value documented");
{
  const preset = /function applyEsp32TwoDoorPreset\(\) \{([\s\S]*?)\n\}/.exec(js)[1];
  check(/h\.rtime = 3000;/.test(preset) && /rpin: 17, rtime: 3000/.test(preset), "documented preset timing matches the UI preset (both doors 3000 ms)");
  check(!/[Mm]icrosecond/.test(htm), "web page no longer calls relay time microseconds");
}
{
  // Auto Restart choices: the value must be the labelled period in seconds
  // ("Every 30 days" was 18144000 s, i.e. 210 days)
  const opts = [...htm.matchAll(/<option value="(\d+)"[^>]*>Every (\d+)(h| hours| days)<\/option>/g)];
  const bad = opts.filter((m) => Number(m[1]) !== Number(m[2]) * (m[3] === " days" ? 86400 : 3600)).map((m) => m[0]);
  check(opts.length >= 3 && bad.length === 0, "Auto Restart values match their labels", bad.join(" "));
}
check(/board LED is GPIO23/.test(doc) && /leaves the Wi-Fi LED disabled/.test(doc), "optional onboard LED mapping documented");
check(/header's power pin is \*\*5 V\*\*, not 3\.3 V/.test(doc), "programming-header power warning documented");
check(/The Wi-Fi fallback, a real lock and the door contacts are not yet hardware-validated/.test(doc), "states that target hardware validation is still outstanding (both readers and an exit button reported working, H13/H14)");
for (const r of ["No TLS", "MQTT broker is part of the lock", "Card UIDs are cloneable", "not signed", "Flash is not encrypted", "fallback access point has its own password", "opens its setup hotspot for commissioning, with the documented setup password"]) {
  check(doc.includes(r), `residual risk: ${r}`);
}

// default pins table == UI defaults
const stateJs = fs.readFileSync(path.join(jsDir, "state.js"), "utf8"); // the built-in default config
const def = (key) => Number(new RegExp(`"${key}":\\s*(\\d+)`).exec(stateJs)[1]);
const row = (label) => {
  const m = new RegExp(`\\| ${label.replace(/[/()]/g, "\\$&")} \\| (\\d+) \\|`).exec(doc);
  return m ? Number(m[1]) : NaN;
};
check(row("Wiegand D0") === def("wgd0pin"), "doc Wiegand D0 matches UI default", `${row("Wiegand D0")} vs ${def("wgd0pin")}`);
check(row("Wiegand D1") === def("wgd1pin"), "doc Wiegand D1 matches UI default");
check(row("Relay 1") === def("rpin"), "doc relay pin matches UI default");

// S3: the documented pin list == the firmware whitelist == the page's built-in lists
const expandList = (txt) => txt.split(",").flatMap((t) => {
  const m = /(\d+)\s*-\s*(\d+)/.exec(t);
  if (m) { const out = []; for (let i = +m[1]; i <= +m[2]; i++) out.push(i); return out; }
  return [Number(t.trim())];
});
const s3doc = /The UI only offers safe pins: ([0-9, -]+)\./.exec(doc);
const s3fw = pinArr("PINS_ESP32S3_IO");
check(s3doc && JSON.stringify(expandList(s3doc[1])) === JSON.stringify(s3fw), "doc S3 pin list == firmware whitelist (core/pins.h)", s3doc && s3doc[1]);
// the page has no pin lists of its own: every menu is built from the
// device's whitelist (status pinsio / pinsinput, core/pins.h via wsResponses.esp)
check(!/<option[^>]*>GPIO-/.test(htm) && /ajaxobj\.pinsio/.test(js) && /createNestedArray\("pinsio"\)/.test(usersEsp), "pin menus come from the firmware whitelist (no built-in lists in the page)");
check(/pinAllowed\(pins, pin, output\)/.test(settingsH) && /core::parseSettings\([^;]*policyBoard\(\)/.test(cfgEsp), "firmware enforces the whitelist when loading a config (core::parseSettings)");

// ESP32: documented exclusions hold in the firmware whitelist
const e32io = pinArr("PINS_ESP32_IO"), e32in = pinArr("PINS_ESP32_INPUT_ONLY");
check(![0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 15].some((p) => e32io.includes(p) || e32in.includes(p)), "ESP32 whitelist excludes strapping, serial and flash pins (incl. GPIO 12), as documented");
check(JSON.stringify(e32in) === JSON.stringify([34, 35]) && !e32in.some((p) => e32io.includes(p)) && !e32in.includes(36) && !e32in.includes(39), "ESP32 34/35 are input-only and errata pins 36/39 are excluded, as documented");

// two-door wiring table == the UI's ESP32 preset == allowed pins
const preset = /function applyEsp32TwoDoorPreset\(\) \{([\s\S]*?)\n\}/.exec(js)[1];
const pv = (re) => Number(re.exec(preset)[1]);
const want = {
  r1d0: pv(/h\.wgd0pin = (\d+)/), r1d1: pv(/h\.wgd1pin = (\d+)/), relay1: pv(/h\.rpin = (\d+)/), relay2: pv(/relay2 = \{[^}]*rpin: (\d+)/),
  r1led: pv(/reader1 = \{[^}]*ledpin: (\d+)/), r1beep: pv(/reader1 = \{[^}]*beeperpin: (\d+)/),
  r2d0: pv(/reader2 = \{[^}]*wgd0pin: (\d+)/), r2d1: pv(/reader2 = \{[^}]*wgd1pin: (\d+)/),
  r2led: pv(/reader2 = \{[^}]*ledpin: (\d+)/), r2beep: pv(/reader2 = \{[^}]*beeperpin: (\d+)/),
};
const trow = (label) => {
  const m = new RegExp(`\\| ${label}[^|]*\\| (?:GPIO )?(\\d+)[^|]*\\| (?:GPIO )?(\\d+)`).exec(doc.slice(doc.indexOf("### Wiring (the preset)")));
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
};
check(JSON.stringify(trow("D0 \\(green\\)")) === JSON.stringify([want.r1d0, want.r2d0]), "doc reader D0 pins == UI preset", JSON.stringify(trow("D0 \\(green\\)")));
check(JSON.stringify(trow("D1 \\(white\\)")) === JSON.stringify([want.r1d1, want.r2d1]), "doc reader D1 pins == UI preset");
check(JSON.stringify(trow("LED \\(blue or brown\\)")) === JSON.stringify([want.r1led, want.r2led]), "doc reader LED pins == UI preset");
check(JSON.stringify(trow("BEEP")) === JSON.stringify([want.r1beep, want.r2beep]), "doc reader buzzer pins == UI preset");
check(/\| Lock \| relay 1 \(GPIO 16\) \| relay 2 \(GPIO 17\) \|/.test(doc) && want.relay1 === 16 && want.relay2 === 17, "doc relays GPIO16/17 == UI preset");
const outs = [want.relay1, want.relay2, want.r1led, want.r1beep, want.r2led, want.r2beep];
const ins = [want.r1d0, want.r1d1, want.r2d0, want.r2d1];
check(outs.every((p) => e32io.includes(p)) && ins.every((p) => e32io.includes(p) || e32in.includes(p)), "every preset pin is allowed by the ESP32 whitelist");
check(new Set([...outs, ...ins]).size === outs.length + ins.length, "preset uses no pin twice");
// every reader line is on the edge 2x10 header (module's left side), so one
// ribbon + breakout carries it all; relays 16/17 are wired on the board
const edgeHeader = new Set([36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 13]);
const readerPins = [want.r1d0, want.r1d1, want.r2d0, want.r2d1, want.r1led, want.r1beep, want.r2led, want.r2beep];
check(readerPins.every((p) => edgeHeader.has(p)) && !readerPins.some((p) => [12, 36, 39].includes(p)), "all preset reader pins on the edge header, avoiding 12/36/39", JSON.stringify(readerPins));
check(/\| 3 \| SVN \(39\) · G34 \| — · reader 1 D0 \|/.test(doc) && /never connect G12/.test(doc) && /SD3 · CMD \| \*\*flash pins, never connect\*\*/.test(doc), "doc header row table present with the do-not-connect pins");

// page sizes quoted in the doc
check(/#define LOG_ITEMS_PER_PAGE 50/.test(logEsp) && /#define USERS_PER_PAGE 50/.test(usersEsp), "50 rows per page in firmware, as documented");
check(/#define LOG_MAX_BYTES \(64 \* 1024\)/.test(logEsp) && /#define LOG_KEEP_ROTATED 3/.test(logEsp), "rotation 64 KB x 3 as documented");

// README-MQTT's list of what MQTT remote admin (updateconf) cannot change is
// exactly the firmware's (core::REMOTE_ADMIN_KEPT)
{
  const policyH = fs.readFileSync(path.join(repo, "src/core/configpolicy.h"), "utf8");
  const arr = /REMOTE_ADMIN_KEPT\[\] = \{([\s\S]*?)\};/.exec(policyH);
  const fwKept = arr ? [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const mqttDoc = fs.readFileSync(path.join(repo, "README-MQTT.md"), "utf8");
  const block = /```remote-admin-kept\n([\s\S]*?)```/.exec(mqttDoc);
  const docKept = block ? block[1].split("\n").filter((l) => l.trim()) : [];
  check(fwKept.length >= 40 && JSON.stringify(docKept) === JSON.stringify(fwKept), `README-MQTT lists exactly the ${fwKept.length} settings remote admin cannot change`,
    JSON.stringify({ onlyFirmware: fwKept.filter((k) => !docKept.includes(k)), onlyDoc: docKept.filter((k) => !fwKept.includes(k)) }));
}

// every release tag AGENTS.md lists ("Tags so far") has its row in
// docs/evidence/RELEASES.md: the same commit and both image digests in full
// (review 8 V10: the record stopped four tags short and nothing noticed)
{
  // AGENTS.md is not in the public copy: there only RELEASES.md itself is checked
  const agentsPath = path.join(repo, "AGENTS.md");
  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  const releases = fs.readFileSync(path.join(repo, "docs/evidence/RELEASES.md"), "utf8");
  const tagLine = agents.slice(agents.indexOf("Tags so far:"), agents.indexOf("\n- ", agents.indexOf("Tags so far:")));
  const tags = agents
    ? [...tagLine.matchAll(/`ironframe-(\d+\.\d+\.\d+)` \(([0-9a-f]{7})[,)]/g)].map((m) => ({ tag: m[1], sha: m[2] }))
    : [...releases.matchAll(/^\| `ironframe-(\d+\.\d+\.\d+)` \| `([0-9a-f]{7})`/gm)].map((m) => ({ tag: m[1], sha: m[2] }));
  check(tags.length >= 18, `the release tags are listed (${tags.length})`);
  for (const { tag, sha } of tags) {
    const row = releases.split("\n").find((l) => l.startsWith("| `ironframe-" + tag + "` |"));
    const digests = row ? (row.match(/`[0-9a-f]{64}`/g) || []).length : 0;
    check(!!row && row.includes("`" + sha + "`") && digests >= 2, `RELEASES.md row for ${tag} (${sha}) with both image digests`, row ? `${digests} digests` : "no row");
  }
}

// one clock-trusted constant for the page, equal to the firmware's
// (state.js CLOCK_TRUSTED_FROM, clock.esp CLOCK_TRUSTED_FROM; plan 1.9.1 D5)
{
  const clockEsp = fs.readFileSync(path.join(repo, "src/clock.esp"), "utf8");
  const fw = (/CLOCK_TRUSTED_FROM = (\d+)/.exec(clockEsp) || [])[1];
  const ui = (/var CLOCK_TRUSTED_FROM = (\d+);/.exec(js) || [])[1];
  const strays = (js.match(/\b(1451606400|1520665101)\b/g) || []).length;
  check(!!fw && fw === ui && strays === 1, `the page's clock-trusted time is the firmware's (${fw}) and written once`, JSON.stringify({ fw, ui, strays }));
}

if (failures === 0) {
  console.log("DOCS CHECK PASSED");
  process.exit(0);
}
process.exit(1);
