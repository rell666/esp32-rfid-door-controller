// Device simulator for UI tests. Serves the exact gzip assets compiled into the
// firmware (parsed from src/webh/*.gz.h) and implements the firmware's HTTP and
// WebSocket protocol: digest /login with throttling, session tokens, origin
// check, masked getconf, secret merge, default-password gate, 50-row user
// pages and byte-offset log paging. Request counters let tests measure
// round-trips.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const MASK = "********";
const REALM = "ironframe-rfid";
const USERS_PER_PAGE = 50;
const LOG_ITEMS_PER_PAGE = 50;

function loadAssets(webhDir) {
  const assets = {};
  for (const f of fs.readdirSync(webhDir)) {
    const src = fs.readFileSync(path.join(webhDir, f), "utf8");
    const len = Number(/_len (\d+)/.exec(src)[1]);
    const hex = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}")).match(/0x[0-9a-f]{2}/g);
    const buf = Buffer.from(hex.map((h) => parseInt(h, 16)));
    if (buf.length !== len) throw new Error(`bad header ${f}`);
    assets[f.replace(/\.gz\.h$/, "")] = buf;
  }
  return assets;
}

const ROUTES = {
  "/index.html": ["index.html", "text/html"],
  "/esprfid.htm": ["esprfid.htm", "text/html"],
  "/js/esprfid.js": ["esprfid.js", "text/javascript"],
  "/css/required.css": ["required.css", "text/css"],

  "/img/ironframe-logo.svg": ["ironframe-logo.svg", "image/svg+xml"],
  "/favicon.svg": ["ironframe-logo.svg", "image/svg+xml"],
};

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
// as websocket.esp (plan 1.9 S1): core::stepUpNeededFor, and the refusal;
// hardware since 1.9.1 (plan 1.9.1 B1)
const stepUpNeededFor = (key) => key.startsWith("network.") || key.startsWith("mqtt.") || key.startsWith("hardware.");
// the commands wsCommands[] marks stepUp: the admin password as well as the
// session, the command's name as the action (plan 1.9.1 B1, D2)
export const STEP_UP_COMMANDS = ["remove", "restart", "clearevent", "clearlatest", "testrelay1", "testrelay2", "testrelay3", "testrelay4", "setlogging"];
const STEP_UP_REFUSED = "The admin password was not confirmed, so nothing was changed. Enter it and try again.";

