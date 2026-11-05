// policy.js: The device's settings policy (a port of core/configpolicy.h).

// ---- settings policy: the checks the device makes before it saves ---------
// A port of core/configpolicy.h with the same messages, so a settings save is
// checked here before anything is sent. test/e2e runs the shared vectors
// (test/vectors/config-policy.json) through this copy as well, so it cannot
// drift from the firmware. The admin-password rule is the device's alone.

// core::jsonInt: numbers (truncated), booleans, and decimal strings
function jsonInt(v, fallback) {
  if (typeof v === "number") {
    return isFinite(v) ? (v < 0 ? Math.ceil(v) : Math.floor(v)) : fallback;
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (typeof v !== "string") {
    return fallback;
  }
  var m = /^(-?)(\d+)$/.exec(v);
  if (!m || Number(m[2]) > 1000000) {
    return fallback;
  }
  return m[1] ? -Number(m[2]) : Number(m[2]);
}

function isObj(o) {
  return o !== null && typeof o === "object" && !Array.isArray(o);
}

function clampRelays(n) {
  return n < 1 ? 1 : (n > 4 ? 4 : n);
}

function pinAllowed(pins, pin, output) {
  return pins.io.indexOf(pin) >= 0 || (!output && pins.input.indexOf(pin) >= 0);
}

// The board the device reports: its usable pins (status).
function deviceBoard() {
  if (!ajaxobj || !ajaxobj.pinsio) {
    return null;
  }
  return { pins: { io: ajaxobj.pinsio, input: ajaxobj.pinsinput || [] } };
}

// The GPIO fields of a configuration, in core::checkConfigPins's order:
// [label, value, output, used]. ntp: the Time page's settings (the RTC).
function configPinFields(hw, ntp) {
  var rt = jsonInt(hw.readertype, 0);
  var wiegand1 = rt === 1 || rt === 5;
  var relays = clampRelays(jsonInt(hw.numrelays, 1));
  var r1 = isObj(hw.reader1) ? hw.reader1 : null, r2 = isObj(hw.reader2) ? hw.reader2 : null;
  var reader2 = !!r2 && jsonInt(r2.enabled, 0) === 1;
  var rel = function(n, key) { return isObj(hw["relay" + n]) ? hw["relay" + n][key || "rpin"] : undefined; };
  var rtc = isObj(ntp) && isObj(ntp.rtc) ? ntp.rtc : {};
  var rtcType = jsonInt(rtc.type, 0), rtcOn = rtcType === 1 || rtcType === 2;
  return [
    ["Reader 1 D0", hw.wgd0pin, false, wiegand1], ["Reader 1 D1", hw.wgd1pin, false, wiegand1],
    ["Relay 1", hw.rpin, true, true],
    ["Relay 2", rel(2), true, relays >= 2], ["Relay 3", rel(3), true, relays >= 3], ["Relay 4", rel(4), true, relays >= 4],
    ["WiFi LED", hw.wifipin, true, true], ["Door sensor", hw.doorstatpin, true, true], ["Doorbell", hw.doorbellpin, true, true],
    ["Open button", hw.openlockpin, true, true], ["Denied LED", hw.accessdeniedpin, true, true], ["Beeper", hw.beeperpin, true, true],
    ["Waiting LED", hw.ledwaitingpin, true, true],
    ["Reader 1 LED", r1 ? r1.ledpin : undefined, true, !!r1], ["Reader 1 buzzer", r1 ? r1.beeperpin : undefined, true, !!r1],
    ["Reader 2 D0", r2 ? r2.wgd0pin : undefined, false, reader2], ["Reader 2 D1", r2 ? r2.wgd1pin : undefined, false, reader2],
    ["Reader 2 LED", r2 ? r2.ledpin : undefined, true, reader2], ["Reader 2 buzzer", r2 ? r2.beeperpin : undefined, true, reader2],
    ["Door 2 sensor", rel(2, "doorstatpin"), true, relays >= 2], ["Door 2 exit button", rel(2, "openlockpin"), true, relays >= 2],
    ["Door 3 sensor", rel(3, "doorstatpin"), true, relays >= 3], ["Door 3 exit button", rel(3, "openlockpin"), true, relays >= 3],
    ["Door 4 sensor", rel(4, "doorstatpin"), true, relays >= 4], ["Door 4 exit button", rel(4, "openlockpin"), true, relays >= 4],
    // none stored: GPIO21/22 (core/rtc.h)
    ["RTC SDA", rtcOn ? jsonInt(rtc.sdapin, 21) : undefined, true, rtcOn], ["RTC SCL", rtcOn ? jsonInt(rtc.sclpin, 22) : undefined, true, rtcOn]
  ];
}

// Every pin problem, not only the first: { text, labels } with the labels of
// the fields involved (the pages mark them). The first one's text is the
// device's message (core::checkConfigPins).
function pinProblems(hw, b, ntp) {
  var fields = configPinFields(hw, ntp);
  var pins = fields.map(function(f) { return f[3] ? jsonInt(f[1], 255) : 255; });
  var out = [];
  for (var i = 0; i < fields.length; i++) {
    if (pins[i] === 255) {
      continue;
    }
    if (!pinAllowed(b.pins, pins[i], fields[i][2])) {
      out.push({ text: fields[i][0] + ": GPIO " + pins[i] + " cannot be used" + (fields[i][2] ? " as an output" : "") + " on this board", labels: [fields[i][0]] });
      continue;
    }
    for (var j = 0; j < i; j++) {
      if (pins[j] === pins[i]) {
        out.push({ text: "GPIO " + pins[i] + " is used twice: " + fields[j][0] + " and " + fields[i][0], labels: [fields[j][0], fields[i][0]] });
        break;
      }
    }
  }
  return out;
}

// core::checkConfigPins: every GPIO allowed on this chip, none used twice.
function checkConfigPins(hw, b, ntp) {
  var problems = pinProblems(hw, b, ntp);
  return problems.length ? problems[0].text : null;
}

// The pins in use and the fields using them: { 21: ["Relay 1"], ... }
function pinsInUse(hw, ntp) {
  var used = {};
  configPinFields(hw, ntp).forEach(function(f) {
    var pin = f[3] ? jsonInt(f[1], 255) : 255;
    if (pin !== 255) {
      (used[pin] = used[pin] || []).push(f[0]);
    }
  });
  return used;
}

// core::applyConfigPolicy, the refusals only: the problem the device would
// answer with, or null. Without a board (no status yet) pins are not checked.
// Stricter than the device in one way: a number field left empty (NaN) is a
// problem here, where the device would quietly use a default.
function configProblem(cfg, b) {
  var str = function(v) { return typeof v === "string" ? v : ""; };
  // the device counts bytes (UTF-8), not characters
  var bytes = function(v) { return unescape(encodeURIComponent(str(v))).length; };
  var general = isObj(cfg.general) ? cfg.general : {};
  // (the device also refuses a file with no network or hardware section;
  // a page's Save checks its own section only, and the review always has both)
  var network = isObj(cfg.network) ? cfg.network : null;
  if (network && network.wmode === 1) {
    if (str(network.ssid) === "") {
      return "Access point SSID must not be empty";
    }
    var n = str(network.pswd).length;
    if (!(n === 0 || (n >= 8 && n <= 63))) {
      return "Access point password must be empty (open) or 8-63 characters";
    }
  }
  if (network) {
    if (bytes(network.ssid) > 32) {
      return "Wi-Fi SSID must be at most 32 characters";
    }
    if (bytes(network.pswd) > 64) {
      return "Wi-Fi password must be at most 64 characters";
    }
    var badNumber = function(v) { return typeof v === "number" && !isFinite(v); };
    var io = network.idleoff;
    if (!(io === undefined || io === null || (!badNumber(io) && [0, 1].indexOf(jsonInt(io, -1)) >= 0))) {
      return "Turn Wi-Fi off when nobody is connected must be on or off";
    }
    var im = network.idlemins;
    if (!(im === undefined || im === null)) {
      var mins = jsonInt(im, -1);
      if (badNumber(im) || mins < 1 || mins > 1440) {
        return "Turn Wi-Fi off after must be 1-1440 minutes";
      }
    }
  }
  var hw = isObj(cfg.hardware) ? cfg.hardware : null;
  if (hw) {
    var relays = clampRelays(jsonInt(hw.numrelays, 1));
    var notNumber = function(v) { return typeof v === "number" && !isFinite(v); };
    var maxOpen = jsonInt(hw.maxOpenDoorTime, 0);
    if (notNumber(hw.maxOpenDoorTime) || maxOpen < 0 || maxOpen > 600) {
      return "Maximum open time must be 0-600 seconds";
    }
    var zeroOrOne = function(v) { return v === undefined || v === null || (!notNumber(v) && [0, 1].indexOf(jsonInt(v, -1)) >= 0); };
    for (var i = 0; i < relays; i++) {
      var rel = i === 0 ? hw : (isObj(hw["relay" + (i + 1)]) ? hw["relay" + (i + 1)] : {});
      if (bytes(rel.doorname) > 63) {
        return "Door names must be at most 63 characters";
      }
      var t = rel.rtime;
      if (t !== undefined && t !== null) {
        var ms = jsonInt(t, 400);
        if (notNumber(t) || ms < 100 || ms > 30000) {
          return "Relay activate time must be 100-30000 ms";
        }
      }
      if (!zeroOrOne(rel.rtype)) {
        return "Relay type must be Active High or Active Low";
      }
      if (!zeroOrOne(rel.rhold)) {
        return "When the relay is on, the door must be Unlocked or Locked";
      }
      if (!zeroOrOne(rel.ltype)) {
        return "Lock type must be Momentary or Continuous";
      }
    }
    if (jsonInt(hw.readertype, 0) !== 1) {
      return "Reader 1 must be a Wiegand reader (MFRC522, PN532 and RDM6300 are no longer supported)";
    }
    if (isObj(hw.reader1)) {
      var door1 = jsonInt(hw.reader1.door, -1);
      if (door1 < -1 || door1 >= relays) {
        return "Reader 1 has an invalid door binding";
      }
    }
    if (isObj(hw.reader2) && jsonInt(hw.reader2.enabled, 0) === 1) {
      var door2 = jsonInt(hw.reader2.door, -2);
      if (door2 < 0 || door2 >= relays) {
        return "Reader 2 must be bound to a configured door";
      }
    }
  }
  var ntp = isObj(cfg.ntp) ? cfg.ntp : null;
  if (ntp && ntp.interval !== undefined && ntp.interval !== null) {
    var minutes = jsonInt(ntp.interval, -1);
    if ((typeof ntp.interval === "number" && !isFinite(ntp.interval)) || minutes < 0 || minutes > 10080) {
      return "NTP sync interval must be 0-10080 minutes";
    }
  }
  var rtcType = ntp && isObj(ntp.rtc) ? ntp.rtc.type : undefined;
  if (rtcType !== undefined && rtcType !== null && [0, 1, 2].indexOf(jsonInt(rtcType, -1)) < 0) {
    return "RTC type must be None, DS3231 or DS1307";
  }
  if (b && (hw || ntp)) {
    var pinProblem = checkConfigPins(hw || {}, b, ntp);
    if (pinProblem) {
      return pinProblem;
    }
  }
  if (isObj(cfg.mqtt)) {
    var dc = cfg.mqtt.doorcontrol;
    var dcOk = dc === undefined || dc === null || (!(typeof dc === "number" && !isFinite(dc)) && [0, 1].indexOf(jsonInt(dc, -1)) >= 0);
    if (!dcOk) {
      return "MQTT door control must be Enabled or Disabled";
    }
    var port = cfg.mqtt.port;
    if (port !== undefined && port !== null) {
      var pn = jsonInt(port, -1);
      if ((typeof port === "number" && !isFinite(port)) || pn < 1 || pn > 65535) {
        return "MQTT port must be 1-65535";
      }
    }
    var cu = cfg.mqtt.carduid;
    if (!(cu === undefined || cu === null) && ((typeof cu === "number" && !isFinite(cu)) || [0, 1, 2].indexOf(jsonInt(cu, -1)) < 0)) {
      return "Card number in MQTT must be Off, Last 4 or Full";
    }
  }
  var host = str(general.hostnm);
  if (host.length > 32 || !/^[A-Za-z0-9-]*$/.test(host)) {
    return "Host name must be at most 32 letters, digits and hyphens";
  }
  var hours = general.openinghours;
  if (!Array.isArray(hours)) {
    return "Opening hours are required";
  }
  if (hours.length !== 7) {
    return "Opening hours must contain seven days";
  }
  if (!hours.every(function(d) { return typeof d === "string" && /^[01]{24}$/.test(d); })) {
    return "Each opening-hours day must contain exactly 24 zero/one values";
  }
  return null;
}

// ---- live settings: which saves the device applies without a restart -------
// A port of core/livesettings.h (the list and its reasons are there). The
// device decides; this copy only labels the review's button and note, and
// test/check-live-settings.mjs runs the shared vectors
// (test/vectors/live-settings.json) through it. Values compare as the review
// lists them (configChanges): true == 1 == "1", 16 == "16"; a key present on
// one side only, or not on this list, needs a restart.
var LIVE_SETTINGS = [
  "hardware.rtime", "hardware.relay2.rtime", "hardware.relay3.rtime", "hardware.relay4.rtime",
  "hardware.doorname", "hardware.relay2.doorname", "hardware.relay3.doorname", "hardware.relay4.doorname",
  "hardware.maxOpenDoorTime", "hardware.requirepincodeafterrfid", "hardware.allowpincodeonly",
  "hardware.useridstoragemode", "hardware.removeparitybits",
  "hardware.reader1.door", "hardware.reader1.direction", "hardware.reader2.door", "hardware.reader2.direction",
  "general.openinghours", "general.logging", "ntp.tzinfo",
  "mqtt.syncrate", "mqtt.mqttlog", "mqtt.remoteadmin", "mqtt.doorcontrol", "mqtt.carduid",
  "network.idleoff", "network.idlemins"
];

function liveLeaves(obj, prefix, out) {
  Object.keys(obj).forEach(function(k) {
    var v = obj[k], key = prefix ? prefix + "." + k : k;
    if (isObj(v)) {
      liveLeaves(v, key, out);
    } else if (key !== "command") {
      out[key] = v;
    }
  });
  return out;
}

// before: the settings the device runs (as it sent them); after: the ones to
// save. True if saving them restarts the device.
function settingsNeedRestart(before, after) {
  if (!isObj(before) || !isObj(after)) {
    return true; // nothing stored yet: the first save restarts
  }
  var text = function(v) { return v === true ? "1" : (v === false ? "0" : (typeof v === "string" ? v : JSON.stringify(v))); };
  var a = liveLeaves(before, "", {}), b = liveLeaves(after, "", {});
  return Object.keys(Object.assign({}, a, b)).some(function(key) {
    var same = (key in a) && (key in b) && text(a[key]) === text(b[key]);
    return !same && LIVE_SETTINGS.indexOf(key) < 0;
  });
}
