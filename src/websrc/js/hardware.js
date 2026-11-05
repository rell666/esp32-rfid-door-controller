// hardware.js: The Doors & Readers page: pin menus, one card per door (relay,
// lock, sensor, exit button) holding the reader(s) that open it, and the
// settings common to every door.

// ---- pins ----------------------------------------------------------------------
// The device sends the GPIOs that are safe on its chip (status.pinsio /
// status.pinsinput, from core/pins.h); every pin menu is built from them.
var PIN_LABELS = {
  esp32: { 16: "relay 1 on VOANZO board", 17: "relay 2 on VOANZO board", 23: "LED on VOANZO board",
           34: "input only", 35: "input only" },
  esp32s3: { 10: "SPI CS", 11: "SPI MOSI", 12: "SPI SCK", 13: "SPI MISO", 48: "RGB LED on DevKitC-1" }
};

var OUTPUT_PIN_SELECTS = ["gpiorly", "wifipin", "accessdeniedpin", "beeperpin", "ledwaitingpin",
  "r1ledpin", "r1beeperpin", "r2ledpin", "r2beeperpin"];

var READER_INPUT_PIN_SELECTS = ["wg0pin", "wg1pin", "r2wg0pin", "r2wg1pin"];

var PULLUP_INPUT_PIN_SELECTS = ["doorstatpin", "doorbellpin", "openlockpin"];

// a pin menu (an id or the select itself): its "None" entry, if it has one,
// then the pins
function fillPinSelect(id, pins, labels) {
  var sel = el(id);
  if (!sel) {
    return;
  }
  var none = sel.querySelector('option[value="255"]');
  var noneText = none ? none.textContent : null;
  sel.textContent = "";
  if (noneText !== null) {
    sel.appendChild(make("option", { value: "255" }, noneText));
  }
  pins.forEach(function(p) {
    var text = "GPIO-" + p + (labels[p] ? " (" + labels[p] + ")" : "");
    sel.appendChild(make("option", { value: String(p), "data-text": text }, text));
  });
}

function pinLabels() {
  return (ajaxobj && PIN_LABELS[ajaxobj.chip]) || {};
}

function buildPinMenus() {
  if (!ajaxobj || !ajaxobj.pinsio) {
    return; // no status yet; the page has no pin lists of its own
  }
  var labels = pinLabels();
  var io = ajaxobj.pinsio;
  var inputs = io.concat(ajaxobj.pinsinput || []).sort(function(a, b) { return a - b; });
  OUTPUT_PIN_SELECTS.forEach(function(id) { fillPinSelect(id, io, labels); });
  READER_INPUT_PIN_SELECTS.forEach(function(id) { fillPinSelect(id, inputs, labels); });
  PULLUP_INPUT_PIN_SELECTS.forEach(function(id) { fillPinSelect(id, io, labels); });
}

// ---- door names --------------------------------------------------------------------
// "Door 2 (Back)": the staged settings (settings.js names a change with it)
function doorName(i) {
  var n = i === 0 ? (config.hardware.doorname || "") :
    ((config.hardware["relay" + (i + 1)] && config.hardware["relay" + (i + 1)].doorname) || "");
  var label = "Door " + (i + 1);
  return (n && n !== label) ? label + " (" + n + ")" : label;
}

function doorNameInput(i) {
  return byId(i === 0 ? "doorname" : "doorname" + (i + 1));
}

// the same, as typed on the page: the reader menus follow the form
function formDoorName(i) {
  var input = doorNameInput(i);
  if (!input) {
    return doorName(i);
  }
  var n = input.value.trim(), label = "Door " + (i + 1);
  return (n && n !== label) ? label + " (" + n + ")" : label;
}

function doorCard(i) {
  return byId(i === 0 ? "relayform" : "relayform" + (i + 1));
}

// the name beside "Door N" in the door card's title
function updateDoorHeader(i) {
  var card = doorCard(i), input = doorNameInput(i);
  if (!card || !input) {
    return;
  }
  var n = input.value.trim();
  setText(card.querySelector(".hw-door-name"), n && n !== "Door " + (i + 1) ? n : "");
}

