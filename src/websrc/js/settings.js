// settings.js: The settings store: staging a page's values, the review of unsaved
// changes and Save (applied at once) or Save & Reboot.

var SECTION_NAMES = { network: "Wireless Network", hardware: "Hardware", general: "General", mqtt: "MQTT", ntp: "Time" };

function flattenConfig(obj, prefix, out) {
  Object.keys(obj || {}).forEach(function(k) {
    var v = obj[k], key = prefix ? prefix + "." + k : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flattenConfig(v, key, out);
    } else {
      out[key] = v;
    }
  });
  return out;
}

// The review names each change by its field label on the settings page.
// Config key (relayN./readerN. prefixes stripped) -> form field id; the
// label text and option names are read from the page templates, so they
// match what the owner saw. Where a form label alone is ambiguous ("Pin
// D0") the text here is used instead.
var FIELD_OF_KEY = {
  "network.ssid": "inputtohide", "network.bssid": "wifibssid", "network.pswd": "wifipass", "network.wmode": "wmodeap",
  "network.hide": "hideapenable", "network.dhcp": "dhcpenabled", "network.ip": "ipaddress", "network.subnet": "subnet",
  "network.gateway": "gateway", "network.dns": "dnsadd", "network.fallbackmode": "fallbackmode", "network.fallbackpswd": "fallbackpass",
  "network.idleoff": "idleoff", "network.idlemins": "idlemins",
  "hardware.wifipin": "wifipin", "hardware.rtype": "typerly", "hardware.rhold": "holdrly", "hardware.ltype": "lockType",
  "hardware.rpin": "gpiorly", "hardware.rtime": "delay", "hardware.doorname": "doorname", "hardware.beeperpin": "beeperpin",
  "hardware.ledwaitingpin": "ledwaitingpin", "hardware.openlockpin": "openlockpin", "hardware.doorbellpin": "doorbellpin",
  "hardware.accessdeniedpin": "accessdeniedpin", "hardware.useridstoragemode": "useridstoragemode",
  "hardware.requirepincodeafterrfid": "requirepincodeafterrfid", "hardware.allowpincodeonly": "allowpincodeonly",
  "hardware.removeparitybits": "removeparitybits", "hardware.doorstatpin": "doorstatpin",
  "hardware.maxOpenDoorTime": "maxOpenDoorTime", "hardware.numrelays": "numrlys",
  "hardware.reader1.door": "r1door", "hardware.reader1.ledpin": "r1ledpin", "hardware.reader1.beeperpin": "r1beeperpin",
  "hardware.reader1.feedbackactivehigh": "readerfeedback", "hardware.reader2.enabled": "r2enabled",
  "hardware.reader2.wgd0pin": "r2wg0pin", "hardware.reader2.wgd1pin": "r2wg1pin", "hardware.reader2.door": "r2door",
  "hardware.reader2.ledpin": "r2ledpin", "hardware.reader2.beeperpin": "r2beeperpin",
  "hardware.reader2.feedbackactivehigh": "readerfeedback",
  "hardware.reader1.direction": "r1dir", "hardware.reader2.direction": "r2dir",
  "general.hostnm": "hostname", "general.restart": "autorestart", "general.logging": "logging",
  "mqtt.enabled": "mqttEnabled", "mqtt.host": "mqtthost", "mqtt.port": "mqttport", "mqtt.user": "mqttuser",
  "mqtt.pswd": "mqttpwd", "mqtt.topic": "mqtttopic", "mqtt.autotopic": "mqttautotopic", "mqtt.syncrate": "syncrate",
  "mqtt.mqttlog": "mqttlog", "mqtt.mqttha": "mqttha", "mqtt.remoteadmin": "mqttremoteadmin", "mqtt.doorcontrol": "mqttdoorcontrol",
  "mqtt.carduid": "mqttcarduid",
  "ntp.server": "ntpserver", "ntp.interval": "intervals", "ntp.tzinfo": "DropDownTimezone",
  "ntp.rtc.type": "rtctype", "ntp.rtc.sdapin": "rtcsdapin", "ntp.rtc.sclpin": "rtcsclpin"
};

