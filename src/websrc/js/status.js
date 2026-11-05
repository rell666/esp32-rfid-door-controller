// status.js: Status page.

// Status "Clock". Without NTP or an RTC the device forgets the time at
// every power cut; until it is set, dated and opening-hours users are refused.
function showClockState(trusted) {
  var e = byId("clockstate");
  if (!e) {
    return;
  }
  e.textContent = trusted ? "Set" : "Not set";
  var tile = byId("clocktile");
  if (tile) {
    tile.className = "tile " + (trusted ? "ok" : "bad");
  }
  show("clockbanner", !trusted);
}

// After login: give a device that has lost the time this browser's clock.
function setTimeIfUnset(status) {
  if (status.timetrusted === false && !status.defaultpassword) {
    sendWebsocket(JSON.stringify({ command: "settime", epoch: Math.floor(Date.now() / 1000) }));
  }
}

function formatBytes(n) {
  if (!(n >= 0)) return "";
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " bytes";
}

// a meter: green over half free, amber over a quarter, red below
function setMeter(id, free, total) {
  var bar = byId(id);
  if (!bar) return;
  var pct = total > 0 ? Math.max(0, Math.min(100, (free * 100) / total)) : 0;
  bar.style.width = pct + "%";
  bar.parentNode.className = "meter" + (pct > 50 ? "" : pct > 25 ? " warn" : " low");
}

// What each Wiegand reader threw away since the restart. Counts that keep
// rising point at the wiring (long cable, missing pull-ups, crosstalk).
function showWiegandNoise(list) {
  var cell = byId("wiegandnoise");
  if (!cell) {
    return;
  }
  cell.textContent = "";
  var readers = Array.isArray(list) ? list : [];
  show("wiegandnoiserow", readers.length > 0);
  readers.forEach(function(r) {
    cell.appendChild(make("div", null, "Reader " + r.reader + ": " + r.glitches + " glitches, " + r.badframes + " bad frames, " +
      r.parity + " parity errors, " + r.overruns + " frames lost"));
    // set to a door that does not exist (plan 1.9.1 C3): it refuses every card
    if (r.nodoor === true) {
      cell.appendChild(make("div", { class: "text-danger" }, "Reader " + r.reader + ": door out of range: it refuses every card. Set its door under Doors & Readers."));
    }
  });
}

// What an owner looks for first (plan 1.9 C3): set up or not, each door's
// state, the last card. Readers before 1.9 send none of it: nothing shown.
function showDoors(s) {
  show("setupcard", s.configured === false);
  var doors = Array.isArray(s.doors) ? s.doors : null;
  show("doorscard", !!doors && doors.length > 0);
  if (!doors) return;
  var list = byId("doorlist");
  list.textContent = "";
  doors.forEach(function(d, i) {
    var li = make("li", "door");
    li.appendChild(make("span", "doorname", d.name || "Door " + (i + 1)));
    var state = !d.relay ? ["", "No relay pin"] : d.locked ? ["ok", "Locked"] : ["warn", "Unlocked"];
    li.appendChild(make("span", "badge " + state[0], state[1]));
    if (d.hasOwnProperty("open")) li.appendChild(make("span", "badge " + (d.open ? "warn" : "ok"), d.open ? "Open" : "Closed"));
    if (d.tamper) li.appendChild(make("span", "badge bad", "Forced or held open"));
    list.appendChild(li);
  });
  var last = s.lastaccess;
  setText("lastaccess", last ? "Last card: " + (last.name || last.uid || "?") + (last.door ? " at " + last.door : "") +
    ", " + (last.granted ? "let in" : "refused") + (last.time > CLOCK_TRUSTED_FROM ? ", " + new Date(last.time * 1000).toLocaleString() : "") :
    "No card since the reader started.");
}

function listStats() {
  removeModal();
  version = ajaxobj.version;
  setText("chip", ajaxobj.chipid);
  setText("cpu", ajaxobj.cpu + " MHz");
  setText("uptime", ajaxobj.uptime);
  setText("resetreason", (ajaxobj.resetreason || "") + (ajaxobj.crashdump ? " (crash dump stored)" : ""));
  showClockState(ajaxobj.timetrusted !== false);
  showWiegandNoise(ajaxobj.wiegand);
  show("apopenbanner", ajaxobj.apopen === true);
  showDoors(ajaxobj);
  // the device reports its own heap size (an original ESP32 has less than the
  // S3's ~320 KB the bar used to assume; upstream assumed the ESP8266's 40 KB)
  var heapTotal = ajaxobj.heaptotal > 0 ? ajaxobj.heaptotal : 327680;
  setText("heap", formatBytes(ajaxobj.heap) + " of " + formatBytes(heapTotal));
  setMeter("heapbar", ajaxobj.heap, heapTotal);
  // a falling largest block with steady free heap means fragmentation; the
  // lowest free heap is since the last restart
  setText("heapmaxalloc", ajaxobj.heapmaxalloc !== undefined ? formatBytes(ajaxobj.heapmaxalloc) : "");
  setText("heapmin", ajaxobj.heapmin !== undefined ? formatBytes(ajaxobj.heapmin) + " (since restart)" : "");
  setText("flash", formatBytes(ajaxobj.availsize));
  setMeter("flashbar", ajaxobj.availsize, ajaxobj.availsize + ajaxobj.sketchsize);
  setText("spiffs", formatBytes(ajaxobj.availspiffs) + " of " + formatBytes(ajaxobj.spiffssize));
  setMeter("spiffsbar", ajaxobj.availspiffs, ajaxobj.spiffssize);
  setText("ssidstat", ajaxobj.ssid);
  setText("ip", ajaxobj.ip);
  setText("gate", ajaxobj.gateway);
  setText("mask", ajaxobj.netmask);
  setText("dns", ajaxobj.dns);
  setText("mac", ajaxobj.mac);
  setText("sver", version);
  setText("systemname", ajaxobj.hostname);
  setText("systemnamedevice", ajaxobj.hostname);
  setText("mainver", version);
}