function parseDigest(header) {
  const out = {};
  for (const m of header.slice(7).matchAll(/(\w+)=("([^"]*)"|[^,\s]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function maskSecrets(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const sec of ["network", "general", "mqtt"]) if (c[sec] && c[sec].pswd) c[sec].pswd = MASK;
  if (c.network && c.network.fallbackpswd) c.network.fallbackpswd = MASK;
  if (c.general) { delete c.general.pswdhash; delete c.general.pswdchange; } // as core::maskSecrets
  return c;
}

function mergeSecrets(incoming, existing) {
  for (const sec of ["network", "general", "mqtt"]) {
    if (incoming[sec] && incoming[sec].pswd === MASK) {
      if (existing?.[sec]?.pswd !== undefined) incoming[sec].pswd = existing[sec].pswd;
      else delete incoming[sec].pswd;
    }
  }
  if (incoming.network && incoming.network.fallbackpswd === MASK) {
    if (existing?.network?.fallbackpswd !== undefined) incoming.network.fallbackpswd = existing.network.fallbackpswd;
    else delete incoming.network.fallbackpswd;
  }
}

const isDefault = (p) => !p || p === "admin";
const acceptable = (p) => typeof p === "string" && !isDefault(p) && p.length >= 8 && p.length <= 64;
const needsChange = (p) => !acceptable(p);

// ---- the admin password as the device stores it (core/adminpass.h) -----
// its Digest HA1, never the password; "pswdhash": 1 marks the hash and
// "pswdchange": 1 the factory password that must be changed
export const adminHa1 = (p) => md5(`admin:${REALM}:${p}`);
const FACTORY_HA1 = adminHa1("admin");
const isHa1 = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
function storedAdmin(general) {
  const pswd = isObj(general) && typeof general.pswd === "string" ? general.pswd : null;
  if (pswd === null) return { ha1: FACTORY_HA1, mustChange: true, migrated: false };
  if (jsonInt(general.pswdhash, 0) === 1 && isHa1(pswd)) return { ha1: pswd, mustChange: jsonInt(general.pswdchange, 0) === 1, migrated: false };
  return { ha1: adminHa1(pswd), mustChange: needsChange(pswd), migrated: true };
}
function putAdmin(general, ha1, mustChange) {
  general.pswd = ha1;
  general.pswdhash = 1;
  if (mustChange) general.pswdchange = 1;
  else delete general.pswdchange;
}
const validLogName = (n) => /^\/(eventlog|latestlog)\.json(\.(split\.)?\d{1,5})?$/.test(n);

export function makeLogFile(lines) {
  return lines.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

// Same algorithm as core::readLogPage (byte offsets into the file).
function readLogPage(text, pos, max) {
  const items = [];
  let p = pos;
  while (items.length < max && p < text.length) {
    let nl = text.indexOf("\n", p);
    if (nl < 0) nl = text.length;
    const line = text.slice(p, nl).replace(/\r/g, "");
    p = Math.min(nl + 1, text.length);
    if (line.length) items.push(line.slice(0, 512));
  }
  const eof = text.slice(p).replace(/[\r\n]/g, "").length === 0;
  return { items, nextPos: p, eof };
}

// Pin whitelists exactly as the firmware has them (src/core/pins.h).
function loadPins(pinsHeader) {
  const src = fs.readFileSync(pinsHeader, "utf8");
  const arr = (name) => (new RegExp(`${name}\\[\\] = \\{([^}]*)\\}`).exec(src)[1]).split(",").map((x) => Number(x.trim()));
  return {
    esp32s3: { io: arr("PINS_ESP32S3_IO"), input: [] },
    esp32: { io: arr("PINS_ESP32_IO"), input: arr("PINS_ESP32_INPUT_ONLY") },
  };
}

// ---- settings policy: a JavaScript copy of src/core/configpolicy.h -------
// test/vectors/config-policy.json runs through both (native tests and
// run.mjs), so a difference between the two fails a test. Keep them in step.
export function policyBoard(chip, pinsHeader) {
  return { pins: loadPins(pinsHeader)[chip] };
}

// core::jsonInt: numbers (truncated), booleans, and decimal strings as older UIs saved them
export function jsonInt(v, fallback) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : fallback;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return fallback;
  const m = /^(-?)(\d+)$/.exec(v);
  if (!m || Number(m[2]) > 1000000) return fallback;
  return m[1] ? -Number(m[2]) : Number(m[2]);
}

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const str = (v) => (typeof v === "string" ? v : "");
const clampRelays = (n) => (n < 1 ? 1 : n > 4 ? 4 : n);
const pinAllowed = (pins, pin, output) => pins.io.includes(pin) || (!output && pins.input.includes(pin));

export function checkConfigPins(hw, b, ntp) {
  const rt = jsonInt(hw.readertype, 0);
  const wiegand1 = rt === 1 || rt === 5;
  const relays = clampRelays(jsonInt(hw.numrelays, 1));
  const r1 = isObj(hw.reader1) ? hw.reader1 : null, r2 = isObj(hw.reader2) ? hw.reader2 : null;
  const reader2 = !!r2 && jsonInt(r2.enabled, 0) === 1;
  const rel = (n, key = "rpin") => (isObj(hw["relay" + n]) ? hw["relay" + n][key] : undefined);
  const rtc = isObj(ntp) && isObj(ntp.rtc) ? ntp.rtc : {};
  const rtcOn = [1, 2].includes(jsonInt(rtc.type, 0));
  const fields = [
    ["Reader 1 D0", hw.wgd0pin, false, wiegand1], ["Reader 1 D1", hw.wgd1pin, false, wiegand1],
    ["Relay 1", hw.rpin, true, true],
    ["Relay 2", rel(2), true, relays >= 2], ["Relay 3", rel(3), true, relays >= 3], ["Relay 4", rel(4), true, relays >= 4],
    ["WiFi LED", hw.wifipin, true, true], ["Door sensor", hw.doorstatpin, true, true], ["Doorbell", hw.doorbellpin, true, true],
    ["Open button", hw.openlockpin, true, true], ["Denied LED", hw.accessdeniedpin, true, true], ["Beeper", hw.beeperpin, true, true],
    ["Waiting LED", hw.ledwaitingpin, true, true], ["Reader 1 LED", r1?.ledpin, true, !!r1], ["Reader 1 buzzer", r1?.beeperpin, true, !!r1],
    ["Reader 2 D0", r2?.wgd0pin, false, reader2], ["Reader 2 D1", r2?.wgd1pin, false, reader2],
    ["Reader 2 LED", r2?.ledpin, true, reader2], ["Reader 2 buzzer", r2?.beeperpin, true, reader2],
    ["Door 2 sensor", rel(2, "doorstatpin"), true, relays >= 2], ["Door 2 exit button", rel(2, "openlockpin"), true, relays >= 2],
    ["Door 3 sensor", rel(3, "doorstatpin"), true, relays >= 3], ["Door 3 exit button", rel(3, "openlockpin"), true, relays >= 3],
    ["Door 4 sensor", rel(4, "doorstatpin"), true, relays >= 4], ["Door 4 exit button", rel(4, "openlockpin"), true, relays >= 4],
    ["RTC SDA", rtcOn ? jsonInt(rtc.sdapin, 21) : undefined, true, rtcOn], ["RTC SCL", rtcOn ? jsonInt(rtc.sclpin, 22) : undefined, true, rtcOn],
  ];
  const pins = fields.map(([, v, , used]) => (used ? jsonInt(v, 255) : 255));
  for (let i = 0; i < fields.length; i++) {
    const [label, , output] = fields[i];
    if (pins[i] === 255) continue;
    if (!pinAllowed(b.pins, pins[i], output)) return `${label}: GPIO ${pins[i]} cannot be used${output ? " as an output" : ""} on this board`;
    for (let j = 0; j < i; j++) if (pins[j] === pins[i]) return `GPIO ${pins[i]} is used twice: ${fields[j][0]} and ${label}`;
  }
  return null;
}

// core/livesettings.h: a save is applied without a restart when every key
// it changes is on this list (the reasons are in the header). The vectors
// (test/vectors/live-settings.json) check this copy, the firmware's and the
// web UI's (test/check-live-settings.mjs).
export const LIVE_SETTINGS = [
  "hardware.rtime", "hardware.relay2.rtime", "hardware.relay3.rtime", "hardware.relay4.rtime",
  "hardware.doorname", "hardware.relay2.doorname", "hardware.relay3.doorname", "hardware.relay4.doorname",
  "hardware.maxOpenDoorTime", "hardware.requirepincodeafterrfid", "hardware.allowpincodeonly",
  "hardware.useridstoragemode", "hardware.removeparitybits",
  "hardware.reader1.door", "hardware.reader1.direction", "hardware.reader2.door", "hardware.reader2.direction",
  "general.openinghours", "general.logging", "ntp.tzinfo",
  "mqtt.syncrate", "mqtt.mqttlog", "mqtt.remoteadmin", "mqtt.doorcontrol", "mqtt.carduid",
  "network.idleoff", "network.idlemins",
];

// core::compareSettings: the changed keys of a save, and whether it restarts
export function compareSettings(before, after) {
  if (!isObj(before) || !isObj(after)) return { restart: true, changed: [] };
  const leaves = (o, p, out) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? p + "." + k : k;
      if (isObj(v)) leaves(v, key, out);
      else if (key !== "command") out.set(key, v);
    }
    return out;
  };
  const text = (v) => (v === true ? "1" : v === false ? "0" : typeof v === "string" ? v : JSON.stringify(v));
  const a = leaves(before, "", new Map()), b = leaves(after, "", new Map());
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => !(a.has(k) && b.has(k) && text(a.get(k)) === text(b.get(k))));
  return { restart: changed.some((k) => !LIVE_SETTINGS.includes(k)), changed };
}

