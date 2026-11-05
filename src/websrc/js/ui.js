// ui.js: Page helpers: elements, dialogs, messages, confirmations, help
// texts, the progress overlay, page switching, the menu and small formatting
// helpers. No library: plain DOM.

// ---- elements ----------------------------------------------------------------

function byId(id) {
  return document.getElementById(id);
}

// an element, or the element with that id ("name" or "#name")
function el(x) {
  return typeof x === "string" ? byId(x.charAt(0) === "#" ? x.slice(1) : x) : x;
}

// show(x) / show(x, false): the hidden attribute (the stylesheet makes it win
// over any display rule). A missing element is ignored: pages come and go.
function show(x, visible) {
  var e = el(x);
  if (e) e.hidden = visible === false;
}

function hide(x) {
  show(x, false);
}

function isShown(x) {
  var e = el(x);
  return !!e && !e.hidden && isVisible(e);
}

function setText(x, text) {
  var e = el(x);
  if (e) e.textContent = text;
}

// a new element: make("div", "card", "text") or make("a", { href: "#" }, "text")
function make(tag, attrs, text) {
  var e = document.createElement(tag);
  if (typeof attrs === "string") {
    e.className = attrs;
  } else if (attrs) {
    Object.keys(attrs).forEach(function(k) {
      if (k === "className") e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
  }
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

// an icon from the sprite in index.html
function icon(name, cls) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
  svg.setAttribute("aria-hidden", "true");
  var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

// ---- dialogs (<dialog>) -------------------------------------------------------
// data-static on a dialog: Escape and the backdrop do not close it (sign-in,
// progress, the forced password change). [data-close] buttons close their
// dialog. "close" events run afterModal() callbacks.

function isDialogOpen(id) {
  var d = el(id);
  return !!d && d.open;
}

function openDialog(id, options) {
  var d = el(id);
  if (!d) return;
  if (options && options.static !== undefined) {
    if (options.static) d.setAttribute("data-static", "");
    else d.removeAttribute("data-static");
  }
  if (!d.open) {
    d.showModal();
  }
  var focus = d.querySelector("[autofocus]") || d.querySelector("input:not([type=hidden]):not([disabled])");
  if (focus && isVisible(focus)) {
    focus.focus();
    if (focus.select) focus.select();
  }
}

function closeDialog(id) {
  var d = el(id);
  if (d && d.open) d.close();
}

// Run fn once the dialog `id` has closed (fn at once if it is not open).
function afterModal(id, fn) {
  var d = el(id);
  if (d && d.open) {
    d.addEventListener("close", function() { fn(); }, { once: true });
    d.close();
  } else {
    fn();
  }
}

document.addEventListener("cancel", function(e) {
  if (e.target.hasAttribute && e.target.hasAttribute("data-static")) {
    e.preventDefault(); // Escape
  }
}, true);

document.addEventListener("click", function(e) {
  var closer = e.target.closest && e.target.closest("[data-close]");
  if (closer) {
    var d = closer.closest("dialog");
    if (d) d.close();
    return;
  }
  // a click on the backdrop lands on the <dialog> itself, outside its box
  if (e.target.tagName === "DIALOG" && !e.target.hasAttribute("data-static")) {
    var r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      e.target.close();
    }
  }
});

// ---- messages and confirmations -------------------------------------------
// In-page replacements for alert() and confirm(), which block the page (and
// browser automation). Errors stay until closed; notes fade after a while.
var MESSAGE_FADE_MS = 8000;

var MESSAGE_MAX = 3;

var MESSAGE_ICONS = { danger: "alert", warning: "alert", success: "check", info: "info" };

function dismissMessage(div) {
  div.classList.add("leaving");
  setTimeout(function() { if (div.parentNode) div.parentNode.removeChild(div); }, 400);
}

function showMessage(text, kind) {
  kind = kind || "danger";
  var area = byId("msgarea");
  var div = make("div", "toast " + kind);
  div.setAttribute("role", kind === "danger" ? "alert" : "status");
  div.appendChild(icon(MESSAGE_ICONS[kind] || "info"));
  div.appendChild(make("span", "msgtext", text));
  var close = make("button", { type: "button", className: "iconbtn close", "aria-label": "Close" });
  close.appendChild(icon("x", "icon-sm"));
  close.addEventListener("click", function() { dismissMessage(div); });
  div.appendChild(close);
  area.appendChild(div);
  while (area.children.length > MESSAGE_MAX) {
    area.removeChild(area.firstChild);
  }
  if (kind !== "danger") {
    setTimeout(function() { dismissMessage(div); }, MESSAGE_FADE_MS);
  }
}

function clearMessages() {
  byId("msgarea").textContent = "";
}

// A dialog in place of confirm(): onYes runs once it has closed.
function confirmAction(text, okLabel, onYes) {
  setText("confirmtext", text);
  var ok = byId("confirmok");
  var fresh = ok.cloneNode(false); // drops the previous question's handler
  fresh.textContent = okLabel || "OK";
  ok.parentNode.replaceChild(fresh, ok);
  fresh.addEventListener("click", function() {
    afterModal("confirmmodal", onYes);
  }, { once: true });
  openDialog("confirmmodal");
}

// The text of the label of a settings field, for messages.
function labelOf(id) {
  var e = byId(id);
  var field = e && e.closest(".field, .form-group");
  var label = field && field.querySelector("label, .label");
  if (!label) return id;
  var copy = label.cloneNode(true);
  copy.querySelectorAll(".help, .helpbubble").forEach(function(h) { h.remove(); });
  return copy.textContent.trim();
}

// ---- help texts ---------------------------------------------------------------
// A help button (class "help", data-content) next to a label: a tap shows its
// text below the field's label, a second tap hides it. textContent only: the
// text is never parsed as HTML.
// the element the help text goes after: the label row, or the button
function helpAnchor(btn) {
  return btn.closest(".labelrow") || btn;
}

function toggleHelp(btn) {
  var anchor = helpAnchor(btn);
  var next = anchor.nextElementSibling;
  if (next && next.classList.contains("helpbubble")) {
    next.remove();
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  var bubble = make("div", "helpbubble", btn.getAttribute("data-content"));
  bubble.setAttribute("role", "note");
  anchor.insertAdjacentElement("afterend", bubble);
  btn.setAttribute("aria-expanded", "true");
}

document.addEventListener("click", function(e) {
  var btn = e.target.closest && e.target.closest(".help[data-content]");
  if (btn) {
    e.preventDefault();
    toggleHelp(btn);
    return;
  }
  // a tap anywhere else (not on a help text) closes the help texts shown,
  // as the old popovers did
  if (e.target.closest && e.target.closest(".helpbubble")) return;
  document.querySelectorAll(".helpbubble").forEach(function(b) {
    var h = b.previousElementSibling;
    if (h && !h.classList.contains("help")) h = h.querySelector(".help");
    if (h) h.setAttribute("aria-expanded", "false");
    b.remove();
  });
});

// ---- progress overlay: save & reboot, firmware update, restart, reset ------
// A dialog over the app (upstream replaced the whole page before the device
// had answered, so a refused save left a dead page and lost every staged
// change). The app stays as it is until the device accepts; on a refusal the
// overlay shows the device's reason and closes back to the unchanged app.
var progressTimer = null;

var progressWatch = null;

var progressOp = null;   // "commit", "upload", "restart" or "destroy" while waiting

var rebooting = false;   // the device accepted and restarts: no reconnect, no login

var PROGRESS_TITLES = { commit: "Saving settings...", upload: "Updating firmware...", restart: "Restarting...", destroy: "Factory reset..." };

var PROGRESS_FAILED = { commit: "Not saved", upload: "Not updated", restart: "Not restarted", destroy: "Not reset" };

var PROGRESS_OF_RESULT = { configfile: "commit", restart: "restart", destroy: "destroy" };

var PROGRESS_TIMEOUT_MS = 20000;

function stopProgressTimers() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  if (progressWatch) { clearTimeout(progressWatch); progressWatch = null; }
}

// kind: "busy" (waiting), "ok" or "fail"
function setProgressBar(kind, width, text) {
  var bar = byId("updateprog");
  bar.className = "bar " + kind;
  bar.style.width = width + "%";
  bar.setAttribute("aria-valuenow", width);
  setText("updateproglabel", text);
}

function progressFailed(message) {
  stopProgressTimers();
  setProgressBar("fail", 100, PROGRESS_FAILED[progressOp] || "Failed");
  setText("progressmsg", message || "The device refused the request.");
  show("progressclose");
  byId("progressmodal").removeAttribute("data-static");
  progressOp = null;
}

var PROGRESS_DONE = { commit: "Saved, restarting...", upload: "Updated, restarting...", restart: "Restarting...", destroy: "Reset, restarting..." };

var RESTART_POLL_MS = 2000;

// reload anyway if the connection never dropped: the reader waits up to 30 s
// for its doors to be idle before it restarts (core::RestartGate::GRACE_MS)
var RESTART_GRACE_MS = 35000;

var deviceWentDown = false;

// The device accepted and now restarts. Wait until it has gone away and
// answers again, then reload: sessions live in its RAM, so it asks for the
// password again. (Upstream linked to http://<hostname>.local and said
// "Completed" before the reboot: .local fails on Android and on the hotspot.)
function progressFinished(restart) {
  var op = progressOp;
  if (op === "commit" && restart === false) {
    // the device applied the settings at once and keeps running: no reload
    stopProgressTimers();
    progressOp = null;
    savedConfig = JSON.parse(JSON.stringify(config));
    hide(document.querySelector(".footer"));
    setProgressBar("ok", 100, "Saved");
    setText("progressmsg", "");
    setTimeout(function() {
      closeDialog("progressmodal");
      showMessage("Saved. The reader uses the new settings now; no restart was needed.", "success");
    }, 700);
    return;
  }
  stopProgressTimers();
  rebooting = true;
  deviceWentDown = false;
  if (op === "commit") {
    savedConfig = JSON.parse(JSON.stringify(config));
    hide(document.querySelector(".footer"));
  }
  progressOp = null;
  setProgressBar("ok busy", 100, PROGRESS_DONE[op] || "Restarting...");
  setText("progressmsg", op === "destroy" ?
    "The reader starts again with factory settings and its own hotspot (IRONFRAME-RFID-...). If this page does not come back, join that hotspot (password " + SETUP_HOTSPOT_PASSWORD + ") and open http://192.168.4.1." :
    "This page reloads by itself once the reader answers again.");
  var reconnect = byId("reconnect");
  reconnect.textContent = "";
  reconnect.appendChild(make("a", { href: location.origin + "/" }, "Reload now"));
  show(reconnect);
  var started = Date.now();
  var poll = function() {
    // the device serves GET routes only; no-store so the cache cannot answer for it
    fetch("/favicon.svg", { cache: "no-store" }).then(function(r) {
      if (r.ok && (deviceWentDown || Date.now() - started > RESTART_GRACE_MS)) {
        location.reload();
      } else {
        setTimeout(poll, RESTART_POLL_MS);
      }
    }, function() {
      deviceWentDown = true;
      setTimeout(poll, RESTART_POLL_MS);
    });
  };
  setTimeout(poll, RESTART_POLL_MS);
}

// The firmware image, with its real upload progress (the device answers
// "OK" once it has written and checked the image). step: the step-up answer.
function uploadFirmware(formData, step) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", "/update", true);
  xhr.setRequestHeader("X-Session-Token", sessionToken);
  xhr.setRequestHeader("X-Admin-Nonce", step.stepnonce);
  xhr.setRequestHeader("X-Admin-Proof", step.stepproof);
  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable && progressOp === "upload") {
      var pct = Math.min(99, Math.floor((e.loaded * 100) / e.total));
      setProgressBar("busy", pct, e.loaded < e.total ? "Uploading " + pct + "%" : "Writing to flash...");
    }
  };
  xhr.onload = function() {
    var body = String(xhr.responseText || "").trim();
    if (xhr.status === 200 && body === "OK") {
      progressFinished();
    } else {
      if (xhr.status === 403) signinHa1 = null; // the password was not confirmed: ask next time
      // the device's reason (wrong image, another upload, the flash error)
      progressFailed("Firmware update failed: " + (body || "HTTP " + xhr.status));
    }
  };
  xhr.onerror = function() {
    progressFailed("Firmware update failed: no answer from the device");
  };
  xhr.send(formData);
}

