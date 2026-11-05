// WebSocket protocol check: every command the web UI sends must be handled
// by the firmware (wsCommands[] in src/websocket.esp) and by the test
// simulator (test/e2e/device-sim.mjs), and the simulator must not invent
// commands the firmware does not have. Commands allowed before the factory
// password is changed must be the same in both, and so must the commands
// that need the admin password as well (stepUp, plan 1.9.1 B1), which the
// UI sends through withStepUp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : " " + detail}`);
  if (!cond) failures++;
};

const fw = read("src/websocket.esp");
const table = fw.slice(fw.indexOf("static const WsCommand wsCommands[]"), fw.indexOf("void processWsMessage"));
// {name, beforePasswordChange, stepUp, handler}
const fwRows = [...table.matchAll(/\{"([A-Za-z0-9]+)",\s*(true|false),\s*(true|false),\s*\w+\}/g)];
const fwCommands = new Map(fwRows.map((m) => [m[1], m[2] === "true"]));
const fwStepUp = new Set(fwRows.filter((m) => m[3] === "true").map((m) => m[1]));

// the UI's scripts (src/websrc/js/*.js, bundled into the served esprfid.js)
const jsDir = path.join(repo, "src/websrc/js");
const js = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort().map((f) => fs.readFileSync(path.join(jsDir, f), "utf8")).join("\n");
const uiCommands = new Set();
for (const m of js.matchAll(/command\\?"?\s*:\s*\\?"([A-Za-z]+)/g)) uiCommands.add(m[1]);
for (const m of js.matchAll(/\.command\s*=\s*"([A-Za-z]+)"/g)) uiCommands.add(m[1]);
// testrelay is sent as "testrelay" + n
if (uiCommands.delete("testrelay")) for (let n = 1; n <= 4; n++) uiCommands.add("testrelay" + n);
// replies the UI builds for itself, not commands it sends
for (const own of ["result", "giveAccess"]) uiCommands.delete(own);

const sim = read("test/e2e/device-sim.mjs");
const simCommands = new Set([...sim.matchAll(/case "([A-Za-z0-9]+)":/g)].map((m) => m[1]));
const simEarly = /!\[([^\]]*)\]\.includes\(cmd\)/.exec(sim);
const simBefore = new Set(simEarly ? [...simEarly[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]) : []);