// Mutates incoming like the firmware; returns { problem, ignoredPassword }.
// currentHa1 / mustChange: the admin password in force, as stored.
export function applyConfigPolicy(incoming, b, currentHa1, mustChange) {
  const r = { problem: null, ignoredPassword: false };
  if (!isObj(incoming.general)) incoming.general = {};
  if (mustChange) return { ...r, problem: "Set an admin password first (Change Password)" };
  const pass = typeof incoming.general.pswd === "string" ? incoming.general.pswd : null;
  r.ignoredPassword = pass !== null && !isDefault(pass) && pass !== currentHa1 && adminHa1(pass) !== currentHa1;
  putAdmin(incoming.general, currentHa1, false);
  if (!isObj(incoming.network) || !isObj(incoming.hardware)) return { ...r, problem: "The settings have no network or hardware section" };
  const bytes = (v) => Buffer.byteLength(str(v));
  const network = isObj(incoming.network) ? incoming.network : null;
  if (network && network.wmode === 1) {
    if (str(network.ssid) === "") return { ...r, problem: "Access point SSID must not be empty" };
    const n = str(network.pswd).length;
    if (!(n === 0 || (n >= 8 && n <= 63))) return { ...r, problem: "Access point password must be empty (open) or 8-63 characters" };
  }
  if (network) {
    if (bytes(network.ssid) > 32) return { ...r, problem: "Wi-Fi SSID must be at most 32 characters" };
    if (bytes(network.pswd) > 64) return { ...r, problem: "Wi-Fi password must be at most 64 characters" };
    const io = network.idleoff;
    if (!(io === undefined || io === null || [0, 1].includes(jsonInt(io, -1)))) return { ...r, problem: "Turn Wi-Fi off when nobody is connected must be on or off" };
    const im = network.idlemins;
    if (!(im === undefined || im === null)) {
      const mins = jsonInt(im, -1);
      if (mins < 1 || mins > 1440) return { ...r, problem: "Turn Wi-Fi off after must be 1-1440 minutes" };
    }
  }
  const hw = isObj(incoming.hardware) ? incoming.hardware : null;
  if (hw) {
    if ("numrelays" in hw) hw.numrelays = clampRelays(jsonInt(hw.numrelays, 1));
    const relays = clampRelays(jsonInt(hw.numrelays, 1));
    const maxOpen = jsonInt(hw.maxOpenDoorTime, 0);
    if (maxOpen < 0 || maxOpen > 600) return { ...r, problem: "Maximum open time must be 0-600 seconds" };
    const zeroOrOne = (v) => v === undefined || v === null || [0, 1].includes(jsonInt(v, -1));
    for (let i = 0; i < relays; i++) {
      const rel = i === 0 ? hw : isObj(hw["relay" + (i + 1)]) ? hw["relay" + (i + 1)] : {};
      if (bytes(rel.doorname) > 63) return { ...r, problem: "Door names must be at most 63 characters" };
      const t = rel.rtime;
      if (t !== undefined && t !== null) {
        const ms = jsonInt(t, 400);
        if (ms < 100 || ms > 30000) return { ...r, problem: "Relay activate time must be 100-30000 ms" };
      }
      if (!zeroOrOne(rel.rtype)) return { ...r, problem: "Relay type must be Active High or Active Low" };
      if (!zeroOrOne(rel.rhold)) return { ...r, problem: "When the relay is on, the door must be Unlocked or Locked" };
      if (!zeroOrOne(rel.ltype)) return { ...r, problem: "Lock type must be Momentary or Continuous" };
    }
    if (jsonInt(hw.readertype, 0) !== 1) return { ...r, problem: "Reader 1 must be a Wiegand reader (MFRC522, PN532 and RDM6300 are no longer supported)" };
    if (isObj(hw.reader1)) {
      const door = jsonInt(hw.reader1.door, -1);
      if (door < -1 || door >= relays) return { ...r, problem: "Reader 1 has an invalid door binding" };
    }
    if (isObj(hw.reader2) && jsonInt(hw.reader2.enabled, 0) === 1) {
      const door = jsonInt(hw.reader2.door, -2);
      if (door < 0 || door >= relays) return { ...r, problem: "Reader 2 must be bound to a configured door" };
    }
  }
  const ntp = isObj(incoming.ntp) ? incoming.ntp : null;
  if (ntp && ntp.interval !== undefined && ntp.interval !== null) {
    const minutes = jsonInt(ntp.interval, -1);
    if (minutes < 0 || minutes > 10080) return { ...r, problem: "NTP sync interval must be 0-10080 minutes" };
  }
  const rtcType = ntp && isObj(ntp.rtc) ? ntp.rtc.type : undefined;
  if (!(rtcType === undefined || rtcType === null || [0, 1, 2].includes(jsonInt(rtcType, -1)))) return { ...r, problem: "RTC type must be None, DS3231 or DS1307" };
  if (hw || ntp) {
    const pinProblem = checkConfigPins(hw || {}, b, ntp);
    if (pinProblem) return { ...r, problem: pinProblem };
  }
  if (isObj(incoming.mqtt)) {
    const dc = incoming.mqtt.doorcontrol;
    if (!(dc === undefined || dc === null || [0, 1].includes(jsonInt(dc, -1)))) return { ...r, problem: "MQTT door control must be Enabled or Disabled" };
    const port = incoming.mqtt.port;
    if (port !== undefined && port !== null) {
      const n = jsonInt(port, -1);
      if (n < 1 || n > 65535) return { ...r, problem: "MQTT port must be 1-65535" };
    }
    const cu = incoming.mqtt.carduid;
    if (!(cu === undefined || cu === null || [0, 1, 2].includes(jsonInt(cu, -1)))) return { ...r, problem: "Card number in MQTT must be Off, Last 4 or Full" };
  }
  const host = str(incoming.general.hostnm);
  if (host.length > 32 || !/^[A-Za-z0-9-]*$/.test(host)) return { ...r, problem: "Host name must be at most 32 letters, digits and hyphens" };
  const hours = incoming.general.openinghours;
  if (!Array.isArray(hours)) return { ...r, problem: "Opening hours are required" };
  if (hours.length !== 7) return { ...r, problem: "Opening hours must contain seven days" };
  if (!hours.every((d) => typeof d === "string" && /^[01]{24}$/.test(d))) return { ...r, problem: "Each opening-hours day must contain exactly 24 zero/one values" };
  return r;
}

// ---- user records: a JavaScript copy of core/checkUserRecord ---------------
// test/vectors/user-records.json runs through both.
function userEpoch(v) {
  let d;
  if (typeof v === "string") {
    if (!/^-?\d{1,10}$/.test(v)) return null;
    d = Number(v);
  } else if (typeof v === "number") d = v;
  else return null;
  if (!isFinite(d) || d > 4294967295) return null;
  return d <= 0 ? 0 : Math.floor(d);
}