var KEY_LABELS = {
  "hardware.doorstatpin": "Door 1 sensor pin", "hardware.openlockpin": "Door 1 exit button pin",
  "hardware.relay2.doorstatpin": "Door 2 sensor pin", "hardware.relay2.openlockpin": "Door 2 exit button pin",
  "hardware.relay3.doorstatpin": "Door 3 sensor pin", "hardware.relay3.openlockpin": "Door 3 exit button pin",
  "hardware.relay4.doorstatpin": "Door 4 sensor pin", "hardware.relay4.openlockpin": "Door 4 exit button pin",
  "network.apip": "Access point IP address", "network.apsubnet": "Access point subnet mask",
  "network.offtime": "WiFi Timeout (replaced by Turn Wi-Fi off when nobody is connected)",
  "hardware.wgd0pin": "Reader 1 D0", "hardware.wgd1pin": "Reader 1 D1", "general.openinghours": "Opening hours",
  "hardware.reader2.feedbackactivehigh": "Reader 2 LED/buzzer drive", "hardware.readertype": "Reader 1 type"
};

var PIN_KEY = /(pin|^wgd[01]pin)$/;

// the fields with this id (or the radio group with this name) in the page
// templates: an array, empty if there is none
function templateField(id) {
  var templates = document.querySelectorAll("#mastercontent template");
  for (var i = 0; i < templates.length; i++) {
    var root = templates[i].content;
    var one = root.getElementById ? root.getElementById(id) : root.querySelector("#" + CSS.escape(id));
    if (one) return [one];
    var group = root.querySelectorAll("[name=\"" + id + "\"]");
    if (group.length) return Array.prototype.slice.call(group);
  }
  return [];
}

// the visible label text of a field, without its help button or controls
function fieldLabel(id) {
  var f = templateField(id)[0];
  var field = f && f.closest(".field, .form-group");
  var label = field && field.querySelector("label, .label");
  if (!label) return "";
  var copy = label.cloneNode(true);
  copy.querySelectorAll("input, select, .help, .helpbubble").forEach(function(x) { x.remove(); });
  return copy.textContent.trim();
}

function fieldValueText(key, id, v) {
  if (v === undefined) {
    return "(not set)";
  }
  if (PIN_KEY.test(key.split(".").pop())) {
    return jsonInt(v, 255) === 255 ? "None" : "GPIO " + jsonInt(v, 255);
  }
  if (key === "hardware.readertype") {
    // only Wiegand is left; the old types are named so a change from one reads clearly
    return ({ 0: "MFRC522", 1: "Wiegand", 2: "PN532", 3: "RDM6300", 4: "MFRC522 + RDM6300", 5: "Wiegand + RDM6300", 6: "PN532 + RDM6300" })[jsonInt(v, -1)] || String(v);
  }
  if (/\.door$/.test(key)) {
    return jsonInt(v, -1) < 0 ? "Every door the user may use" : doorName(jsonInt(v, 0));
  }
  var f = id ? templateField(id)[0] : null;
  if (f && f.matches("input[type=checkbox]")) {
    return jsonInt(v, 0) ? "on" : "off";
  }
  var text = "";
  if (f && f.tagName === "SELECT") {
    Array.prototype.forEach.call(f.options, function(o) { if (o.value === String(v)) text = o.textContent; });
  } else if (f && f.matches("input[type=radio]")) {
    templateField(f.getAttribute("name")).forEach(function(r) {
      if (r.value === String(jsonInt(v, -1))) text = r.parentNode.textContent;
    });
  }
  return text.trim() || String(v);
}

function changeLabel(key) {
  var section = key.split(".")[0];
  var m = /^hardware\.relay(\d)\.(.*)$/.exec(key);
  var base = m ? "hardware." + m[2] : key, relay = m ? m[1] : (/^hardware\.(rpin|rtype|rhold|ltype|rtime|doorname)$/.test(key) ? "1" : null);
  var id = FIELD_OF_KEY[base];
  // a door-specific label ("Door 2 sensor pin") already names its door
  var own = KEY_LABELS[key];
  var name = own || KEY_LABELS[base] || (id && fieldLabel(id)) || key.slice(section.length + 1) || key;
  return { id: id, text: (SECTION_NAMES[section] || section) + ": " + name + (relay && !own ? " (relay " + relay + ")" : "") };
}