// typing a door name (data-arg: the door number, 1-4)
function doorNameTyped(n) {
  updateDoorHeader(n - 1);
  refreshDoorSelects();
  updateSetupNote();
}

function fillDoorSelect(id, allowAll, value) {
  var sel = byId(id);
  if (!sel) {
    return;
  }
  sel.textContent = "";
  if (allowAll) {
    sel.appendChild(make("option", { value: "-1" }, "Every door (one reader for all)"));
  }
  for (var i = 0; i < numRelays; i++) {
    sel.appendChild(make("option", { value: String(i) }, formDoorName(i)));
  }
  sel.value = String(value);
  if (sel.selectedIndex < 0) {
    sel.selectedIndex = 0;
  }
}

// Reader settings as configured, or the defaults (showing the page does not
// stage them: only Save does).
function readerOptions() {
  // reader 1 without a stored door: door 1 with two or more doors, as the
  // firmware reads it (a stored -1, every door, is kept)
  var door1 = numRelays > 1 ? 0 : -1;
  var r1 = config.hardware.reader1 || { ledpin: 255, beeperpin: 255, feedbackactivehigh: 1, direction: 0 };
  return {
    r1: Object.assign({}, r1, { door: jsonInt(r1.door, door1) }),
    r2: config.hardware.reader2 || { enabled: 0, wgd0pin: 255, wgd1pin: 255, door: 1, ledpin: 255, beeperpin: 255, feedbackactivehigh: 1, direction: 0 }
  };
}

function refreshDoorSelects() {
  var r = readerOptions();
  var r1 = byId("r1door"), r2 = byId("r2door");
  fillDoorSelect("r1door", true, r1 && r1.options.length ? r1.value : r.r1.door);
  fillDoorSelect("r2door", false, r2 && r2.options.length ? r2.value : r.r2.door);
}

// ---- where the readers sit -------------------------------------------------------
// Each reader's card lives in the card of the door it opens (reader 1 set to
// every door: in its own card above the doors). A reader not in use waits,
// hidden, in #readerpark, so its fields still exist for Save.
function twoReaders() {
  return byId("r2enabled").value === "1";
}

function readerHome(door) {
  if (door < 0) {
    return document.querySelector("#alldoorsreaders .door-readers");
  }
  var card = doorCard(door);
  return card ? card.querySelector(".door-readers") : byId("readerpark");
}

// before door cards are added or removed (a removed card takes its contents with it)
function parkReaders() {
  var park = byId("readerpark");
  park.appendChild(byId("reader1block"));
  park.appendChild(byId("reader2block"));
}

function placeReaders() {
  readerHome(parseInt(byId("r1door").value)).appendChild(byId("reader1block"));
  var r2 = byId("reader2block");
  if (twoReaders()) {
    readerHome(parseInt(byId("r2door").value)).appendChild(r2);
  } else {
    byId("readerpark").appendChild(r2);
  }
  show("alldoorsreaders", document.querySelector("#alldoorsreaders .door-readers").children.length > 0);
  updateDoorNotes();
  updateReaderBadges();
  updateSetupNote();
}

// a door card with no reader of its own says how it opens
function updateDoorNotes() {
  var everyDoor = parseInt(byId("r1door").value) < 0;
  for (var i = 0; i < numRelays; i++) {
    var card = doorCard(i);
    if (!card) {
      continue;
    }
    var note = card.querySelector(".hw-noreader");
    var empty = card.querySelector(".door-readers").children.length === 0;
    setText(note, everyDoor ? "Reader 1 opens this door (it is set to every door, in the card above)." :
      "No reader opens this door. It still opens with its exit button, and over MQTT if door control is on.");
    show(note, empty);
  }
}

var SIDE_NAMES = { "1": "In", "2": "Out" };

// the side shown in each reader card's title (the type is always Wiegand)
function updateReaderBadges() {
  [["reader1block", "r1dir"], ["reader2block", "r2dir"]].forEach(function(r) {
    var badge = document.querySelector("#" + r[0] + " .hw-rside"), side = SIDE_NAMES[byId(r[1]).value];
    setText(badge, side || "");
    show(badge, !!side);
  });
}