check(fwCommands.size >= 20, `firmware command table parsed (${fwCommands.size} commands)`);
check(uiCommands.size >= 15, `UI commands found (${uiCommands.size})`);
for (const c of [...uiCommands].sort()) check(fwCommands.has(c), `UI command "${c}" is handled by the firmware`);
for (const c of [...fwCommands.keys()].sort()) check(simCommands.has(c), `firmware command "${c}" is handled by the simulator`);
for (const c of [...simCommands].filter((c) => /^[a-z]/i.test(c) && !fwCommands.has(c)).sort()) check(false, `simulator command "${c}" exists in the firmware`);
// fields that change what a command does: the UI, the firmware and the
// simulator must all have them (userfile "replaces": a changed UID stored
// and the old record removed in one command)
for (const [field, ui, inFw, inSim] of [["userfile replaces", /\.replaces\s*=/, /root\["replaces"\]/, /msg\.replaces/]]) {
  check(ui.test(js), `UI sends ${field}`);
  check(inFw.test(fw), `firmware reads ${field}`);
  check(inSim.test(sim), `simulator reads ${field}`);
}
// reply fields the UI shows: the firmware must send them and the simulator too
// (status "wiegand": each reader's noise counters)
for (const [field, ui, inFw, inSim] of [["status wiegand", /ajaxobj\.wiegand\b/, /createNestedArray\("wiegand"\)[\s\S]*o\["badframes"\][\s\S]*o\["overruns"\]/, /wiegand:[^\n]*badframes/],
  // a reader bound to a door that does not exist (plan 1.9.1 C3)
  ["status wiegand nodoor", /r\.nodoor === true/, /o\["nodoor"\] = true/, /nodoor/]]) {
  const responses = read("src/wsResponses.esp");
  check(ui.test(js), `UI reads ${field}`);
  check(inFw.test(responses), `firmware sends ${field}`);
  check(inSim.test(sim), `simulator sends ${field}`);
}
// the configfile answer's "restart": false = applied without a restart
// (core/livesettings.h); the UI then keeps the page instead of reloading
check(/progressFinished\(obj\.restart\)/.test(js), "UI reads configfile restart");
check(/r\["resultof"\] = "configfile";[\s\S]{0,120}r\["restart"\] =/.test(fw), "firmware sends configfile restart");
check(/resultof: "configfile", result: true, restart:/.test(sim), "simulator sends configfile restart");
// settings keys the UI saves that change device behaviour: the firmware must
// read them (core/settings.h) and check them (core/configpolicy.h), and the
// simulator's policy too (mqtt "carduid": the card number in MQTT access messages)
for (const [field, ui, inFw, inPolicy, inSim] of [["mqtt carduid", /m\.carduid\s*=/, /mqtt\["carduid"\]/, /mqtt\["carduid"\]/, /incoming\.mqtt\.carduid/]]) {
  check(ui.test(js), `UI saves ${field}`);
  check(inFw.test(read("src/core/settings.h")), `firmware reads ${field}`);
  check(inPolicy.test(read("src/core/configpolicy.h")), `firmware policy checks ${field}`);
  check(inSim.test(sim), `simulator checks ${field}`);
}
const simStepUpList = /STEP_UP_COMMANDS = \[([^\]]*)\]/.exec(sim);
const simStepUp = new Set(simStepUpList ? [...simStepUpList[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]) : []);
check(fwStepUp.size >= 9, `firmware step-up commands parsed (${fwStepUp.size})`);
check(JSON.stringify([...fwStepUp].sort()) === JSON.stringify([...simStepUp].sort()), "same commands need the admin password in the firmware and the simulator", `${[...fwStepUp]} vs ${[...simStepUp]}`);
for (const c of [...fwStepUp].sort()) {
  // sendWithStepUp / withStepUp with the command's name; Restart through
  // the progress dialog's step-up (ui.js)
  const action = /^testrelay\d$/.test(c) ? /(?:sendW|w)ithStepUp\(\s*"testrelay"\s*\+/ : c === "restart" ? /op === "restart" \? "restart"/ : new RegExp(`(?:sendW|w)ithStepUp\\(\\s*"${c}"`);
  check(action.test(js), `UI sends "${c}" through withStepUp`);
}
// the ones decided in the handler: the UI and the simulator ask for them too
for (const [c, inFw] of [["userfile", /userFileNeedsStepUp\([\s\S]{0,400}"userfile"\)/], ["settime", /deviceClock\.trusted && !stepUpValid\([^;]*"settime"\)/]]) {
  check(inFw.test(fw), `firmware asks the admin password for ${c} in its handler`);
  check(new RegExp(`withStepUp\\(\\s*"${c}"`).test(js), `UI can send ${c} through withStepUp`);
  check(new RegExp(`stepUpOk\\([^)]*"${c}"\\)`).test(sim), `simulator asks the admin password for ${c}`);
}
// no socket pointer from ws.client(id) in the firmware: the library frees it
// on the TCP task once its lock is released (review 8 V13); sockets are
// addressed by id, their address kept from the connect (WsAgeSlot.ip)
{
  const sources = fs.readdirSync(path.join(repo, "src")).filter((f) => /\.(esp|cpp|h)$/.test(f)).map((f) => read("src/" + f)).join("\n");
  const uses = sources.split("\n").filter((l) => /\bws\.client\(/.test(l) && !/^\s*\/\//.test(l));
  check(uses.length === 0, "the firmware never holds a ws.client(id) pointer", uses.join(" | "));
}
// giveAccess is Test's reply only, naming the relay; a granted card no
// longer broadcasts it to every tab (plan 1.9.1 D2)
{
  const sources = fs.readdirSync(path.join(repo, "src")).filter((f) => /\.(esp|cpp)$/.test(f)).map((f) => read("src/" + f)).join("\n");
  const sends = sources.split("\n").filter((l) => l.includes("giveAccess") && !/^\s*\/\//.test(l));
  check(sends.length === 1 && /\\"relay\\":%d/.test(sends[0]), "the firmware sends giveAccess only as Test's reply, naming the relay", sends.join(" | "));
}
const fwBefore = new Set([...fwCommands].filter(([, b]) => b).map(([c]) => c));
check(JSON.stringify([...fwBefore].sort()) === JSON.stringify([...simBefore].sort()), "same commands allowed before the password change", `${[...fwBefore]} vs ${[...simBefore]}`);

if (failures) {
  console.log(`PROTOCOL CHECK FAILED (${failures})`);
  process.exit(1);
}
console.log("PROTOCOL CHECK PASSED");
