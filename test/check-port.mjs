// Fails if any ESP8266-only API (or the unsafe makeBuffer pattern) is still
// used in the firmware sources. Comments are ignored. Before scanning, the
// scanner is run against a seeded sample containing every forbidden token, so
// a broken pattern list cannot report a false "clean".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = [
  ["SPIFFS filesystem", /\bSPIFFS\s*\./],
  ["ESP8266 headers", /#include\s*<ESP8266[^>]*>/],
  ["ESPAsyncTCP (ESP8266)", /\bESPAsyncTCP\b/],
  ["ESPAsyncUDP (ESP8266)", /\bESPAsyncUDP\b/],
  ["ICACHE_* attributes", /\bICACHE_(FLASH|RAM)_ATTR\b/],
  ["SoftwareSerial", /\bSoftwareSerial\b/],
  ["ESP8266 SDK wifi_* calls", /\bwifi_(get_ip_info|station_get_config|softap_get_config)\b/],
  ["ESP8266 WiFi event API", /\bonStationMode(Connected|Disconnected|GotIP)\b/],
  ["ESP8266 watchdog API", /\bESP\.wdt(Enable|Disable|Feed)\b/],
  ["ESP.getChipId", /\bESP\.getChipId\b/],
  ["scanNetworksAsync", /\bscanNetworksAsync\b/],
  ["Ticker once_ms_scheduled", /\bonce_ms_scheduled\b/],
  ["Dir / openDir", /\bopenDir\s*\(/],
  ["FSInfo", /\bFSInfo\b/],
  ["Update.runAsync", /\bUpdate\.runAsync\b/],
  ["ws.makeBuffer (no room for NUL)", /\bmakeBuffer\s*\(/],
  ["WiFi.hostname()", /\bWiFi\.hostname\s*\(/],
];

// Ironframe's own sources only (not the vendored reader drivers): Arduino's
// millis() is 32-bit and wraps after 49.7 days; deadlines kept on it broke
// after 24.8 (the readers stopped deciding). Use uptimeMs() (64-bit).
// And an output gets its level written before pinMode(OUTPUT), which alone
// drives LOW: the ON level of active-low relays, LEDs and buzzers (a blip at
// boot, or an LED left lit).
const outputLevelFirst = {
  test(code) {
    const re = /\bpinMode\s*\(\s*([^,()]+(?:\([^()]*\))?[^,()]*?)\s*,\s*OUTPUT\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      const before = code.slice(0, m.index).trimEnd().replace(/;$/, "");
      const prev = before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1);
      const pin = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^\\s*digitalWrite\\s*\\(\\s*${pin}\\s*,`).test(prev)) return true;
    }
    return false;
  },
};
// File::openNextFile() opens every file it walks past, and LittleFS scans the
// folder for every open: a start with 776 users took 136 s (ledger H27.4).
// Walk the user folder by name (storage.esp nextFileName()). The root listing
// in log.esp (a few log files) may keep it.
const OPEN_NEXT = "openNextFile() (walks open every file: use nextFileName())";
const OWN_FORBIDDEN = [
  ["32-bit millis() (use uptimeMs())", /\bmillis\s*\(\s*\)/],
  ["pinMode(OUTPUT) before the pin's level is written", outputLevelFirst],
  [OPEN_NEXT, /\.openNextFile\s*\(/],
];
const ALLOWED_IN = { [OPEN_NEXT]: new Set(["log.esp"]) };
const VENDORED = new Set(); // the vendored PN532 / RDM6300 drivers were removed with those readers (2026-10-16)

function stripComments(src) {
  // remove /* */ and // comments, keep string literals intact enough for a scan
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"])\/\/.*$/gm, "$1");
}

function scan(text, own = false, file = "") {
  const code = stripComments(text);
  const rules = own ? FORBIDDEN.concat(OWN_FORBIDDEN) : FORBIDDEN;
  return rules.filter(([name, re]) => !(ALLOWED_IN[name] && ALLOWED_IN[name].has(file)) && re.test(code)).map(([name]) => name);
}

// Positive control: every pattern must fire on a sample that uses it.
const sample = [
  "File f = SPIFFS.open(\"/x\", \"r\");",
  "#include <ESP8266WiFi.h>",
  "#include <ESPAsyncTCP.h>",
  "#include <ESPAsyncUDP.h>",
  "void ICACHE_FLASH_ATTR f();",
  "SoftwareSerial *s;",
  "wifi_get_ip_info(STATION_IF, &info);",
  "WiFi.onStationModeGotIP(cb);",
  "ESP.wdtFeed();",
  "ESP.getChipId();",
  "WiFi.scanNetworksAsync(cb, true);",
  "t.once_ms_scheduled(50, cb);",
  "Dir d = SPIFFS.openDir(\"/\");",
  "FSInfo i;",
  "Update.runAsync(true);",
  "ws.makeBuffer(len);",
  "WiFi.hostname(\"x\");",
].join("\n");
const fired = scan(sample + "\nunsigned long t = millis();\npinMode(config.ledPin[i], OUTPUT);\nFile f = dir.openNextFile();", true);
if (fired.length !== FORBIDDEN.length + OWN_FORBIDDEN.length) {
  const missing = FORBIDDEN.concat(OWN_FORBIDDEN).map(([n]) => n).filter((n) => !fired.includes(n));
  console.log("positive control failed, patterns that did not fire:", missing.join(", "));
  process.exit(1);
}
// ...and comments must not count
if (scan("// SPIFFS.open() was used upstream\n/* SoftwareSerial */\n// millis() wraps", true).length !== 0) {
  console.log("comment stripping failed");
  process.exit(1);
}
if (scan("uint64_t t = uptimeMs();", true).length !== 0) {
  console.log("uptimeMs() must not match the millis() rule");
  process.exit(1);
}
if (scan("if (p != 255)\n{\n\tdigitalWrite(config.ledPin[i], HIGH); // off\n\tpinMode(config.ledPin[i], OUTPUT);\n}", true).length !== 0) {
  console.log("an output whose level is written first must not match the pinMode rule");
  process.exit(1);
}
console.log(`positive control: all ${FORBIDDEN.length + OWN_FORBIDDEN.length} patterns detected in the seeded sample`);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "websrc" || e.name === "webh") continue;
      walk(p);
    } else if (/\.(cpp|h|esp|ino)$/.test(e.name)) files.push(p);
  }
})(path.join(repo, "src"));

let bad = 0;
for (const f of files) {
  const hits = scan(fs.readFileSync(f, "utf8"), !VENDORED.has(path.basename(f)), path.basename(f));
  if (hits.length) {
    bad++;
    console.log(`${path.relative(repo, f)}: ${hits.join(", ")}`);
  }
}
console.log(`scanned ${files.length} source files`);
if (files.length < 15) {
  console.log("too few files scanned - wrong directory?");
  process.exit(1);
}
const ini = fs.readFileSync(path.join(repo, "platformio.ini"), "utf8");
if (/espressif8266/.test(ini) || !/board\s*=\s*esp32-s3/.test(ini)) {
  console.log("platformio.ini still targets ESP8266 or lacks the ESP32-S3 board");
  process.exit(1);
}
if (bad === 0) {
  console.log("PORT CHECK PASSED");
  process.exit(0);
}
process.exit(1);