// Returns { problem } or { stored }: the record the device writes to /P/<uid>.
export function checkUserRecord(msg) {
  const uid = msg.uid;
  if (typeof uid !== "string" || !/^[0-9A-Za-z]{1,32}$/.test(uid)) return { problem: "Invalid uid: 1-32 letters and digits" };
  const user = msg.user ?? "";
  if (typeof user !== "string") return { problem: "User name must be text" };
  if (Buffer.byteLength(user, "utf8") > 64) return { problem: "User name is too long (at most 32 characters; 64 bytes)" };
  const pin = msg.pincode ?? "";
  if (typeof pin !== "string" || (pin !== "" && !/^\d{4,12}$/.test(pin))) return { problem: "PIN must be 4-12 digits" };
  const acc = [];
  for (const k of ["acctype", "acctype2", "acctype3", "acctype4"]) {
    const a = msg[k] === undefined || msg[k] === null ? 0 : jsonInt(msg[k], -1);
    if (![0, 1, 99].includes(a)) return { problem: "Access must be 0 (disabled), 1 (always) or 99 (admin)" };
    acc.push(a);
  }
  if (msg.replaces !== undefined && msg.replaces !== null && (typeof msg.replaces !== "string" || !/^[0-9A-Za-z]{1,32}$/.test(msg.replaces))) return { problem: "Invalid uid to replace" };
  let since = 0;
  if (msg.validsince !== undefined && msg.validsince !== null && (since = userEpoch(msg.validsince)) === null) return { problem: "Valid since must be a date (Unix time)" };
  if (msg.validuntil === undefined || msg.validuntil === null) return { problem: "Valid until is required" };
  const until = userEpoch(msg.validuntil);
  if (until === null) return { problem: "Valid until must be a date (Unix time)" };
  return { stored: { uid: uid.toLowerCase(), user, pincode: pin, acctype: acc[0], acctype2: acc[1], acctype3: acc[2], acctype4: acc[3], validsince: since, validuntil: until } };
}

// core::checkUpdateImageHead (src/core/firmware.h), same messages.
export function checkUpdateImageHead(d, chip) {
  const want = chip === "esp32" ? 0 : 9;
  if (d.length < 36) return "The file is too short to be a firmware image";
  if (d[0] !== 0xe9) return "Not a firmware update image (it does not start with 0xE9). A -full-flash image is for a serial flash only: use ironframe-rfid-<version>.bin";
  if ((d[12] | (d[13] << 8)) !== want) return want === 0 ? "This image is for another chip, not the ESP32 (WROOM)" : "This image is for another chip, not the ESP32-S3";
  if (d.readUInt32LE(32) !== 0xabcd5432) return "Not a firmware update image: it starts with a bootloader (a -full-flash image). Use ironframe-rfid-<version>.bin";
  return null;
}

// The uploaded file out of a multipart/form-data body (the page sends
// FormData); any other body is the file itself.
function uploadedFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!m) return body;
  const start = body.indexOf("\r\n\r\n");
  const end = body.indexOf(Buffer.from("\r\n--" + (m[1] || m[2])), start);
  return start < 0 ? Buffer.alloc(0) : body.subarray(start + 4, end < 0 ? body.length : end);
}