function inProgress(op, formData) {
  stopProgressTimers();
  progressOp = op;
  setText("progresstitle", PROGRESS_TITLES[op]);
  setText("progressmsg", "");
  hide("progressclose");
  var reconnect = byId("reconnect");
  reconnect.textContent = "";
  hide(reconnect);
  setProgressBar("busy", 0, op === "upload" ? "Uploading 0%" : "Waiting for the reader...");
  openDialog("progressmodal", { static: true });
  // an update, a factory reset and a network or MQTT change prove the admin
  // password as well (withStepUp, plan 1.9 S1)
  // a save carries one whenever the password is at hand (the device compares
  // against its stored file, which may lack defaults this page fills in), and
  // asks for it only for a network or MQTT change, or after a refusal
  var stepAction = op === "upload" ? "update" : op === "destroy" ? "destroy" : op === "restart" ? "restart" :
    op === "commit" && (signinHa1 || stepUpRequired || needsStepUp(savedConfig, config)) ? "settings" : null;
  if (stepAction) {
    withStepUp(stepAction, function(step) { sendProgressOp(op, formData, step); }, function(message, cancelled) {
      if (!cancelled) {
        progressFailed(message);
        return;
      }
      stopProgressTimers(); // nothing was sent: close quietly, say so
      progressOp = null;
      closeDialog("progressmodal");
      showMessage(message, "info");
    });
    return;
  }
  sendProgressOp(op, formData, null);
}