var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function configChanges(before, after) {
  // a checkbox saves true where the device stored 1, an old page "16" for 16
  var norm = function(v) { return v === true ? "1" : (v === false ? "0" : (Array.isArray(v) ? JSON.stringify(v) : String(v))); };
  var a = flattenConfig(before, "", {}), b = flattenConfig(after, "", {}), out = [];
  // reader 2 off before and after: the door it would open is not in use
  var idle2 = jsonInt(a["hardware.reader2.enabled"], 0) !== 1 && jsonInt(b["hardware.reader2.enabled"], 0) !== 1;
  Object.keys(Object.assign({}, a, b)).sort().forEach(function(key) {
    if (key === "command" || norm(a[key]) === norm(b[key]) || (idle2 && key === "hardware.reader2.door")) {
      return;
    }
    var label = changeLabel(key);
    if (/(^|\.)pswd$/.test(key)) {
      out.push(label.text + ": changed"); // never show a password
    } else if (Array.isArray(a[key]) || Array.isArray(b[key])) {
      // opening hours: name the days that changed, not 7 x 24 flags
      var days = WEEKDAYS.filter(function(d, i) { return String((a[key] || [])[i]) !== String((b[key] || [])[i]); });
      out.push(label.text + ": changed" + (days.length ? " (" + days.join(", ") + ")" : ""));
    } else {
      out.push(label.text + ": " + fieldValueText(key, label.id, a[key]) + " → " + (b[key] === undefined ? "(removed)" : fieldValueText(key, label.id, b[key])));
    }
  });
  return out;
}

function firstSaveHotspotNote() {
  var n = config.network || {};
  if (jsonInt(n.wmode, 0) !== 1) return [];
  if (!n.pswd) return ["Hotspot password: none (an open hotspot)"];
  return n.pswd === SETUP_HOTSPOT_PASSWORD ? ["Hotspot password: the setup default (" + SETUP_HOTSPOT_PASSWORD + "), change it on Wireless Network"] : [];
}

function reviewChanges() {
  // a first save has nothing to compare against: still name the settings
  // that decide who gets in, so none is stored without being seen
  // ...and the network it will be on, with the hotspot's password when it
  // is still the published setup default (review 8 R4-6)
  var changes = savedConfig ? configChanges(savedConfig, config) : ["First save: this reader has no saved settings yet"].concat(
    ["hardware.requirepincodeafterrfid", "hardware.allowpincodeonly", "mqtt.doorcontrol", "network.wmode", "network.ssid"].map(function(key) {
      var label = changeLabel(key), v = key.split(".").reduce(function(o, k) { return o ? o[k] : undefined; }, config);
      return label.text + ": " + fieldValueText(key, label.id, v);
    }), firstSaveHotspotNote());
  if (changes.length === 0) {
    changes = ["No differences from the saved settings"];
  }
  var list = document.getElementById("changelist");
  list.innerHTML = "";
  changes.forEach(function(t) {
    var li = document.createElement("li");
    li.textContent = t;
    list.appendChild(li);
  });
  // the device would refuse these settings: say why here, send nothing
  var problem = configProblem(config, deviceBoard());
  setText("reviewproblem", problem ? "Cannot save: " + problem + ". Correct it on its settings page." : "");
  show("reviewproblem", !!problem);
  byId("savereboot").disabled = !!problem;
  var cardWarn = cardNumberWarning(savedConfig, config);
  setText("reviewcardwarn", cardWarn);
  show("reviewcardwarn", !!cardWarn);
  // names, times, PIN and opening-hours rules and the like are applied at
  // once; pins, network, MQTT connection and the rest need a restart
  // (policy.js settingsNeedRestart; the device has the final word)
  var restart = settingsNeedRestart(savedConfig, config);
  setText("savereboot", restart ? "Save & Reboot" : "Save");
  var note = byId("reviewnote");
  if (note) {
    var maglock = maglockRestartWarning();
    note.textContent = restart ?
      "Save & Reboot stores these settings and restarts the reader." + (maglock ? " " + maglock : "") :
      "Save stores these settings and the reader uses them at once, without a restart.";
  }
  openDialog("reviewmodal");
}

// User ID storage mode and Remove parity bits change the number every
// Wiegand card reads as, at once on Save: cards enrolled before then match
// nobody (2026-10-16: a card "had a different id" after a settings
// change). "" when neither changes or there is nothing saved to compare.
function cardNumberWarning(saved, staged) {
  var a = saved && saved.hardware, b = staged && staged.hardware;
  if (!a || !b) {
    return "";
  }
  var mode = function(h) { return h.useridstoragemode === "decimal" ? "Decimal" : "Hexadecimal"; };
  var parity = function(h) { return !!jsonInt(h.removeparitybits, 1); };
  var what = [];
  if (mode(a) !== mode(b)) {
    what.push("User ID storage mode (" + mode(a) + " \u2192 " + mode(b) + ")");
  }
  if (parity(a) !== parity(b)) {
    what.push("Remove parity bits (" + (parity(a) ? "on" : "off") + " \u2192 " + (parity(b) ? "on" : "off") + ")");
  }
  if (what.length === 0) {
    return "";
  }
  return "Cards will read as different numbers: " + what.join(" and ") +
    " changes the number every card reads as. Cards enrolled before will not be recognised until they are enrolled again, or this is changed back.";
}

