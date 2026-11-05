// Live-settings check: the web UI's copy of the decision (src/websrc/js/policy.js
// settingsNeedRestart) and the simulator's (test/e2e/device-sim.mjs
// compareSettings) agree with the firmware (src/core/livesettings.h, run
// against the same vectors by test/native/tests.cpp) on every case of
// test/vectors/live-settings.json, and all three carry the same key list.
//   node test/check-live-settings.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { compareSettings, LIVE_SETTINGS as SIM_LIVE } from "./e2e/device-sim.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : " " + detail}`);
  if (!cond) failures++;
};

// policy.js as the browser runs it (plain script, globals)
const ui = vm.createContext({});
vm.runInContext(read("src/websrc/js/policy.js"), ui, { filename: "policy.js" });
check(typeof ui.settingsNeedRestart === "function", "policy.js defines settingsNeedRestart");

const header = read("src/core/livesettings.h");
const list = header.slice(header.indexOf("LIVE_SETTINGS[] = {"), header.indexOf("};", header.indexOf("LIVE_SETTINGS[] = {")));
const fwLive = [...list.matchAll(/^\s*"([A-Za-z0-9.]+)",/gm)].map((m) => m[1]);
check(fwLive.length >= 20, `firmware live list parsed (${fwLive.length} keys)`);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check(same(fwLive, Array.from(ui.LIVE_SETTINGS)), "policy.js LIVE_SETTINGS is the firmware's list", JSON.stringify(ui.LIVE_SETTINGS));
check(same(fwLive, SIM_LIVE), "device-sim.mjs LIVE_SETTINGS is the firmware's list", JSON.stringify(SIM_LIVE));

const vec = JSON.parse(read("test/vectors/live-settings.json"));
const apply = (cfg, set) => {
  for (const [p, val] of Object.entries(set || {})) {
    const keys = p.split("."), last = keys.pop();
    let o = cfg;
    for (const k of keys) o = o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? o[k] : (o[k] = {});
    if (val === null) delete o[last];
    else o[last] = structuredClone(val);
  }
  return cfg;
};
const uiBad = [], simBad = [];
for (const c of vec.cases) {
  const before = c.beforeNull ? null : apply(structuredClone(vec.base), c.before);
  const after = apply(structuredClone(vec.base), c.set);
  // the UI compares its copies: run it inside its own context
  const got = vm.runInContext(`settingsNeedRestart(${JSON.stringify(before)}, ${JSON.stringify(after)})`, ui);
  if (got !== c.restart) uiBad.push(`${c.name}: ${got ? "restart" : "live"}`);
  const sim = compareSettings(before, after);
  if (sim.restart !== c.restart) simBad.push(`${c.name}: ${sim.restart ? "restart" : "live"}`);
}
check(uiBad.length === 0, `the web UI agrees with the firmware on all ${vec.cases.length} live-settings vectors`, uiBad.join(" | "));
check(simBad.length === 0, `the simulator agrees with the firmware on all ${vec.cases.length} live-settings vectors`, simBad.join(" | "));
check(vec.cases.length >= 90, `at least 90 vectors (${vec.cases.length})`);
const liveCases = new Set(vec.cases.filter((c) => c.name.startsWith("live: ")).map((c) => Object.keys(c.set)[0]));
check(fwLive.every((k) => liveCases.has(k)), "every live key has a vector of its own");

if (failures) {
  console.log(`LIVE SETTINGS CHECK FAILED (${failures})`);
  process.exit(1);
}
console.log("LIVE SETTINGS CHECK PASSED");
