// ntp.js: Time Settings page.

var deviceClockAt = null;   // { epoch, at }: the device's time and when it arrived

var deviceClockTimer = null;

var timeSetPending = false; // "Set from this browser" sent, the answer not yet in

// this browser's time zone name, or ""
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) {
    return "";
  }
}

// The zone list's option for a browser zone name, or null: the option named
// after it ("Europe/London (UK, ...)"), or the zone that shares its rules.
var ZONE_ALIASES = { "Europe/Dublin": "Europe/London", "Europe/Lisbon": "Europe/London", "Europe/Belfast": "Europe/London" };
function zoneOptionFor(tz) {
  if (!tz) return null;
  var name = ZONE_ALIASES[tz] || tz;
  var opts = byId("DropDownTimezone").options;
  for (var i = 0; i < opts.length; i++) {
    var t = opts[i].textContent;
    if (opts[i].value && (t === name || t.indexOf(name + " (") === 0 || t.indexOf(name + ",") === 0)) return opts[i];
  }
  return null;
}

function clockText(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// the clock on the page, running on from the device's last answer
function tickDeviceClock() {
  var now = byId("device-time");
  if (!now) {
    clearInterval(deviceClockTimer); // the page was left
    deviceClockTimer = null;
    return;
  }
  if (!deviceClockAt) {
    return;
  }
  var note = byId("device-time-note");
  var box = now.closest(".set-clock");
  if (deviceClockAt.epoch <= CLOCK_TRUSTED_FROM) {
    now.textContent = "Not set";
    note.textContent = "The reader does not know the time (it forgets it at every power cut). Users with dates or opening hours are refused until it is set.";
    box.classList.add("unset");
    return;
  }
  box.classList.remove("unset");
  var ms = deviceClockAt.epoch * 1000 + (Date.now() - deviceClockAt.at);
  now.textContent = clockText(ms);
  var drift = Math.round((ms - Date.now()) / 1000);
  var tz = browserTimeZone();
  note.textContent = "Shown in this browser's time zone" + (tz ? " (" + tz + ")" : "") + ". " +
    (Math.abs(drift) <= 2 ? "Same as this browser." : Math.abs(drift) + " s " + (drift < 0 ? "behind" : "ahead of") + " this browser.");
}

// the device's time arrived (transport.js, "gettime")
function deviceTime() {
  deviceClockAt = { epoch: Number(utcSeconds) || 0, at: Date.now() };
  if (!byId("device-time")) {
    return;
  }
  tickDeviceClock();
  if (!deviceClockTimer) {
    deviceClockTimer = setInterval(tickDeviceClock, 1000);
  }
  if (timeSetPending) {
    timeSetPending = false;
    byId("synctimeb").disabled = false;
    if (deviceClockAt.epoch > CLOCK_TRUSTED_FROM) {
      showMessage("The reader's clock is set from this browser.", "success");
    }
  }
}

function syncBrowserTime() {
  var datatosend = {};
  datatosend.command = "settime";
  datatosend.epoch = Math.floor(Date.now() / 1000);
  timeSetPending = true;
  byId("synctimeb").disabled = true;
  var send = function(step) {
    sendWebsocket(JSON.stringify(Object.assign(datatosend, step || {})));
    sendWebsocket("{\"command\":\"gettime\"}"); // the clock shown is the one the reader now has
  };
  // a clock already set decides who gets in by date and hour: moving it
  // needs the admin password as well (plan 1.9.1 B1); a lost one does not
  if ((ajaxobj && ajaxobj.timetrusted) || (deviceClockAt && deviceClockAt.epoch > CLOCK_TRUSTED_FROM)) {
    withStepUp("settime", send, function(message) {
      timeSetPending = false;
      if (byId("synctimeb")) byId("synctimeb").disabled = false;
      showMessage(message);
    });
  } else {
    send(null);
  }
  setTimeout(function() {
    var b = byId("synctimeb");
    if (b && timeSetPending) {
      timeSetPending = false;
      b.disabled = false;
      showMessage("The reader did not confirm the new time. Try again.", "warning");
    }
  }, 10000);
}

// ---- the RTC module (core/rtc.h) ---------------------------------------------
// Its pins are checked with the Doors & Readers ones (policy.js pinProblems):
// a clash is marked here and there (hardware.js markPinProblems).
var RTC_PIN_FIELD_IDS = { "RTC SDA": "rtcsdapin", "RTC SCL": "rtcsclpin" };

function shortDate(ms) {
  var d = new Date(ms), two = function(n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
}

// status.rtc, as the reader found its RTC when it started
function rtcStatusText(r) {
  if (!r || r.state === "off") {
    return "No RTC was in use when the reader started.";
  }
  if (r.state === "ok") {
    return "RTC found: " + shortDate(r.time * 1000) + " (this browser's time zone).";
  }
  if (r.state === "lost") {
    return "RTC found, but it lost the time: battery? It is set again from NTP or from this browser.";
  }
  return "RTC not found: check its wiring, its pins and its 3.3 V supply.";
}

// the RTC settings on the page: none stored and none chosen stays none
// (a page saved over settings from before 1.7 adds no key)
function collectRtc() {
  var type = parseInt(byId("rtctype").value) || 0;
  if (type === 0 && !isObj(config.ntp.rtc)) {
    return undefined;
  }
  return { type: type, sdapin: parseInt(byId("rtcsdapin").value), sclpin: parseInt(byId("rtcsclpin").value) };
}

// the RTC's pin clashes with the staged Doors & Readers settings, shown on its fields
function checkRtc() {
  if (!byId("rtcpins")) {
    return;
  }
  var b = deviceBoard(), ntp = { rtc: collectRtc() };
  var mine = (b ? pinProblems(config.hardware, b, ntp) : []).filter(function(p) {
    return p.labels.some(function(l) { return l in RTC_PIN_FIELD_IDS; });
  });
  setText("ntpproblemtext", mine.length ? mine.map(function(p) { return p.text; }).join(". ") + "." : "");
  show("ntpproblem", mine.length > 0);
  markPinProblems(document.querySelector("#ajaxcontent .set-ntp"), RTC_PIN_FIELD_IDS, mine, pinsInUse(config.hardware, ntp));
}

function rtcTypeChanged() {
  show("rtcpins", byId("rtctype").value !== "0");
  checkRtc();
}

function listntp() {
  deviceClockAt = null;
  timeSetPending = false;
  sendWebsocket("{\"command\":\"gettime\"}");
  byId("ntpserver").value = config.ntp.server || "";
  byId("intervals").value = config.ntp.interval === undefined || config.ntp.interval === null ? "" : config.ntp.interval;
  // a zone the list does not have (a backup, MQTT, an older UI) stays as it is
  spSelect("DropDownTimezone", config.ntp.tzinfo, "Other: " + String(config.ntp.tzinfo));
  var tz = browserTimeZone();
  var offered = !config.ntp.tzinfo ? zoneOptionFor(tz) : null;
  if (offered) {
    // none set (UTC put the hours an hour off in summer): this browser's
    // zone is selected; Save keeps it (review 8 R4-20)
    byId("DropDownTimezone").value = offered.value;
  }
  setText("browsertz", tz ? "This browser is in " + tz + "." + (offered ? " Its zone is selected: press Save to keep it." : "") : "");
  var rtc = isObj(config.ntp.rtc) ? config.ntp.rtc : {};
  if (ajaxobj && ajaxobj.pinsio) {
    fillPinSelect("rtcsdapin", ajaxobj.pinsio, pinLabels());
    fillPinSelect("rtcsclpin", ajaxobj.pinsio, pinLabels());
  }
  spSelect("rtctype", jsonInt(rtc.type, 0), "Unknown: " + String(rtc.type));
  setValue("rtcsdapin", jsonInt(rtc.sdapin, 21)); // none stored: GPIO21/22 (core/rtc.h)
  setValue("rtcsclpin", jsonInt(rtc.sclpin, 22));
  setText("rtcstatus", rtcStatusText(ajaxobj && ajaxobj.rtc));
  var root = document.querySelector("#ajaxcontent .set-ntp");
  root.addEventListener("change", checkRtc);
  rtcTypeChanged();
  clearInterval(deviceClockTimer);
  deviceClockTimer = null;
}

function saventp() {
  var n = JSON.parse(JSON.stringify(config.ntp));
  n.server = byId("ntpserver").value.trim();
  n.interval = spWholeNumber("intervals", 0, 10080);
  if (isNaN(n.interval)) {
    showMessage("Not staged: Sync interval must be a whole number of minutes from 0 to 10080 (30 is the default)");
    byId("intervals").focus();
    return;
  }
  n.tzinfo = byId("DropDownTimezone").value;
  var rtc = collectRtc();
  if (rtc) {
    n.rtc = rtc;
  }
  return spStage("ntp", n);
}
