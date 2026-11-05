// general.js: General Settings page: host name, auto restart, opening hours.

var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

var AUTO_RESTART_MIN_S = 300; // a shorter custom interval restarts the reader before it can be changed back

// the opening hours as the page shows them: seven strings of 24 "0"/"1"
function extractOpeningHours() {
  var days = Array.from(document.querySelectorAll("#openinghours .set-day"));
  var openingHours = [];
  for (var d = 0; d < 7; d++) {
    var hours = days[d].querySelectorAll(".set-hour");
    var dayFlags = "";
    for (var h = 0; h < 24; h++) {
      dayFlags += hours[h].getAttribute("aria-pressed") === "true" ? "1" : "0";
    }
    openingHours.push(dayFlags);
  }
  return openingHours;
}

// seconds as words: 7200 -> "2 hours"
function durationText(s) {
  var units = [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  for (var i = 0; i < units.length; i++) {
    if (s >= units[i][0] && s % units[i][0] === 0) {
      var n = s / units[i][0];
      return n + " " + units[i][1] + (n === 1 ? "" : "s");
    }
  }
  return s + " seconds";
}

function customRestartSeconds() {
  var raw = byId("autorestart-custom").value.trim();
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
}

function savegeneral() {
  // The admin password is changed only with Change Password (which also ends
  // every session). Settings saves send the mask, so the device keeps the
  // password it has - including on a fresh device whose UI defaults say "admin".
  var g = JSON.parse(JSON.stringify(config.general));
  g.pswd = "********";
  g.hostnm = byId("hostname").value.trim();
  if (g.hostnm === "") {
    showMessage("Not staged: Host Name must not be empty");
    byId("hostname").focus();
    return;
  }
  // the device refuses anything else (core::isValidHostname)
  if (!/^[A-Za-z0-9-]{1,32}$/.test(g.hostnm)) {
    showMessage("Not staged: Host Name must be at most 32 letters, digits and hyphens");
    byId("hostname").focus();
    return;
  }
  if (byId("autorestart").value === "custom") {
    g.restart = customRestartSeconds();
    if (isNaN(g.restart) || g.restart < AUTO_RESTART_MIN_S) {
      showMessage("Not staged: the custom restart time must be a whole number of at least " + AUTO_RESTART_MIN_S + " seconds (5 minutes)");
      byId("autorestart-custom").focus();
      return;
    }
  } else {
    g.restart = parseInt(byId("autorestart").value);
  }
  g.openinghours = extractOpeningHours();
  return spStage("general", g);
}

function autoRestartChanged() {
  var custom = byId("autorestart").value === "custom";
  show("autorestart-customrow", custom);
  var s = customRestartSeconds();
  setText("autorestart-hint", isNaN(s) ? "A whole number of seconds." :
    (s < AUTO_RESTART_MIN_S ? "At least " + AUTO_RESTART_MIN_S + " seconds (5 minutes)." : "Every " + durationText(s) + "."));
}

function hostnameTyped() {
  var v = byId("hostname").value.trim();
  setText("hostnamehint", v && !/^[A-Za-z0-9-]+$/.test(v) ?
    "Only letters, digits and hyphens: the device refuses anything else." :
    (v ? "On computers with Bonjour / mDNS: http://" + v + ".local" : ""));
}

function hh(h) {
  return (h < 10 ? "0" : "") + h + ":00";
}

// "Closed", "Open all day" or the open ranges: "08:00 to 18:00, 19:00 to 20:00"
function daySummary(flags) {
  if (flags.indexOf("1") < 0) return "Closed";
  if (flags.indexOf("0") < 0) return "Open all day";
  var ranges = [];
  for (var h = 0; h < 24; h++) {
    if (flags[h] === "1" && (h === 0 || flags[h - 1] !== "1")) {
      var end = h;
      while (end < 24 && flags[end] === "1") end++;
      ranges.push(hh(h) + " to " + (end === 24 ? "24:00" : hh(end)));
    }
  }
  return "Open " + ranges.join(", ");
}

function dayFlags(dayEl) {
  return Array.prototype.map.call(dayEl.querySelectorAll(".set-hour"), function(b) {
    return b.getAttribute("aria-pressed") === "true" ? "1" : "0";
  }).join("");
}

function refreshDay(dayEl) {
  var flags = dayFlags(dayEl);
  dayEl.querySelector(".set-daysum").textContent = daySummary(flags);
  dayEl.classList.toggle("closed", flags.indexOf("1") < 0);
}

function setHour(btn, open) {
  btn.setAttribute("aria-pressed", open ? "true" : "false");
}

function setDay(dayEl, flags) {
  dayEl.querySelectorAll(".set-hour").forEach(function(b, h) { setHour(b, flags[h] === "1"); });
  refreshDay(dayEl);
}

// "weekdays": Monday's hours to Tuesday-Friday; "all": to every day
function copyMonday(which) {
  var days = document.querySelectorAll("#openinghours .set-day");
  var mon = dayFlags(days[0]);
  var last = which === "weekdays" ? 4 : 6;
  for (var d = 1; d <= last; d++) {
    setDay(days[d], mon);
  }
  pageEdited = true; // main.js: not saved yet
  showMessage("Monday's hours copied to " + (which === "weekdays" ? "Tuesday to Friday" : "every day") + ".", "info");
}

// Mouse: press on an hour and drag along the row to set a run of hours.
// Touch keeps plain taps, so a swipe still scrolls the page.
var hourPaint = null; // { value, moved, start } while the mouse button is down

function hourGridEvents(grid) {
  grid.addEventListener("pointerdown", function(e) {
    var b = e.target.closest(".set-hour");
    if (b && e.pointerType === "mouse" && e.button === 0) {
      hourPaint = { value: b.getAttribute("aria-pressed") !== "true", moved: false, start: b };
    }
  });
  grid.addEventListener("pointerover", function(e) {
    var b = e.target.closest(".set-hour");
    if (!hourPaint || !b || !(e.buttons & 1)) return;
    if (b !== hourPaint.start || hourPaint.moved) {
      if (!hourPaint.moved) {
        setHour(hourPaint.start, hourPaint.value);
        refreshDay(hourPaint.start.closest(".set-day"));
      }
      hourPaint.moved = true;
      pageEdited = true;
      setHour(b, hourPaint.value);
      refreshDay(b.closest(".set-day"));
    }
  });
  // the hour buttons fire click, not input: each edit marks the page
  // edited itself (main.js pageEdited), or leaving it lost the changes with
  // no question (review 8 V12)
  grid.addEventListener("click", function(e) {
    var b = e.target.closest(".set-hour");
    if (b) {
      if (!(hourPaint && hourPaint.moved)) {
        setHour(b, b.getAttribute("aria-pressed") !== "true");
        refreshDay(b.closest(".set-day"));
      }
      pageEdited = true;
      hourPaint = null;
      return;
    }
    var act = e.target.closest("[data-day-set]");
    if (act) {
      var dayEl = act.closest(".set-day");
      setDay(dayEl, act.getAttribute("data-day-set") === "open" ? "1".repeat(24) : "0".repeat(24));
      pageEdited = true;
    }
  });
}

document.addEventListener("pointerup", function() {
  // a drag ends wherever the button is let go; the click (if any) comes first
  setTimeout(function() { hourPaint = null; }, 0);
});

function populateOpeningHours() {
  // Missing or damaged schedules render fully closed, never as unrestricted.
  var openingHours = Array(7).fill("000000000000000000000000");
  var holder = byId("openinghours");
  var configured = config.general.openinghours;
  if (Array.isArray(configured) && configured.length === 7 && configured.every(function(day) { return /^[01]{24}$/.test(day); })) {
    openingHours = configured;
  }
  for (var day = 0; day < 7; day++) {
    var dayEl = make("div", "set-day");
    var head = make("div", "set-dayhead");
    var names = make("div", "set-daynames");
    names.appendChild(make("span", "set-dayname", DAY_NAMES[day]));
    names.appendChild(make("span", "set-daysum"));
    head.appendChild(names);
    head.appendChild(make("button", { type: "button", className: "btn small", "data-day-set": "open", "aria-label": DAY_NAMES[day] + ": open all day" }, "All day"));
    head.appendChild(make("button", { type: "button", className: "btn small", "data-day-set": "closed", "aria-label": DAY_NAMES[day] + ": closed all day" }, "Closed"));
    dayEl.appendChild(head);
    var grid = make("div", { className: "set-hourgrid", role: "group", "aria-label": DAY_NAMES[day] + " hours" });
    for (var hour = 0; hour < 24; hour++) {
      grid.appendChild(make("button", { type: "button", className: "set-hour", "aria-pressed": openingHours[day][hour] === "1" ? "true" : "false",
        "aria-label": DAY_NAMES[day] + " " + hh(hour) + " to " + (hour === 23 ? "24:00" : hh(hour + 1)) }, (hour < 10 ? "0" : "") + hour));
    }
    dayEl.appendChild(grid);
    holder.appendChild(dayEl);
    refreshDay(dayEl);
  }
  if (!holder.hasAttribute("data-bound")) {
    holder.setAttribute("data-bound", "");
    hourGridEvents(holder);
  }
}

function listgeneral() {
  byId("hostname").value = config.general.hostnm || "";
  var restart = jsonInt(config.general.restart, 0);
  var listed = Array.prototype.some.call(byId("autorestart").options, function(o) { return o.value === String(restart); });
  byId("autorestart").value = listed ? String(restart) : "custom";
  byId("autorestart-custom").value = listed && restart === 0 ? "3600" : String(restart);
  autoRestartChanged();
  hostnameTyped();
  populateOpeningHours();
  var maglock = maglockRestartWarning(); // a scheduled restart unlocks it too
  setText("autorestartmaglock", maglock);
  show("autorestartmaglock", !!maglock);
}