function sendProgressOp(op, formData, step) {
  if (op === "upload") {
    uploadFirmware(formData, step);
    return;
  }
  // a reader answers a save in about a second: the bar shows time passing,
  // not a percentage it does not know
  var started = Date.now();
  progressTimer = setInterval(function() {
    var pct = Math.min(95, Math.round(((Date.now() - started) * 100) / PROGRESS_TIMEOUT_MS));
    setProgressBar("busy", pct, "Waiting for the reader...");
  }, 500);
  // no answer at all (connection lost): say so instead of spinning forever
  progressWatch = setTimeout(function() {
    progressFailed("The device did not answer. Nothing has changed on this page: check the connection and try again.");
  }, PROGRESS_TIMEOUT_MS);
  if (!websock || websock.readyState !== 1) {
    progressFailed("Not connected to the device. Your changes are still here: try again once it reconnects.");
    return;
  }
  if (op === "commit") {
    var send = step ? Object.assign({}, config, step) : config;
    sendWebsocket(JSON.stringify(send));
  } else if (op === "restart") {
    sendWebsocket(JSON.stringify(Object.assign({ command: "restart" }, step || {})));
  } else if (op === "destroy") {
    sendWebsocket(JSON.stringify(Object.assign({ command: "destroy" }, step || {})));
  }
}