function markUnsaved() {
  var bar = document.querySelector(".footer");
  if (!bar.querySelector("button")) {
    // built once: markUnsaved() used to add another click handler on every
    // change. A tap anywhere on the bar opens the review.
    setText("commit", "Unsaved changes");
    bar.appendChild(make("button", { type: "button", className: "btn small" }, "Review & Save"));
    bar.addEventListener("click", reviewChanges);
  }
  show(bar);
}

var ALL_HOURS_OPEN = ["111111111111111111111111", "111111111111111111111111", "111111111111111111111111",
  "111111111111111111111111", "111111111111111111111111", "111111111111111111111111", "111111111111111111111111"];

// The settings as the device sent them (getconf): the staged copy and the
// saved one the review compares against. Older configs get the defaults of
// fields they predate.
function configReceived(cfg) {
  config = cfg;
  configFromDevice = true;
  if (!('wifipin' in config.hardware)) config.hardware.wifipin = 255;
  if (!('doorstatpin' in config.hardware)) config.hardware.doorstatpin = 255;
  if (!('maxOpenDoorTime' in config.hardware)) config.hardware.maxOpenDoorTime = 0;
  if (!('doorbellpin' in config.hardware)) config.hardware.doorbellpin = 255;
  if (!('accessdeniedpin' in config.hardware)) config.hardware.accessdeniedpin = 255;
  if (!('openlockpin' in config.hardware)) config.hardware.openlockpin = 255;
  if (!('beeperpin' in config.hardware)) config.hardware.beeperpin = 255;
  if (!('ledwaitingpin' in config.hardware)) config.hardware.ledwaitingpin = 255;
  if (!('ltype' in config.hardware)) config.hardware.ltype = 0;
  if (!('useridstoragemode' in config.hardware)) config.hardware.useridstoragemode = "hexadecimal";
  if (!('removeparitybits' in config.hardware)) config.hardware.removeparitybits = true;
  if (isObj(config.mqtt) && !('carduid' in config.mqtt)) config.mqtt.carduid = 1; // the device's default
  if ('numrelays' in config.hardware) numRelays = parseInt(config.hardware["numrelays"]) || 1; else config.hardware["numrelays"] = numRelays;
  savedConfig = JSON.parse(JSON.stringify(config));
}

// A settings page's Save: its values (a copy of one config section) replace
// that section only if the device would accept them. Pages used to write
// into config and validate afterwards, so a refused value stayed staged.
function stageSection(section, value) {
  var cfg = { general: { openinghours: ALL_HOURS_OPEN } };
  cfg[section] = value;
  var problem = configProblem(cfg, deviceBoard());
  // the Doors & Readers pins and the Time page's RTC pins are on two pages:
  // a clash between them is checked against the other page's staged settings
  if (!problem && (section === "hardware" || section === "ntp") && deviceBoard()) {
    var clash = pinProblems(section === "hardware" ? value : config.hardware, deviceBoard(), section === "ntp" ? value : config.ntp)
      .filter(function(p) { return p.labels.some(function(l) { return /^RTC /.test(l); }); })[0];
    problem = clash ? clash.text : null;
  }
  if (problem) {
    showMessage("Not staged: " + problem);
    return false;
  }
  config[section] = value;
  markUnsaved();
  pageEdited = false; // main.js: what was typed is staged now
  return true;
}

function commit() {
  // the review checks this too; check again in case it was bypassed
  var problem = configProblem(config, deviceBoard());
  if (problem) {
    reviewChanges();
    return;
  }
  afterModal("#reviewmodal", function() { inProgress("commit"); });
}

function checkOctects(input) {
  var ipformat = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  var call = document.getElementById(input);
  if (call.value.match(ipformat)) {
    return true;
  } else {
    showMessage("Not staged: " + labelOf(input) + " is not a valid address (for example 192.168.4.1)");
    call.focus();
    return false;
  }

}