export async function startSim({ webhDir, password = "admin", users = [], eventLines = [], latestLines = [], config, chip = "esp32s3" }) {
  const assets = loadAssets(webhDir);
  // the firmware's policy (webserver.esp), so the UI is tested under it
  const csp = /CONTENT_SECURITY_POLICY\[\] = "([^"]+)"/.exec(fs.readFileSync(path.join(webhDir, "..", "webserver.esp"), "utf8"))[1];
  const board = policyBoard(chip, path.join(webhDir, "..", "core", "pins.h"));
  const pins = board.pins;
  const state = {
    ha1: FACTORY_HA1, // the admin password in force, as stored (set by boot() below)
    mustChange: true,
    migrations: 0, // boots that found the admin password in clear and hashed it
    config: config === null ? null : config ?? {
      command: "configfile",
      network: { ssid: "site-wifi", pswd: "wifi-secret-123", wmode: 0, dhcp: 1, bssid: "", hide: 0, idleoff: 0, idlemins: 15, fallbackmode: 0, apip: "192.168.4.1", apsubnet: "255.255.255.0", ip: "", subnet: "", gateway: "", dns: "" },
      hardware: { readertype: 1, wgd0pin: 4, wgd1pin: 5, rpin: 21, rtype: 1, ltype: 0, rtime: 400, doorname: "Door", numrelays: 1, wifipin: 255, doorstatpin: 255, doorbellpin: 255, accessdeniedpin: 255, beeperpin: 255, ledwaitingpin: 255, openlockpin: 255, maxOpenDoorTime: 0, useridstoragemode: "hexadecimal", removeparitybits: 1, requirepincodeafterrfid: 0, allowpincodeonly: 0, rdm6300pin: 18, sspin: 10, rfidgain: 32 },
      general: { hostnm: "ironframe-rfid", restart: 0, pswd: password, openinghours: Array(7).fill("1".repeat(24)) },
      mqtt: { enabled: 0, host: "", port: 1883, topic: "", autotopic: 0, user: "", pswd: "mqtt-secret-456", syncrate: 180, mqttlog: 0, mqttha: 0, remoteadmin: 0, doorcontrol: 0 },
      ntp: { server: "pool.ntp.org", interval: 30, tzinfo: "" },
    },
    users,
    files: { "/eventlog.json": makeLogFile(eventLines), "/latestlog.json": makeLogFile(latestLines) },
    tokens: new Set(),
    nonces: new Map(),
    opaque: crypto.randomBytes(16).toString("hex"),
    scanList: [],
    nvs: {}, // survives restart(): the pending admin password's hash before the first save (ironframe/adminha1; adminpw held it in clear up to 1.4.1)
    bootConfig: null, // the config the device started with: relay pins take effect after Save & Reboot
    relayTests: [],
    timeTrusted: false, // no NTP, no RTC: the clock is lost at power-up
    rtc: { state: "off", time: 0 }, // status.rtc (clock.esp): off | ok | lost | missing, as the board found it at start
    apOpen: false,
    settimes: [],
    userfiles: [], // as sent
    storedUsers: [], // as the device stores them (checkUserRecord)
    refusedUserfiles: [],
    refuseUserfile: null, // test knob: refuse the next userfile with this message
    stuckUids: [], // test knob: user records that cannot be removed (a userfile replacing one is undone)
    removes: [],
    holdRemove: false,
    holdUserfile: false, // test knob: answer "userfile" only when the test releases it
    heldUserfiles: [],
    refuseConfig: null, // test knob: refuse the next configfile with this message
    heldRemoves: [],
    failures: 0,
    blockedUntil: 0,
    counts: {},
    savedConfigs: [],
    configSaves: [], // per accepted configfile: { restart, changed keys }
    liveApplies: 0, // saves applied without a restart
    restartPending: false, // a save or restart answered: the firmware reboots next (restart() clears it)
    restarts: 0, // restart() calls (power cycles and reboots)
    rejectedConfigs: [],
    stepNonces: new Map(), // step-up challenges: nonce -> issued (ms)
    rejectedUpgrades: [],
  };
  // the password as an older firmware left it: in clear in config.json, or
  // (no config yet) pending in NVS; the first boot hashes it
  if (state.config) state.config.general.pswd = password;
  else if (acceptable(password)) state.nvs.adminpw = password;
  boot();
  state.bootConfig = state.config && JSON.parse(JSON.stringify(state.config));

  // as webserver.esp hostIsThisDevice / core::hostAllowed: the simulator's
  // Wi-Fi address is 127.0.0.1
  function hostIsThisDevice(req) {
    const host = req.headers.host || "";
    if (!host) return true;
    const m = /^([^:]*)(?::(\d{1,5}))?$/.exec(host);
    if (!m) return false;
    const name = m[1].replace(/\.$/, "").toLowerCase();
    const hn = ((state.config && state.config.general && state.config.general.hostnm) || "ironframe-rfid").toLowerCase();
    const apip = (state.config && state.config.network && state.config.network.apip) || "192.168.4.1";
    return name !== "" && ["127.0.0.1", apip, "192.168.4.1", hn, hn + ".local"].includes(name);
  }

  const server = http.createServer((req, res) => {
    if (state.offline) return req.socket.destroy(); // test knob: out of reach (a Wi-Fi blip)
    if (!hostIsThisDevice(req)) {
      state.misdirected = (state.misdirected || 0) + 1;
      res.writeHead(421, { "Content-Type": "text/plain" });
      return res.end("Misdirected request: open this reader by its IP address or its name");
    }
    const url = new URL(req.url, "http://x");
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (p === "/login") return handleLogin(req, res);
    if (p === "/session") {
      // as the firmware: 204 a live token, 401 not (never a failed login)
      state.counts.session = (state.counts.session || 0) + 1;
      res.writeHead(state.tokens.has(url.searchParams.get("token") || req.headers["x-session-token"]) ? 204 : 401, { "Cache-Control": "no-store" });
      return res.end();
    }
    if (p === "/update" && req.method === "POST") return handleUpdate(req, res, url);
    const route = ROUTES[p];
    if (!route) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const etag = '"sim-build"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": route[1], "Content-Encoding": "gzip", ETag: etag, "Cache-Control": "no-cache", ...(route[1] === "text/html" ? { "Content-Security-Policy": csp + (/^[A-Za-z0-9.:[\]-]{1,64}$/.test(req.headers.host || "") ? " ws://" + req.headers.host : "") } : {}) });
    res.end(assets[route[0]]);
  });

  // firmware upload: needs a session, refused while the factory password is in force
  // door.esp statusDoors: each configured door, locked (the simulated relays
  // are always locked unless a test says otherwise), open with a contact
  function statusDoors() {
    const hw = state.config && state.config.hardware;
    if (!hw) return [];
    const n = Math.max(1, Math.min(4, jsonInt(hw.numrelays, 1)));
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = i === 0 ? hw : hw["relay" + (i + 1)] || {};
      const d = { name: r.doorname || (n > 1 ? "Door " + (i + 1) : "Door"), relay: jsonInt(r.rpin, 255) !== 255, locked: jsonInt(r.rpin, 255) !== 255 && !(state.unlocked || []).includes(i) };
      if (jsonInt(r.doorstatpin, 255) !== 255) Object.assign(d, { open: (state.doorsOpen || []).includes(i), tamper: false });
      out.push(d);
    }
    return out;
  }

  // as core/settings.h readerOptions: a reader set to a door that does not
  // exist is unbound, and Status marks it (wsResponses.esp "nodoor")
  function readerNoDoor(reader) {
    const hw = state.bootConfig && state.bootConfig.hardware;
    if (!hw) return false;
    const n = Math.min(4, Math.max(1, Number(hw.numrelays) || 1));
    const r = hw["reader" + reader];
    if (!r || r.door === undefined) return false;
    const door = jsonInt(r.door, 0);
    return !((door >= 0 && door < n) || (reader === 1 && door === -1));
  }

  // core::stepUpProofOk with a one-use challenge from "stepup" (two minutes)
  function stepUpOk(token, nonce, proof, action) {
    const issued = state.stepNonces.get(nonce);
    state.stepNonces.delete(nonce);
    state.stepUps = (state.stepUps || []).concat(action);
    if (!issued || Date.now() - issued > 120000 || typeof token !== "string") return false;
    return proof === md5(`${state.ha1}:${token}:${nonce}:${action}`);
  }

  function handleUpdate(req, res, url) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.counts.update = (state.counts.update || 0) + 1;
      if (state.mustChange) {
        res.writeHead(403);
        return res.end("Change the default admin password first");
      }
      const updToken = url.searchParams.get("token") || req.headers["x-session-token"];
      if (!state.tokens.has(updToken)) {
        res.writeHead(401);
        return res.end("Unauthorized");
      }
      if (!stepUpOk(updToken, req.headers["x-admin-nonce"], req.headers["x-admin-proof"], "update")) {
        res.writeHead(403, { Connection: "close" });
        return res.end("The admin password was not confirmed, so nothing was installed. Enter it and try again.");
      }
      // as the firmware: the reason, never a bare FAIL
      if (state.updateBusy) {
        res.writeHead(409, { Connection: "close" });
        return res.end("Another firmware upload is in progress");
      }
      const bad = checkUpdateImageHead(uploadedFile(Buffer.concat(chunks), req.headers["content-type"]), chip);
      if (bad) {
        res.writeHead(400, { Connection: "close" });
        return res.end(bad);
      }
      if (state.updateFlashError) { // test knob: Update.errorString() of a failed write
        res.writeHead(500, { Connection: "close" });
        return res.end("Writing the image failed: " + state.updateFlashError);
      }
      state.updatesAccepted = (state.updatesAccepted || 0) + 1;
      res.writeHead(200, { Connection: "close" });
      res.end("OK");
    });
  }

  // as core::NonceStore: 8 slots, an address holding 2 live nonces replaces
  // its own oldest, otherwise a free or stale slot, otherwise the oldest
  function issueNonce(nonce, owner) {
    const now = Date.now(), live = (v) => now - v.at <= 120000;
    const mine = [...state.nonces].filter(([, v]) => live(v) && v.owner === owner).sort((a, b) => a[1].at - b[1].at);
    if (mine.length >= 2) state.nonces.delete(mine[0][0]);
    else if (state.nonces.size >= 8) {
      const stale = [...state.nonces].find(([, v]) => !live(v));
      state.nonces.delete(stale ? stale[0] : [...state.nonces].sort((a, b) => a[1].at - b[1].at)[0][0]);
    }
    state.nonces.set(nonce, { at: now, owner });
  }

  function handleLogin(req, res) {
    if (Date.now() < state.blockedUntil) {
      res.writeHead(429, { "Retry-After": String(Math.ceil((state.blockedUntil - Date.now()) / 1000)) }); // as the firmware
      return res.end("Too many failed logins, try again later");
    }
    const auth = req.headers.authorization || "";
    let ok = false;
    // Digest only (Basic refused), and only with a nonce issued here and not yet used
    if (auth.startsWith("Digest ")) {
      const d = parseDigest(auth);
      const issued = (state.nonces.get(d.nonce) || {}).at;
      state.nonces.delete(d.nonce);
      const fresh = issued !== undefined && Date.now() - issued <= 120000;
      const ha1 = state.ha1; // stored as the hash (passwordIsHash)
      const ha2 = md5(`GET:${d.uri}`);
      const expected = d.qop ? md5(`${ha1}:${d.nonce}:${d.nc}:${d.cnonce}:${d.qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
      ok = fresh && d.opaque === state.opaque && d.username === "admin" && d.realm === REALM && d.response === expected;
    }
    if (!ok) {
      if (auth) {
        state.failures++;
        if (state.failures >= 5) state.blockedUntil = Date.now() + 5 * 60 * 1000;
      }
      const nonce = crypto.randomBytes(16).toString("hex");
      issueNonce(nonce, req.socket.remoteAddress);
      res.writeHead(401, { "WWW-Authenticate": `Digest realm="${REALM}", qop="auth", nonce="${nonce}", opaque="${state.opaque}"` });
      return res.end();
    }
    state.failures = 0;
    const token = crypto.randomBytes(16).toString("hex");
    state.tokens.add(token);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ token, mustchangepassword: state.mustChange }));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on("upgrade", (req, socket, head) => {
    if (state.offline) return socket.destroy();
    state.wsUpgrades = (state.wsUpgrades || 0) + 1;
    if (state.upgradeDelayMs) { // test knob: a slow connect
      const delay = state.upgradeDelayMs;
      state.upgradeDelayMs = 0;
      return setTimeout(() => upgrade(req, socket, head), delay);
    }
    if (state.upgradeDropMs) { // test knob: a connect that hangs, then fails (plan 1.9.1 D1)
      const hold = state.upgradeDropMs;
      state.upgradeDropMs = 0;
      return setTimeout(() => socket.destroy(), hold);
    }
    upgrade(req, socket, head);
  });
  function upgrade(req, socket, head) {
    const url = new URL(req.url, "http://x");
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin.replace(/^[a-z]+:\/\//, "").toLowerCase() === (req.headers.host || "").toLowerCase();
    // ?token= or the X-Session-Token header, as webserver.esp hasValidSession
    // and websocket.esp WS_EVT_CONNECT (plan 1.9.1 B5)
    const token = url.searchParams.get("token") || req.headers["x-session-token"] || null;
    if (state.refuseUpgrades) {
      // test knob: the device answers HTTP but will not take a WebSocket now
      // (busy, short of memory), whatever the token
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return socket.destroy();
    }
    if (url.pathname !== "/ws" || !hostIsThisDevice(req) || !sameOrigin || !state.tokens.has(token)) {
      state.rejectedUpgrades.push({ origin, token });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionToken = token; // logout closes every socket of its token
      wss.emit("connection", ws);
    });
  }

  const send = (ws, o) => ws.send(typeof o === "string" ? o : JSON.stringify(o));
  const result = (ws, of, ok, message) => send(ws, { command: "result", resultof: of, result: ok, ...(message ? { message } : {}) });

  wss.on("connection", (ws) => {
    if (state.mustChange) send(ws, { command: "mustchangepassword" });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return result(ws, "message", false, "The device could not read the message (not valid JSON)"); // as the firmware
      }
      const cmd = msg.command;
      if (typeof cmd !== "string") return result(ws, "message", false, "The message has no command");
      state.counts[cmd] = (state.counts[cmd] || 0) + 1;
      if (state.mustChange && !["status", "gettime", "setpassword", "getconf", "logout"].includes(cmd)) {
        return result(ws, cmd, false, "Change the default admin password first");
      }
      if (STEP_UP_COMMANDS.includes(cmd) && !stepUpOk(ws.sessionToken, msg.stepnonce, msg.stepproof, cmd)) {
        state.stepUpRefused = (state.stepUpRefused || []).concat(cmd);
        return result(ws, cmd.startsWith("testrelay") ? "testrelay" : cmd, false, STEP_UP_REFUSED);
      }
      switch (cmd) {
        case "status":
          // ssid: a fresh board (no config) runs its own hotspot, IRONFRAME-RFID-<last 3 MAC bytes> (wifi.esp)
          return send(ws, { command: "status", heap: 150000, heapmaxalloc: 110580, heapmin: 132000, heaptotal: chip === "esp32" ? 300000 : 380000, chipid: "a1b2c3", chipmodel: chip === "esp32" ? "ESP32-D0WD-V3" : "ESP32-S3", chip, pinsio: pins.io, pinsinput: pins.input, cpu: 240, psram: 8388608, sketchsize: 1123189, availsize: 2200000, availspiffs: 1300000, spiffssize: 1441792, uptime: "00:10:00", version: "1.0.0 (abc1234)", hostname: "ironframe-rfid", defaultpassword: state.mustChange, timetrusted: state.timeTrusted, rtc: state.rtc, apopen: state.apOpen, resetreason: state.resetReason || "power on", crashdump: !!state.crashDump, wiegand: (state.wiegand || [{ reader: 1, glitches: 0, badframes: 0, parity: 0, overruns: 0 }]).map((w) => (readerNoDoor(w.reader) ? { ...w, nodoor: true } : w)), ssid: state.config ? "site-wifi" : "IRONFRAME-RFID-ddeeff", dns: "192.168.1.1", mac: "AA:BB:CC:DD:EE:FF", ip: "192.168.1.50", gateway: "192.168.1.1", netmask: "255.255.255.0",
            // as wsResponses.esp since 1.9 (plan 1.9 C3)
            configured: !!state.config, doors: statusDoors(), ...(state.lastAccess ? { lastaccess: state.lastAccess } : {}) });
        case "gettime":
          return send(ws, { command: "gettime", epoch: state.timeTrusted ? Math.floor(Date.now() / 1000) : 120 });
        case "settime":
          // a set clock moves only with the admin password (as websocket.esp wsSetTime)
          if (state.timeTrusted && !stepUpOk(ws.sessionToken, msg.stepnonce, msg.stepproof, "settime")) {
            state.stepUpRefused = (state.stepUpRefused || []).concat(cmd);
            return result(ws, "settime", false, STEP_UP_REFUSED);
          }
          state.settimes.push(msg.epoch);
          if (msg.epoch > 1451606400) state.timeTrusted = true;
          return send(ws, { command: "gettime", epoch: msg.epoch });
        case "getconf":
          if (!state.config) return; // fresh device: no config.json, no reply
          return send(ws, maskSecrets(state.config));
        case "setpassword":
        {
          // as core::openPasswordChange: the new HA1 encrypted under the
          // current one and this socket's token, with a proof (review 6)
          const isHex = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
          const tok = ws.sessionToken || "";
          let next = null;
          if (isHex(msg.ha1enc) && isHex(msg.proof) && tok) {
            const key = Buffer.from(md5(`${state.ha1}:${tok}:set-key`), "hex");
            const n = Buffer.from(msg.ha1enc, "hex").map((b, i) => b ^ key[i]).toString("hex");
            if (md5(`${state.ha1}:${tok}:${n}`) === msg.proof) next = n;
          }
          state.setpasswords = (state.setpasswords || []).concat([msg]);
          if (!next) return result(ws, "setpassword", false, "The current password is wrong");
          const len = jsonInt(msg.len, 0);
          if (len < 8 || len > 64 || next === FACTORY_HA1) return result(ws, "setpassword", false, "Password must be 8-64 characters and not 'admin'");
          state.ha1 = next;
        }
          state.mustChange = false;
          // as the firmware: its hash into config.json, or NVS while there is none yet
          if (state.config) putAdmin(state.config.general, state.ha1, false);
          else { state.nvs.adminha1 = state.ha1; delete state.nvs.adminpw; }
          result(ws, "setpassword", true);
          state.tokens.clear();
          setTimeout(() => { for (const c of wss.clients) c.close(1008, "Session ended"); }, 500);
          return;
        case "logout": {
          // as websocket.esp: the socket's own session, not the message's token
          const own = ws.sessionToken;
          state.tokens.delete(own);
          for (const c of wss.clients) if (c !== ws && c.sessionToken === own) c.close(1008, "Session ended");
          ws.close();
          return;
        }
        case "testrelay1":
        case "testrelay2":
        case "testrelay3":
        case "testrelay4": {
          // as websocket.esp: only a relay with a pin in the running config
          // (1.0 drove GPIO0 here on a device that had never been saved)
          const n = Number(cmd.slice(9)), hw = state.bootConfig && state.bootConfig.hardware;
          const relays = hw ? Math.min(4, Math.max(1, Number(hw.numrelays) || 1)) : 1;
          const pin = !hw ? 255 : Number(n === 1 ? hw.rpin : (hw["relay" + n] || {}).rpin);
          if (n > relays || !(pin >= 0 && pin < 255)) return result(ws, "testrelay", false, "This relay has no pin yet: set it under Hardware, then Save & Reboot");
          state.relayTests.push({ relay: n, pin });
          return send(ws, { command: "giveAccess", relay: n });
        }
        case "scan":
          return send(ws, { command: "ssidlist", list: state.scanList });
        case "setlogging":
          if (!state.config) return result(ws, "setlogging", false, "Save the device settings first (Settings), then set logging");
          state.config.general.logging = msg.enabled === 0 ? 0 : 1;
          state.loggingChanges = (state.loggingChanges || []).concat(state.config.general.logging);
          return result(ws, "setlogging", true);
        case "configfile": {
          const incoming = msg;
          // the step-up answer is not a setting (as websocket.esp)
          const stepNonce = incoming.stepnonce, stepProof = incoming.stepproof;
          delete incoming.stepnonce;
          delete incoming.stepproof;
          if (state.refuseConfig) {
            const why = state.refuseConfig;
            state.refuseConfig = null;
            state.rejectedConfigs.push(why);
            return result(ws, "configfile", false, why);
          }
          mergeSecrets(incoming, state.config || {});
          const policy = applyConfigPolicy(incoming, board, state.ha1, state.mustChange);
          if (policy.problem) {
            state.rejectedConfigs.push(policy.problem);
            return result(ws, "configfile", false, policy.problem);
          }
          // as websocket.esp: live or restart against the stored file, and
          // always restart when a restart is already due
          const change = compareSettings(state.config, incoming);
          if (state.config && change.changed.some(stepUpNeededFor) && !stepUpOk(ws.sessionToken, stepNonce, stepProof, "settings")) {
            state.rejectedConfigs.push(STEP_UP_REFUSED);
            return result(ws, "configfile", false, STEP_UP_REFUSED);
          }
          const live = !change.restart && !state.restartPending;
          state.config = incoming;
          delete state.nvs.adminha1; // config.json holds the password from now on
          delete state.nvs.adminpw;
          state.savedConfigs.push(JSON.parse(JSON.stringify(incoming)));
          state.configSaves.push({ restart: !live, changed: change.changed });
          if (live) {
            // applied at once: the running settings are the saved ones (only live keys differ)
            state.bootConfig = JSON.parse(JSON.stringify(incoming));
            state.liveApplies++;
          } else state.restartPending = true; // the firmware reboots now; the test calls restart()
          return send(ws, { command: "result", resultof: "configfile", result: true, restart: !live });
        }
        case "userlist": {
          const page = Math.max(1, msg.page | 0);
          // as wsResponses.esp sendUserList: haspin, the PIN itself for a backup only
          const withPins = jsonInt(msg.backup, 0) === 1;
          state.userlistRequests = (state.userlistRequests || []).concat([{ page, backup: withPins }]);
          const list = state.users.slice((page - 1) * USERS_PER_PAGE, page * USERS_PER_PAGE).map((u) => {
            const { pincode, ...rest } = u;
            return withPins ? { ...rest, haspin: !!pincode, pincode: pincode || "" } : { ...rest, haspin: !!pincode };
          });
          const answer = () => {
            // test knob: a page that does not fit the device's document (wsResponses.esp)
            if (state.userlistOverflow) return result(ws, "userlist", false, "The user list page is too large to send; shorten some names");
            send(ws, { command: "userlist", page, haspages: Math.ceil(state.users.length / USERS_PER_PAGE), list });
            result(ws, "userlist", true);
          };
          if (state.userlistDelayMs) return void setTimeout(answer, state.userlistDelayMs); // test knob: a slow user list
          return answer();
        }
        case "geteventlog":
        case "getlatestlog": {
          const kind = cmd === "geteventlog" ? "eventlist" : "latestlist";
          const name = msg.filename || (cmd === "geteventlog" ? "/eventlog.json" : "/latestlog.json");
          if (!validLogName(name)) return result(ws, kind, false, "Invalid log file name");
          const text = state.files[name] || "";
          const page = Math.max(1, msg.page | 0);
          const pos = Math.max(0, msg.pos | 0);
          const r = readLogPage(text, pos, LOG_ITEMS_PER_PAGE);
          const consumed = Math.max(1, r.nextPos - pos);
          const haspages = r.eof ? page : page + Math.max(1, Math.ceil((text.length - r.nextPos) / consumed));
          send(ws, { command: kind, page, haspages, nextpos: r.nextPos, eof: r.eof, list: r.items });
          return result(ws, kind, true);
        }
        case "listfiles": {
          const list = Object.keys(state.files).map((f) => ({ filename: f, filesize: state.files[f].length }));
          send(ws, { command: "listfiles", page: 1, haspages: 1, list });
          return result(ws, "listfiles", true);
        }
        case "logMaintenance":
          if (!validLogName(msg.filename || "")) return result(ws, "logfileMaintenance", false, "Invalid log file name");
          return result(ws, "logfileMaintenance", true);
        case "remove":
          if (!/^[0-9A-Za-z]{1,32}$/.test(msg.uid || "")) return result(ws, "remove", false, "Invalid uid");
          state.users = state.users.filter((u) => u.uid !== msg.uid);
          state.removes.push(msg.uid);
          {
            // to every tab, naming the user (as websocket.esp wsRemove)
            const done = () => { for (const c of wss.clients) send(c, { command: "result", resultof: "remove", result: true, uid: msg.uid }); };
            if (state.holdRemove) return state.heldRemoves.push(done); // reply later
            return done();
          }
        case "userfile": {
          if (state.refuseUserfile) {
            const why = state.refuseUserfile;
            state.refuseUserfile = null;
            return result(ws, "userfile", false, why);
          }
          // keeppin: an empty PIN keeps the stored one (as websocket.esp wsUserFile)
          if (jsonInt(msg.keeppin, 0) === 1 && !(msg.pincode || "")) {
            const from = String(typeof msg.replaces === "string" ? msg.replaces : msg.uid || "").toLowerCase();
            const had = state.users.find((x) => x.uid === from);
            if (!had) return result(ws, "userfile", false, "The stored PIN could not be read, so nothing was changed");
            msg = { ...msg, pincode: had.pincode || "" };
          }
          const rec = checkUserRecord(msg);
          if (rec.problem) {
            state.refusedUserfiles.push(rec.problem);
            return send(ws, { command: "result", resultof: "userfile", result: false, message: rec.problem, invalid: true });
          }
          const u = rec.stored;
          if (jsonInt(msg.create, 0) === 1 && state.users.some((x) => x.uid === u.uid)) {
            state.refusedUserfiles.push("exists");
            return result(ws, "userfile", false, "A user with this UID already exists");
          }
          {
            // core::userFileNeedsStepUp: a new user, admin access or a changed PIN
            const had = state.users.find((x) => x.uid === u.uid);
            const admin = [u.acctype, u.acctype2, u.acctype3, u.acctype4].some((a) => a === 99);
            const needs = jsonInt(msg.create, 0) === 1 || !had || admin || (u.pincode || "") !== ((had && had.pincode) || "");
            if (needs && !stepUpOk(ws.sessionToken, msg.stepnonce, msg.stepproof, "userfile")) {
              state.refusedUserfiles.push("stepup");
              return result(ws, "userfile", false, STEP_UP_REFUSED);
            }
          }
          // replaces: a changed UID, stored and the old record removed in
          // one command, or nothing changed (as websocket.esp wsUserFile)
          const old = typeof msg.replaces === "string" ? msg.replaces.toLowerCase() : "";
          if (old && old !== u.uid && state.stuckUids.includes(old)) {
            state.refusedUserfiles.push("replace");
            return result(ws, "userfile", false, "Could not remove the old UID, so nothing was changed");
          }
          state.userfiles.push(msg);
          state.storedUsers.push(u);
          state.users = state.users.filter((x) => x.uid !== u.uid && (!old || x.uid !== old)).concat([{ uid: u.uid, username: u.user, acctype: u.acctype, acctype2: u.acctype2, acctype3: u.acctype3, acctype4: u.acctype4, validsince: u.validsince, validuntil: u.validuntil, pincode: u.pincode }]);
          if (state.holdUserfile) return state.heldUserfiles.push(() => result(ws, "userfile", true)); // reply later
          return result(ws, "userfile", true);
        }
        case "restart": // the firmware answers, then reboots; state.counts records it
          state.restartPending = true;
          return result(ws, "restart", true);
        case "destroy":
          if (!stepUpOk(ws.sessionToken, msg.stepnonce, msg.stepproof, "destroy")) return result(ws, "destroy", false, STEP_UP_REFUSED);
          state.destroys = (state.destroys || 0) + 1;
          return result(ws, "destroy", true);
        case "stepup": {
          const nonce = crypto.randomBytes(16).toString("hex");
          state.stepNonces.set(nonce, Date.now());
          return send(ws, { command: "stepup", nonce });
        }
        case "clearevent":
          delete state.files["/eventlog.json"];
          return result(ws, "clearevent", true);
        case "clearlatest":
          delete state.files["/latestlog.json"];
          return result(ws, "clearlatest", true);
        default:
          return result(ws, "message", false, "Unknown command"); // as the firmware
      }
    });
  });

  // The admin password at start-up: from config.json, else pending in NVS,
  // else the factory one. One stored in clear (up to 1.4.1) is hashed and
  // written back once (config.esp loadConfiguration, storage.esp
  // pendingAdminHa1).
  function boot() {
    if (state.config) {
      if (!isObj(state.config.general)) state.config.general = {};
      const a = storedAdmin(state.config.general);
      if (a.migrated) {
        putAdmin(state.config.general, a.ha1, a.mustChange);
        state.migrations++;
      }
      state.ha1 = a.ha1;
      state.mustChange = a.mustChange;
    } else if (isHa1(state.nvs.adminha1)) {
      state.ha1 = state.nvs.adminha1;
      state.mustChange = false;
    } else if (acceptable(state.nvs.adminpw)) {
      state.ha1 = state.nvs.adminha1 = adminHa1(state.nvs.adminpw);
      delete state.nvs.adminpw;
      state.mustChange = false;
      state.migrations++;
    } else {
      state.ha1 = FACTORY_HA1;
      state.mustChange = true;
    }
  }

  // Power cycle: RAM is lost (sessions, nonces, the clock), flash and NVS
  // stay. (On the board, 1.0 kept a password set before the first save in
  // RAM only, so "admin" worked again after a restart.)
  function restart() {
    for (const c of wss.clients) c.terminate();
    state.tokens.clear();
    state.nonces.clear();
    state.timeTrusted = false;
    state.restartPending = false;
    state.restarts++;
    state.bootConfig = state.config && JSON.parse(JSON.stringify(state.config));
    boot();
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    restart,
    dropSockets: () => { for (const c of wss.clients) c.terminate(); }, // connection lost, sessions kept
    broadcast: (raw) => { for (const c of wss.clients) c.send(raw); },
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      server.close(r);
      server.closeAllConnections(); // keep-alive sockets of a browser context that stays open
    }),
  };
}