// ---- pages ------------------------------------------------------------------

var PAGE_OF_CONTENT = {
  "#statuscontent": "status", "#networkcontent": "network", "#hardwarecontent": "hardware",
  "#generalcontent": "general", "#mqttcontent": "mqtt", "#ntpcontent": "ntp",
  "#userscontent": "users", "#logcontent": "latestlog", "#eventcontent": "eventlog",
  "#logmaintenancecontent": "logmaintenance", "#backupcontent": "backup"
};

// The open page in the menu, the tab bar and the title bar.
function markActive(pageId) {
  document.querySelectorAll("#sidebar .navlink.active").forEach(function(a) { a.classList.remove("active"); });
  var link = byId(pageId);
  if (link) {
    link.classList.add("active");
    setText("pagetitle", link.textContent.trim());
  }
  document.querySelectorAll(".tabbar [data-tab]").forEach(function(t) {
    t.classList.toggle("active", t.getAttribute("data-tab") === pageId);
  });
}

function getContent(contentname) {
  closeMenu();
  clearMessages(); // messages belong to the page that was open
  // a fresh copy of the page template: ids are unique in the document
  var content = document.importNode(byId(contentname.slice(1)).content, true);
  var holder = byId("ajaxcontent");
  holder.textContent = "";
  holder.appendChild(content);
  markActive(PAGE_OF_CONTENT[contentname]);
  window.scrollTo(0, 0);
  // Fill the page as soon as it is in place, before anything can be pressed:
  // an unfilled page's Save would store the template's placeholder values.
  switch (contentname) {
    case "#statuscontent":
      listStats();
      break;
    case "#backupcontent":
      break;
    case "#ntpcontent":
      listntp();
      break;
    case "#mqttcontent":
      listmqtt();
      break;
    case "#generalcontent":
      listgeneral();
      break;
    case "#hardwarecontent":
      listhardware();
      break;
    case "#logmaintenancecontent":
      // configs saved before the setting existed have no "logging": that means on
      document.querySelector("#logging").value = parseInt(config.general.logging) === 0 ? "0" : "1";
      page = 1;
      data = [];
      getFileList();
      break;
    case "#networkcontent":
      listnetwork();
      break;
    case "#logcontent":
      page = 1;
      data = [];
      listlog();
      break;
    case "#userscontent":
      page = 1;
      data = [];
      getUsers();
      break;
    case "#eventcontent":
      page = 1;
      data = [];
      getEvents();
      break;
    default:
      break;
  }
}

