// Verifies the web assets compiled into the firmware (src/webh/*.gz.h):
//  1. they are fresh: rebuilding src/websrc in a scratch copy reproduces them
//     byte for byte (so nobody edits websrc and forgets to rebuild);
//  2. no third-party UI library is bundled: the pages are plain JavaScript and
//     our own stylesheet (no jQuery, Bootstrap, FooTable or icon font: each
//     carried XSS history and ~100 KB the board had to serve);
//  3. the Ironframe theme, logo and wordmark are in the bundle;
//  4. every asset is routed by webserver.esp with ETag revalidation.
// Needs tools/webfilesbuilder/node_modules (npm ci there).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : " " + detail}`);
  if (!cond) failures++;
};

function decodeHeader(file) {
  const src = fs.readFileSync(file, "utf8");
  const len = Number(/_len (\d+)/.exec(src)[1]);
  const hex = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}")).match(/0x[0-9a-f]{2}/g);
  const gz = Buffer.from(hex.map((h) => parseInt(h, 16)));
  if (gz.length !== len) throw new Error(`${file}: length mismatch`);
  return zlib.gunzipSync(gz);
}

// 1. freshness
const scratchRoot = path.join(os.homedir(), "scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratchRoot, "assetcheck-"));
try {
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  fs.cpSync(path.join(repo, "src", "websrc"), path.join(tmp, "src", "websrc"), {
    recursive: true,
    filter: (p) => !p.includes(`${path.sep}process`),
  });
  const wfb = path.join(tmp, "tools", "webfilesbuilder");
  fs.mkdirSync(wfb);
  for (const f of ["gulpfile.js", "bin.js", "package.json"]) fs.copyFileSync(path.join(repo, "tools", "webfilesbuilder", f), path.join(wfb, f));
  fs.symlinkSync(path.join(repo, "tools", "webfilesbuilder", "node_modules"), path.join(wfb, "node_modules"));
  execFileSync(process.execPath, ["bin.js"], { cwd: wfb, stdio: "pipe" });
  const committed = fs.readdirSync(path.join(repo, "src", "webh")).sort();
  const rebuilt = fs.readdirSync(path.join(tmp, "src", "webh")).sort();
  check(JSON.stringify(committed) === JSON.stringify(rebuilt), "same set of asset headers as a clean rebuild", `${committed} vs ${rebuilt}`);
  for (const f of rebuilt) {
    const a = fs.existsSync(path.join(repo, "src", "webh", f)) ? fs.readFileSync(path.join(repo, "src", "webh", f)) : Buffer.alloc(0);
    const b = fs.readFileSync(path.join(tmp, "src", "webh", f));
    check(a.equals(b), `src/webh/${f} matches a fresh build of src/websrc`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2-3. contents
const webh = path.join(repo, "src", "webh");
check(!fs.existsSync(path.join(repo, "src", "websrc", "3rdparty")), "no third-party folder in src/websrc");
check(!fs.existsSync(path.join(webh, "required.js.gz.h")), "no required.js (library bundle) asset");
const css = decodeHeader(path.join(webh, "required.css.gz.h")).toString();
const index = decodeHeader(path.join(webh, "index.html.gz.h")).toString();
const appjs = decodeHeader(path.join(webh, "esprfid.js.gz.h")).toString();
const pagesHtml = decodeHeader(path.join(webh, "esprfid.htm.gz.h")).toString();
const logo = decodeHeader(path.join(webh, "ironframe-logo.svg.gz.h")).toString();
const everything = fs.readdirSync(webh).map((f) => decodeHeader(path.join(webh, f)).toString("latin1")).join("\n");
check(!/jQuery|Bootstrap v|FooTable|glyphicon/i.test(everything), "no jQuery, Bootstrap, FooTable or glyphicon in any served asset");
check(!/\$\(|\$\.(ajax|each|extend)/.test(appjs), "the UI script calls no jQuery");
check(!/data-toggle=|class="[^"]*\b(col-(xs|sm|md|lg)-|form-control|panel-|glyphicon)/.test(index + pagesHtml), "no Bootstrap markup in the pages");
check(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(index + pagesHtml) && !/\son[a-z]+=/i.test(index + pagesHtml), "no inline script or on*= handler in the pages (CSP)");
check(css.includes("--if-amber:#f59e0b") || css.includes("--if-amber: #f59e0b"), "Ironframe theme palette in the CSS bundle");
check(index.includes("img/ironframe-logo.svg") && /IRON<span>FRAME<\/span>/.test(index), "logo and IRON/FRAME wordmark in index.html");
check(/<svg[\s\S]*#f59e0b[\s\S]*<\/svg>/.test(logo), "Ironframe logo SVG asset");
check(!appjs.includes("api.github.com/repos/esprfid"), "no upstream (ESP8266) release feed in the UI");

// 4. routing + caching
const ws = fs.readFileSync(path.join(repo, "src", "webserver.esp"), "utf8");
for (const f of fs.readdirSync(webh)) {
  const sym = f.replace(/\.h$/, "").replace(/[.-]/g, "_");
  check(ws.includes(`${sym}, ${sym}_len`), `webserver.esp serves ${f}`);
}
check(/If-None-Match/.test(ws) && /"ETag"/.test(ws) && /304/.test(ws), "assets revalidate with ETag / 304");

if (failures === 0) {
  console.log("ASSETS CHECK PASSED");
  process.exit(0);
}
process.exit(1);