// a reader's door changed (data-arg: the reader, 1 or 2): its card moves to
// that door's card; bring it into view there
function readerMoved(n) {
  placeReaders();
  var block = byId("reader" + n + "block");
  block.classList.remove("hw-flash");
  void block.offsetWidth; // restart the highlight
  block.classList.add("hw-flash");
  if (block.scrollIntoView) {
    block.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// One door and two readers: a reader each side. Suggest In and Out unless
// the owner has already chosen.
function suggestDirections() {
  var d1 = byId("r1dir"), d2 = byId("r2dir");
  if (twoReaders() && numRelays === 1 && d1.value === "0" && d2.value === "0") {
    d1.value = "1";
    d2.value = "2";
  }
}

function changeReaderCount() {
  suggestDirections();
  placeReaders();
  updateReaderBadges();
}

function updateSetupNote() {
  var note = byId("setupnote");
  if (!note) {
    return;
  }
  function target(d) {
    return d < 0 ? "every door the user may use" : formDoorName(d);
  }
  function side(id) {
    var v = byId(id).value;
    return v === "1" ? "In" : v === "2" ? "Out" : "no direction";
  }
  var d1 = parseInt(byId("r1door").value), d2 = parseInt(byId("r2door").value);
  var text;
  if (!twoReaders()) {
    text = "One reader, opening " + target(d1) + ".";
  } else if (d1 === d2) {
    text = target(d1) + " has a reader on each side: reader 1 logs " + side("r1dir") + ", reader 2 logs " + side("r2dir") + ".";
    if (side("r1dir") === side("r2dir")) {
      text += " Set one In and the other Out to log who comes and goes.";
    }
  } else {
    text = "Reader 1 opens " + target(d1) + ", reader 2 opens " + target(d2) + ".";
  }
  note.textContent = text;
}

// A brand-new device on the VOANZO / LC-Tech ESP32 2-relay board, with two
// standalone Wiegand readers: one door each. Every reader line is on the
// 2x10 header along the board edge (module's left side), so one ribbon and
// one screw-terminal breakout carry all of it (README-IRONFRAME.md wiring).
function applyEsp32TwoDoorPreset() {
  var h = config.hardware;
  numRelays = 2;
  h.numrelays = 2;
  h.readertype = 1;
  h.wgd0pin = 34;
  h.wgd1pin = 35;
  h.rpin = 16;
  h.rtype = 1;
  h.rhold = 1; // relay on = locked: a maglock on NO, released if the controller fails
  h.rtime = 3000; // milliseconds: 400 ms is too short for a real door lock
  h.doorname = "Door 1";
  h.relay2 = { rtype: 1, rhold: 1, ltype: 0, rpin: 17, rtime: 3000, doorname: "Door 2" };
  h.reader1 = { door: 0, ledpin: 25, beeperpin: 26, feedbackactivehigh: 1 };
  h.reader2 = { enabled: 1, wgd0pin: 32, wgd1pin: 33, door: 1, ledpin: 27, beeperpin: 14, feedbackactivehigh: 1 };
}

// a door's lock type (data-arg: the door number; none for door 1): the
// unlock time applies to a momentary lock only
function handleLock(xnum) {
  var xstr = xnum > 1 ? String(xnum) : "";
  show("activateTimeForm" + xstr, parseInt(byId("lockType" + xstr).value) === 0);
}

// A device without a saved config gets the defaults for its chip as soon as it
// reports which chip it is, not only when this page is opened: the built-in
// defaults (Wiegand D1 on GPIO5) are invalid on the original ESP32, so a
// first save from the Network page was refused there.
function applyChipDefaults() {
  if (!configFromDevice && ajaxobj && ajaxobj.chip === "esp32" && !config.hardware.reader2) {
    applyEsp32TwoDoorPreset();
  }
}

// A field's value. A pin menu never goes blank: a stored pin this chip does
// not offer stays visible, named as such (Save then says why it is refused),
// and "none" (255) in a menu without a None entry shows as None. A blank
// menu saved null.
function setValue(id, v) {
  var e = el(id);
  if (!e) {
    return;
  }
  e.value = v;
  var pin = jsonInt(v, 255);
  if (e.tagName === "SELECT" && e.selectedIndex < 0 && /pin|^gpio/.test(e.id) && pin >= 0) {
    e.appendChild(make("option", { value: String(pin) }, pin === 255 ? "None" : "GPIO-" + pin + " (not on this board)"));
    e.value = String(pin);
  }
}

function listhardware() {
  applyChipDefaults();
  buildPinMenus();
  var h = config.hardware;
  setValue("lockType", h.ltype);
  setValue("typerly", h.rtype);
  setValue("holdrly", jsonInt(h.rhold, 0)); // stored without it: unlocked, as before 1.7
  setValue("delay", h.rtime);
  setValue("wifipin", h.wifipin);
  setValue("doorstatpin", h.doorstatpin);
  setValue("maxOpenDoorTime", h.maxOpenDoorTime);
  setValue("doorbellpin", h.doorbellpin);
  setValue("openlockpin", h.openlockpin);
  setValue("accessdeniedpin", h.accessdeniedpin);
  setValue("useridstoragemode", h.useridstoragemode);
  byId("requirepincodeafterrfid").checked = !!jsonInt(h.requirepincodeafterrfid, 0);
  byId("allowpincodeonly").checked = !!jsonInt(h.allowpincodeonly, 0);
  byId("removeparitybits").checked = !!jsonInt(h.removeparitybits, 1);
  setValue("ledwaitingpin", h.ledwaitingpin);
  setValue("beeperpin", h.beeperpin);
  setValue("wg0pin", h.wgd0pin);
  setValue("wg1pin", h.wgd1pin);
  setValue("gpiorly", h.rpin);
  setValue("doorname", h.doorname || "");
  setValue("numrlys", numRelays);
  updateRelayForm();
  updateUserModalForm(); // users.js
  for (var i = 2; i <= numRelays; i++) {
    var rc = relayConf(i);
    setValue("gpiorly" + i, rc.rpin);
    setValue("lockType" + i, rc.ltype);
    setValue("typerly" + i, rc.rtype);
    setValue("holdrly" + i, jsonInt(rc.rhold, 0));
    setValue("delay" + i, rc.rtime);
    setValue("doorname" + i, rc.doorname || "");
    setValue("doorpinrly" + i, rc.doorstatpin === undefined ? 255 : rc.doorstatpin);
    setValue("exitpinrly" + i, rc.openlockpin === undefined ? 255 : rc.openlockpin);
  }
  for (var d = 0; d < numRelays; d++) {
    updateDoorHeader(d);
  }
  var ro = readerOptions();
  refreshDoorSelects(); // the door menus are empty here: they take ro's doors (door 1 if that door is gone)
  setValue("r1ledpin", ro.r1.ledpin);
  setValue("r1beeperpin", ro.r1.beeperpin);
  setValue("readerfeedback", ro.r1.feedbackactivehigh === 0 ? "0" : "1");
  setValue("r1dir", String(ro.r1.direction === 1 || ro.r1.direction === 2 ? ro.r1.direction : 0));
  setValue("r2dir", String(ro.r2.direction === 1 || ro.r2.direction === 2 ? ro.r2.direction : 0));
  setValue("r2enabled", ro.r2.enabled === 1 ? "1" : "0");
  setValue("r2wg0pin", ro.r2.wgd0pin);
  setValue("r2wg1pin", ro.r2.wgd1pin);
  setValue("r2ledpin", ro.r2.ledpin);
  setValue("r2beeperpin", ro.r2.beeperpin);
  placeReaders();
  updateReaderBadges();
  handleLock();
  // every change re-checks the page as the device would (the page is new
  // each time it opens, so the listeners go with it)
  var root = document.querySelector("#ajaxcontent .hw-page");
  root.addEventListener("change", checkHardware);
  root.addEventListener("input", checkHardware);
  checkHardware();
}

// Reader 2's door while it is off: not chosen on the page, so the stored one
// stays (door 2 if there is none, or 1.4's pages stored null)
function idleReader2Door() {
  var r2 = config.hardware.reader2, d = r2 ? r2.door : undefined;
  return typeof d === "number" && d >= 0 ? Math.floor(d) : 1;
}

// the page's values, as a copy of config.hardware
function collectHardware() {
  var v = function(id) { return byId(id).value; };
  var n = function(id) { return parseInt(byId(id).value); };
  var h = JSON.parse(JSON.stringify(config.hardware));
  // always Wiegand: a stored MFRC522, PN532 or RDM6300 becomes Wiegand on
  // Save (their old keys, sspin, rfidgain, rdm6300pin, stay as stored and
  // unused, so the review lists no change for them)
  h.readertype = 1;
  h.wgd0pin = n("wg0pin");
  h.wgd1pin = n("wg1pin");
  h.useridstoragemode = v("useridstoragemode");
  h.requirepincodeafterrfid = byId("requirepincodeafterrfid").checked;
  h.allowpincodeonly = byId("allowpincodeonly").checked;
  h.removeparitybits = byId("removeparitybits").checked;
  h.rtype = n("typerly");
  // saved once it is stored or set to Locked: a page saved over settings
  // from before 1.7 adds no key (no listed change, no restart)
  if ("rhold" in h || n("holdrly") !== 0) {
    h.rhold = n("holdrly");
  }
  h.ltype = n("lockType");
  h.rpin = n("gpiorly");
  h.rtime = n("delay");
  h.wifipin = n("wifipin");
  h.doorstatpin = n("doorstatpin");
  h.maxOpenDoorTime = n("maxOpenDoorTime");
  h.doorbellpin = n("doorbellpin");
  h.openlockpin = n("openlockpin");
  h.accessdeniedpin = n("accessdeniedpin");
  h.beeperpin = n("beeperpin");
  h.ledwaitingpin = n("ledwaitingpin");
  h.doorname = v("doorname");
  h.numrelays = numRelays;
  for (var i = 2; i <= numRelays; i++) {
    // numbers, not strings: upstream stored "16" here and the firmware read 0
    var stored = config.hardware["relay" + i];
    h["relay" + i] = {
      rpin: n("gpiorly" + i),
      ltype: n("lockType" + i),
      rtype: n("typerly" + i),
      rtime: n("delay" + i),
      doorname: v("doorname" + i),
      doorstatpin: n("doorpinrly" + i),
      openlockpin: n("exitpinrly" + i)
    };
    if ((stored && "rhold" in stored) || n("holdrly" + i) !== 0) {
      h["relay" + i].rhold = n("holdrly" + i);
    }
  }
  var drive = n("readerfeedback");
  h.reader1 = {
    door: n("r1door"),
    ledpin: n("r1ledpin"),
    beeperpin: n("r1beeperpin"),
    feedbackactivehigh: drive,
    direction: n("r1dir")
  };
  h.reader2 = {
    enabled: twoReaders() ? 1 : 0,
    wgd0pin: n("r2wg0pin"),
    wgd1pin: n("r2wg1pin"),
    door: twoReaders() ? n("r2door") : idleReader2Door(),
    ledpin: n("r2ledpin"),
    beeperpin: n("r2beeperpin"),
    feedbackactivehigh: drive,
    direction: n("r2dir")
  };
  return h;
}

// ---- pin conflicts on the page ---------------------------------------------------
// The field of each pin label (policy.js configPinFields, core::checkConfigPins).
var PIN_FIELD_IDS = {
  "Reader 1 D0": "wg0pin", "Reader 1 D1": "wg1pin", "Reader 2 D0": "r2wg0pin", "Reader 2 D1": "r2wg1pin",
  "Relay 1": "gpiorly", "Relay 2": "gpiorly2", "Relay 3": "gpiorly3", "Relay 4": "gpiorly4",
  "WiFi LED": "wifipin", "Door sensor": "doorstatpin", "Doorbell": "doorbellpin", "Open button": "openlockpin",
  "Denied LED": "accessdeniedpin", "Beeper": "beeperpin", "Waiting LED": "ledwaitingpin",
  "Reader 1 LED": "r1ledpin", "Reader 1 buzzer": "r1beeperpin", "Reader 2 LED": "r2ledpin", "Reader 2 buzzer": "r2beeperpin",
  "Door 2 sensor": "doorpinrly2", "Door 2 exit button": "exitpinrly2", "Door 3 sensor": "doorpinrly3",
  "Door 3 exit button": "exitpinrly3", "Door 4 sensor": "doorpinrly4", "Door 4 exit button": "exitpinrly4"
};

function pinFieldLabel(id) {
  return Object.keys(PIN_FIELD_IDS).filter(function(k) { return PIN_FIELD_IDS[k] === id; })[0] || null;
}

// Marks the fields of each pin problem (red outline, a line under the field
// saying why; the door or reader card holding it gets a marker in its title)
// and adds "in use: ..." to every pin menu's options. Everything is redrawn
// on each change, so a mark goes as soon as the clash is gone. root: the
// page; fieldIds: the label-to-field table; problems: policy.js pinProblems;
// used: policy.js pinsInUse.
function markPinProblems(root, fieldIds, problems, used) {
  root.querySelectorAll(".pin-clash").forEach(function(e) { e.classList.remove("pin-clash"); });
  root.querySelectorAll(".pin-clash-msg, .pin-clash-mark").forEach(function(e) { e.remove(); });
  problems.forEach(function(p) {
    p.labels.forEach(function(label) {
      var field = fieldIds[label] && byId(fieldIds[label]);
      if (!field) {
        return; // on another page (the Time page's RTC pins)
      }
      var others = p.labels.filter(function(l) { return l !== label; });
      var pin = field.value;
      var why = others.length ? "GPIO " + pin + " is also " + others.join(" and ") : p.text.replace(label + ": ", "");
      var box = field.closest(".field") || field.parentNode;
      box.classList.add("pin-clash");
      box.appendChild(make("div", "hint pin-clash-msg", why));
      var details = box.closest("details");
      if (details) {
        details.open = true;
      }
      // the reader card holding the field, and the door (or other) card around it
      [box.closest(".hw-reader"), box.closest(".card")].forEach(function(card) {
        var head = card && card.querySelector(".hw-reader-head, .hw-door-head, h2");
        if (head && !head.querySelector(".pin-clash-mark")) {
          head.appendChild(make("span", { className: "badge bad pin-clash-mark", title: "A pin here clashes" }, "Pin clash"));
        }
      });
    });
  });
  root.querySelectorAll("select option[data-text]").forEach(function(o) {
    var own = pinFieldLabel(o.parentNode.id) || o.parentNode.getAttribute("data-pin-label");
    var users = (used[o.value] || []).filter(function(l) { return l !== own; });
    o.textContent = o.getAttribute("data-text") + (users.length ? " \u2014 in use: " + users.join(", ") : "");
  });
}

// what the device would refuse in the page as it stands, shown above Save:
// the first problem as the device words it, then any other pin clash
function checkHardware() {
  if (!byId("hwproblem")) {
    return;
  }
  var hw = collectHardware(), b = deviceBoard();
  // with the staged Time page settings: the RTC's pins count too
  var problem = configProblem({ general: { openinghours: ALL_HOURS_OPEN }, hardware: hw, ntp: config.ntp }, b);
  var pins = b ? pinProblems(hw, b, config.ntp) : [];
  var texts = problem ? [problem] : [];
  pins.forEach(function(p) {
    if (texts.indexOf(p.text) < 0) {
      texts.push(p.text);
    }
  });
  setText("hwproblemtext", texts.length ? texts.join(". ") + "." : "");
  show("hwproblem", texts.length > 0);
  markPinProblems(document.querySelector("#ajaxcontent .hw-page"), PIN_FIELD_IDS, pins, pinsInUse(hw, config.ntp));
}

// Save: the page's values replace config.hardware only if the device would
// accept them (stageSection says why not)
function savehardware() {
  return stageSection("hardware", collectHardware());
}

// It opens a real door: asked first, as every other action that cannot be
// taken back (review 8 V8), and the admin password as well (plan 1.9.1 B1).
// A relay with no pin saved yet goes straight to the reader, which says so.
function testRelay(xnum) {
  var n = parseInt(xnum, 10) || 1;
  var send = function() { sendWithStepUp("testrelay" + n, { command: "testrelay" + n }); };
  var r = savedRelay(n);
  if (r.pin === 255) {
    send();
    return;
  }
  var what = r.ltype === 1 ?
    "Switch " + r.name + "'s lock? It is a continuous lock: it stays as switched until it is switched again." :
    "Unlock " + r.name + " for " + (Math.round(r.rtime / 100) / 10) + " s? The real lock will release.";
  confirmAction(what, "Test", send);
}

function changeRelayNumber() {
  // the form only: the count is staged by Save, with the rest of the page
  numRelays = clampRelays(parseInt(byId("numrlys").value) || 1);
  updateRelayForm();
  updateUserModalForm(); // users.js
  refreshDoorSelects();
  suggestDirections();
  placeReaders();
}

// Relay 2-4 settings as configured, or the defaults for a relay not set up yet.
function relayConf(i) {
  return config.hardware["relay" + i] || {
    "rtype": 1,
    "rhold": 1, // a new door: relay on = locked (maglock on NO)
    "ltype": 0,
    "rpin": 255, // none until one is chosen (GPIO 4 clashed with Wiegand D0)
    "rtime": 3000, // what a new relay's unlock time shows
    "doorstatpin": 255,
    "openlockpin": 255
  };
}

// Door i's card (2-4), a copy of door 1's: every id (and the label naming
// it) gets the door number, and door 1's sensor and exit fields make way for
// the door's own.
function makeDoorCard(i) {
  var card = byId("relayform").cloneNode(true);
  var drop = function(e) { e.remove(); };
  card.id = "relayform" + i;
  card.querySelectorAll(".door1-only, .helpbubble").forEach(drop);
  card.querySelector(".door-readers").textContent = "";
  card.querySelectorAll(".help[aria-expanded]").forEach(function(b) { b.setAttribute("aria-expanded", "false"); });
  card.querySelectorAll(".hw-flash").forEach(function(e) { e.classList.remove("hw-flash"); });
  card.querySelectorAll("[id]").forEach(function(e) { e.id = e.id + i; });
  card.querySelectorAll("label[for]").forEach(function(l) { l.setAttribute("for", l.getAttribute("for") + i); });
  card.querySelectorAll('[data-arg="1"]').forEach(function(e) { e.setAttribute("data-arg", String(i)); });
  card.querySelectorAll(".door-extra").forEach(function(e) { show(e); });
  var q = function(id) { return card.querySelector("#" + id + i); };
  setText(q("relaytitle"), "Door " + i);
  setText(card.querySelector(".hw-door-name"), "");
  // a relay of its own: no pin until one is chosen, its own settings
  var pinSel = q("gpiorly");
  pinSel.insertBefore(make("option", { value: "255" }, "None"), pinSel.firstChild);
  if (ajaxobj && ajaxobj.pinsio) {
    fillPinSelect(pinSel, ajaxobj.pinsio, pinLabels()); // not door 1's stray entries
    fillPinSelect(q("doorpinrly"), ajaxobj.pinsio, pinLabels());
    fillPinSelect(q("exitpinrly"), ajaxobj.pinsio, pinLabels());
  }
  var rc = relayConf(i);
  setValue(pinSel, rc.rpin);
  q("typerly").value = rc.rtype;
  q("holdrly").value = String(jsonInt(rc.rhold, 0));
  q("lockType").value = rc.ltype;
  q("delay").value = rc.rtime;
  q("doorname").value = rc.doorname || "";
  setValue(q("doorpinrly"), rc.doorstatpin === undefined ? 255 : rc.doorstatpin);
  setValue(q("exitpinrly"), rc.openlockpin === undefined ? 255 : rc.openlockpin);
  return card;
}

function updateRelayForm() {
  parkReaders(); // callers put them back with placeReaders()
  var parent = byId("relayformparent");
  for (var i = 2; i <= maxNumRelays; i++) {
    var existing = byId("relayform" + i);
    if (i <= numRelays) {
      if (!existing) {
        parent.appendChild(makeDoorCard(i));
        updateDoorHeader(i - 1);
      }
      handleLock(i);
    } else if (existing) {
      parent.removeChild(existing);
    }
  }
}