function removeModal() {
  closeDialog("restoremodal");
}

function isVisible(e) {
  return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
}

function twoDigits(value) {
  if (value < 10) {
    return "0" + value;
  }
  return value;
}

// User validity dates, in this browser's time zone. An <input type=date>
// value parsed with new Date() is UTC midnight, so "valid until 19 March"
// ended at 01:00 on the 19th in the UK (and on the 18th west of UTC):
// valid since is now the start of the chosen local day, valid until its end.
function dayEpoch(value, endOfDay) {
  var p = String(value || "").split("-");
  if (p.length !== 3) {
    return 0;
  }
  var d = endOfDay ? new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59) : new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function localDay(epochSeconds) {
  var d = new Date(epochSeconds * 1000);
  return d.getFullYear() + "-" + twoDigits(d.getMonth() + 1) + "-" + twoDigits(d.getDate());
}

function saveLogfile(obj, anchorElement, filename) {
  var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(obj, null, 2));
  var dlAnchorElem = byId(anchorElement);
  dlAnchorElem.setAttribute("href", dataStr);
  dlAnchorElem.setAttribute("download", filename);
  dlAnchorElem.click();
}

// ---- the menu ---------------------------------------------------------------

function menuIsOpen() {
  return byId("sidebar").classList.contains("active");
}

function openMenu() {
  byId("sidebar").classList.add("active");
  document.querySelector(".overlay").classList.add("active");
}

function closeMenu() {
  byId("sidebar").classList.remove("active");
  document.querySelector(".overlay").classList.remove("active");
}

byId("sidebarCollapse").addEventListener("click", openMenu);
byId("dismiss").addEventListener("click", closeMenu);
document.querySelector(".overlay").addEventListener("click", closeMenu);

// Swipe right from the left edge opens the menu; swipe left closes it.
// Upstream reacted to the first pixel of any mostly-horizontal move, so
// scrolling a wide table or the opening-hours grid sideways opened the menu.
var SWIPE_EDGE_PX = 24;   // an opening swipe must start this close to the left edge

var SWIPE_MIN_PX = 50;    // and travel at least this far sideways

var xDown = null;

var yDown = null;

function swipeAction(x0, y0, x1, y1, menuOpen) {
  var dx = x1 - x0, dy = y1 - y0;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) {
    return null; // too short, or not clearly sideways
  }
  if (dx > 0 && !menuOpen && x0 <= SWIPE_EDGE_PX) {
    return "open";
  }
  if (dx < 0 && menuOpen) {
    return "close";
  }
  return null;
}

function handleTouchStart(evt) {
  xDown = evt.touches[0].clientX;
  yDown = evt.touches[0].clientY;
}

function handleTouchMove(evt) {
  if (xDown === null || yDown === null) {
    return;
  }
  var action = swipeAction(xDown, yDown, evt.touches[0].clientX, evt.touches[0].clientY, menuIsOpen());
  if (action === "open") {
    openMenu();
  } else if (action === "close") {
    closeMenu();
  }
  if (action) {
    xDown = null; // one action per swipe
    yDown = null;
  }
}
