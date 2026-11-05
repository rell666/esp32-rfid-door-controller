// logs.js: Access Log, Event Log and Log Settings pages.
//
// The log pages: transport.js fetches every page of the file (byte offsets,
// one request at a time) into `data`, then calls initLatestLogTable /
// initEventTable. Here the lines are parsed once and shown newest first,
// 50 at a time, with a search box and a filter. Device text goes into the
// page with textContent only (a log line can hold anything a card or an
// MQTT message put there).

var LOG_PAGE_SIZE = 50;


var LOG_FILE_ACCESS = "/latestlog.json";

var LOG_FILE_EVENT = "/eventlog.json";

var EVENT_TYPES = { INFO: "Info", WARN: "Warning", ERRO: "Error" };

var EVENT_TYPE_BADGE = { INFO: "", WARN: "warn", ERRO: "bad" };

var EVENT_SOURCES = { sys: "System", rfid: "Reader", mqtt: "MQTT", doorbell: "Doorbell", updt: "Firmware update", WEBIF: "Web page" };

var ACCESS_ROLES = { 1: "Always", 99: "Admin", 0: "Disabled", 98: "Unknown", 2: "Expired" };

// The open log page: its kind (below), the parsed rows and what is shown.
var logView = null;

function logText(v) {
  return v === undefined || v === null ? "" : String(v);
}

// local date and time, or how long after start-up if the clock was not set
function logTime(value) {
  var v = Number(value);
  if (value === undefined || value === null || value === "" || !isFinite(v)) return "";
  if (v <= CLOCK_TRUSTED_FROM) return Math.floor(v) + " s after start (clock not set)";
  var d = new Date(v * 1000);
  return d.getFullYear() + "-" + twoDigits(d.getMonth() + 1) + "-" + twoDigits(d.getDate()) + " " +
    twoDigits(d.getHours()) + ":" + twoDigits(d.getMinutes()) + ":" + twoDigits(d.getSeconds());
}

// a line of the file as an object, or null if it is not one
function logLine(line) {
  try {
    var o = JSON.parse(line);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (e) {
    return null;
  }
}

var ACCESS_LOG = {
  prefix: "latest",
  table: "latestlogtable",
  file: LOG_FILE_ACCESS,
  noun: "access log",
  columns: [
    { key: "time", title: "Date", cls: "c-time", fileOrder: true },
    { key: "uid", title: "UID", cls: "c-uid mono" },
    { key: "name", title: "User Name or Label", cls: "c-name" },
    { key: "door", title: "Door", cls: "c-door" },
    { key: "dir", title: "In/Out", cls: "c-dir" },
    { key: "role", title: "Role", cls: "c-role" },
    { key: "access", title: "Access", cls: "c-access", badge: true }
  ],
  kinds: ["all", "granted", "denied"],
  row: function(line, i) {
    var o = logLine(line);
    if (!o) {
      return { i: i, kind: "other", badge: "warn", cells: { time: "", uid: "", name: "Unreadable log entry: " + line.slice(0, 120), door: "", dir: "", role: "", access: "Unknown" } };
    }
    var access = o.access === 1 ? "granted" : o.access === 0 ? "denied" : "other";
    return {
      i: i,
      kind: access,
      badge: access === "granted" ? "ok" : access === "denied" ? "bad" : "",
      cells: {
        time: logTime(o.timestamp),
        uid: logText(o.uid),
        name: logText(o.username),
        door: logText(o.door),
        dir: o.dir === "in" ? "In" : o.dir === "out" ? "Out" : "",
        role: ACCESS_ROLES.hasOwnProperty(o.acctype) ? ACCESS_ROLES[o.acctype] : logText(o.acctype),
        access: access === "granted" ? "Granted" : access === "denied" ? "Denied" : "Unknown"
      }
    };
  }
};

var EVENT_LOG = {
  prefix: "event",
  table: "eventtable",
  file: LOG_FILE_EVENT,
  noun: "event log",
  columns: [
    { key: "id", title: "#", cls: "c-id", fileOrder: true },
    { key: "type", title: "Event Type", cls: "c-type", badge: true },
    { key: "src", title: "Source", cls: "c-src" },
    { key: "desc", title: "Description", cls: "c-desc" },
    { key: "data", title: "Additional Data", cls: "c-data mono" },
    { key: "time", title: "Date", cls: "c-time", fileOrder: true }
  ],
  kinds: ["all", "ERRO", "WARN", "INFO"],
  row: function(line, i) {
    var o = logLine(line);
    if (!o) {
      // as upstream: an error entry that shows the raw line
      o = { type: "ERRO", src: "WEBIF", desc: "Unreadable log entry", data: line };
    }
    var type = logText(o.type), src = logText(o.src);
    return {
      i: i,
      kind: EVENT_TYPES.hasOwnProperty(type) ? type : "other",
      badge: EVENT_TYPE_BADGE[type] || "",
      cells: {
        id: String(i + 1),
        type: EVENT_TYPES[type] || type,
        src: EVENT_SOURCES[src] || src,
        desc: logText(o.desc),
        data: logText(o.data),
        time: logTime(o.time)
      },
      raw: type + " " + src // the codes as MQTT and the downloaded file show them
    };
  }
};

// ---- loading ----------------------------------------------------------------

// The page has just been put in place (getContent): set up its controls and
// say which file it shows.
function setupLogView(kind) {
  // sortKey: null = the order the entries were written (newest first, or
  // oldest first), else a column, A to Z (sortAsc) or Z to A
  logView = { kind: kind, rows: [], search: "", filter: "all", newestFirst: true, sortKey: null, sortAsc: true, page: 0, loaded: false };
  var other = theCurrentLogFile && theCurrentLogFile !== kind.file;
  show(kind.prefix + "filebanner", !!other);
  setText(kind.prefix + "filename", theCurrentLogFile);
  setText(kind.prefix + "cleartip", other ?
    "Only the current log can be cleared here; delete older files under Log Settings." : "");
}

function listlog() {
  setupLogView(ACCESS_LOG);
  logpos = 0;
  logeof = false;
  sendWebsocketWithRetry(JSON.stringify({ command: "getlatestlog", page: page, pos: 0, filename: theCurrentLogFile }));
}

function getEvents() {
  setupLogView(EVENT_LOG);
  logpos = 0;
  logeof = false;
  sendWebsocketWithRetry(JSON.stringify({ command: "geteventlog", page: page, pos: 0, filename: theCurrentLogFile }));
}

// every page of the file has arrived (transport.js)
function initLatestLogTable() {
  initLogTable(ACCESS_LOG);
}

function initEventTable() {
  initLogTable(EVENT_LOG);
}

function initLogTable(kind) {
  if (!byId(kind.table)) return; // the page was left while it loaded
  if (!logView || logView.kind !== kind) setupLogView(kind);
  logView.rows = data.map(function(line, i) {
    var row = kind.row(String(line), i);
    row.text = Object.keys(row.cells).map(function(k) { return row.cells[k]; }).join(" ").toLowerCase() +
      (row.raw ? " " + row.raw.toLowerCase() : "");
    return row;
  });
  logView.loaded = true;
  logView.page = 0;
  renderLogCounts();
  renderLogTable();
}

// the menu link opens the current file; Reload keeps the file shown
function reloadLog() {
  if (!logView) return;
  getContent(logView.kind === ACCESS_LOG ? "#logcontent" : "#eventcontent");
}

function showCurrentLog() {
  openMenuPage(logView && logView.kind === EVENT_LOG ? "eventlog" : "latestlog");
}

// ---- search, filter, order, pages --------------------------------------

function logSearch(value) {
  if (!logView) return;
  logView.search = String(value || "").trim().toLowerCase();
  logView.page = 0;
  renderLogTable();
}

function logFilter(value) {
  if (!logView) return;
  logView.filter = value;
  logView.page = 0;
  renderLogTable();
}

// The order button: newest first / oldest first (from a column sort: back to
// the order the entries were written, newest first).
function logToggleOrder() {
  if (!logView) return;
  if (logView.sortKey) {
    logView.sortKey = null;
    logView.newestFirst = true;
  } else {
    logView.newestFirst = !logView.newestFirst;
  }
  logView.page = 0;
  renderLogTable();
}

// A column heading (desktop): sort by that column, again for the other way
// round. Date (and #) is the order the entries were written.
function logSort(key) {
  if (!logView) return;
  var col = logView.kind.columns.filter(function(c) { return c.key === key; })[0];
  if (!col) return;
  if (col.fileOrder) {
    logView.newestFirst = logView.sortKey ? true : !logView.newestFirst;
    logView.sortKey = null;
  } else if (logView.sortKey === key) {
    logView.sortAsc = !logView.sortAsc;
  } else {
    logView.sortKey = key;
    logView.sortAsc = true;
  }
  logView.page = 0;
  renderLogTable();
}

function renderLogOrder() {
  var v = logView, p = v.kind.prefix;
  var col = v.sortKey && v.kind.columns.filter(function(c) { return c.key === v.sortKey; })[0];
  setText(p + "ordertext", col ? "By " + col.title.toLowerCase() + (v.sortAsc ? " (A\u2013Z)" : " (Z\u2013A)") : v.newestFirst ? "Newest first" : "Oldest first");
  var btn = byId(p + "order");
  if (btn) btn.setAttribute("title", col ? "Back to newest first" : "Change the order");
}

function logClearSearch() {
  if (!logView) return;
  var p = logView.kind.prefix;
  var box = byId(p + "search");
  if (box) box.value = "";
  var all = document.querySelector("input[name=" + p + "kind][value=all]");
  if (all) all.checked = true;
  logView.search = "";
  logView.filter = "all";
  logView.page = 0;
  renderLogTable();
}

function logPage(step) {
  if (!logView) return;
  logView.page += step === "next" ? 1 : -1;
  renderLogTable();
  var card = byId(logView.kind.prefix + "card");
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView();
}

// the rows that pass the search and the filter, in the chosen order
// (file order is the order they were written: newest last)
function logVisibleRows() {
  var v = logView;
  var out = v.rows.filter(function(r) {
    return (v.filter === "all" || r.kind === v.filter) && (!v.search || r.text.indexOf(v.search) >= 0);
  });
  if (v.sortKey) {
    var k = v.sortKey, dir = v.sortAsc ? 1 : -1;
    out.sort(function(a, b) {
      return dir * a.cells[k].localeCompare(b.cells[k], undefined, { numeric: true, sensitivity: "base" }) || b.i - a.i;
    });
  } else if (v.newestFirst) {
    out.reverse();
  }
  return out;
}

// how many entries of each kind, on the filter buttons
function renderLogCounts() {
  var p = logView.kind.prefix;
  logView.kind.kinds.forEach(function(k) {
    var n = k === "all" ? logView.rows.length : logView.rows.filter(function(r) { return r.kind === k; }).length;
    setText(p + "count-" + k, String(n));
  });
}

function renderLogTable() {
  var kind = logView.kind, p = kind.prefix;
  var table = byId(kind.table);
  if (!table) return;
  var rows = logVisibleRows();
  var pages = Math.max(1, Math.ceil(rows.length / LOG_PAGE_SIZE));
  logView.page = Math.min(Math.max(0, logView.page), pages - 1);
  var first = logView.page * LOG_PAGE_SIZE;
  var shown = rows.slice(first, first + LOG_PAGE_SIZE);

  renderLogOrder();
  table.textContent = "";
  var thead = make("thead");
  var head = make("tr");
  kind.columns.forEach(function(c) {
    var sorted = c.fileOrder ? !logView.sortKey : logView.sortKey === c.key;
    var dir = c.fileOrder ? (logView.newestFirst ? "descending" : "ascending") : (logView.sortAsc ? "ascending" : "descending");
    var th = make("th", { scope: "col", className: c.cls.split(" ")[0], "aria-sort": sorted ? dir : "none" });
    th.appendChild(make("button", { type: "button", className: "sortbtn", "data-onclick": "logSort", "data-arg": c.key, title: "Sort by " + c.title.toLowerCase() }, c.title));
    head.appendChild(th);
  });
  thead.appendChild(head);
  table.appendChild(thead);
  var tbody = make("tbody");
  shown.forEach(function(r) {
    var tr = make("tr", "lv-" + (r.badge || "plain"));
    kind.columns.forEach(function(c) {
      var td = make("td", { className: c.cls, "data-label": c.title });
      var text = r.cells[c.key];
      if (c.badge) {
        td.appendChild(make("span", "badge" + (r.badge ? " " + r.badge : ""), text));
      } else {
        td.textContent = text;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  show(kind.table, shown.length > 0);

  var total = logView.rows.length;
  var filtered = !!logView.search || logView.filter !== "all";
  setText(p + "emptytext", total === 0 ? "The " + kind.noun + " is empty." : "No entries match the search or filter.");
  show(p + "emptyclear", total > 0);
  show(p + "empty", shown.length === 0);
  setText(p + "summary", total === 0 ? "" : filtered ?
    rows.length + " of " + total + (total === 1 ? " entry" : " entries") + " match" :
    total + (total === 1 ? " entry" : " entries"));

  show(p + "pager", pages > 1);
  setText(p + "pagetext", rows.length ? (first + 1) + "–" + (first + shown.length) + " of " + rows.length : "");
  var prev = byId(p + "prev"), next = byId(p + "next");
  if (prev) prev.disabled = logView.page === 0;
  if (next) next.disabled = logView.page >= pages - 1;
}

// ---- save and clear ------------------------------------------------------

function saveevent() {
  file.type = "esp-rfid-eventlog";
  file.list = data;
  saveLogfile(file, "downloadEvent", "ironframe-rfid-eventlog.json");
}

function savelatest() {
  file.type = "esp-rfid-accesslog";
  file.list = data;
  saveLogfile(file, "downloadLatest", "ironframe-rfid-accesslog.json");
}

function clearevent() {
  confirmAction("Delete every entry of the event log? This cannot be undone. Download it first if you need it.", "Clear log", function() {
    // erases evidence: the admin password as well (plan 1.9.1 B1); the page
    // reloads when the device answers (transport.js)
    sendWithStepUp("clearevent", { command: "clearevent" });
  });
}

function clearlatest() {
  confirmAction("Delete every entry of the access log? This cannot be undone. Download it first if you need it.", "Clear log", function() {
    sendWithStepUp("clearlatest", { command: "clearlatest" });
  });
}

// ---- Log Settings: the logging switch --------------------------------------
// #logging is a checkbox whose value is "1" or "0": getContent (ui.js) sets
// that value from the settings when the page opens, and transport.js reads
// it when the device has stored the change, and sets it back if the device
// refused. The switch follows the value.

function syncLoggingSwitch() {
  var box = byId("logging");
  if (!box) return;
  box.checked = box.value !== "0";
  setText("loggingstate", box.checked ?
    "On: every card shown and every event is written to the reader's storage." :
    "Off: nothing new is written. The files below are kept and can still be viewed, downloaded or deleted.");
}

function setupLoggingSwitch() {
  var box = byId("logging");
  if (!box) return;
  syncLoggingSwitch();
  new MutationObserver(syncLoggingSwitch).observe(box, { attributes: true, attributeFilter: ["value"] });
}

// Applied and stored by the device at once, no restart.
function setLogging() {
  var box = byId("logging");
  hide("loggingsaved");
  if (!wsConnectionPresent) {
    box.checked = !box.checked; // as it was
    showMessage("Not changed: the reader is not connected.");
    return;
  }
  box.value = box.checked ? "1" : "0";
  // logging off hides what happens next: the admin password as well (plan 1.9.1 B1)
  sendWithStepUp("setlogging", { command: "setlogging", enabled: box.checked ? 1 : 0 }, function(message) {
    box.value = parseInt(config.general.logging) === 0 ? "0" : "1"; // as it still is
    showMessage(message);
  });
}

// ---- Log Settings: the files ------------------------------------------------

function getFileList() {
  setupLoggingSwitch();
  sendWebsocket("{\"command\":\"listfiles\", \"page\":" + page + "}");
}

// "/latestlog.json" -> what it is
function logFileInfo(name) {
  var access = name.indexOf("latestlog") >= 0, events = name.indexOf("eventlog") >= 0;
  var current = name === LOG_FILE_ACCESS || name === LOG_FILE_EVENT;
  var m = /\.json\.(split\.)?(\d+)$/.exec(name);
  var what = access ? "Access log" : events ? "Event log" : "Log file";
  var title = current ? what + " (current)" : m ? what + (m[1] ? ", split part " + m[2] : ", older file " + m[2]) : what;
  return { access: access, events: events, current: current, title: title, order: (access ? 0 : events ? 1 : 2) * 100000 + (current ? 0 : m ? (m[1] ? 50000 : 0) + Number(m[2]) : 99999) };
}

function fileSize(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + (n === 1 ? " byte" : " bytes");
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function fileAction(cls, iconName, label, handler, name, title) {
  var b = make("button", { type: "button", className: "btn small " + cls, "data-onclick": handler, "data-arg": name, title: title });
  b.appendChild(icon(iconName, "icon-sm"));
  b.appendChild(make("span", null, label));
  return b;
}

// every page of the file list has arrived (transport.js)
function initFileListTable() {
  var list = byId("filelist");
  if (!list) return;
  var files = (Array.isArray(data) ? data : []).filter(function(f) { return f && typeof f.filename === "string"; });
  files.sort(function(a, b) {
    var x = logFileInfo(a.filename).order, y = logFileInfo(b.filename).order;
    return x !== y ? x - y : a.filename < b.filename ? -1 : 1;
  });
  list.textContent = "";
  var total = 0;
  files.forEach(function(f) {
    var info = logFileInfo(f.filename);
    total += Number(f.filesize) || 0;
    var li = make("li", "logfile");
    li.appendChild(icon(info.access ? "list" : info.events ? "activity" : "file", "filekind"));
    var main = make("div", "main");
    main.appendChild(make("div", "title", info.title));
    var sub = make("div", "sub");
    sub.appendChild(make("span", "mono", f.filename));
    sub.appendChild(document.createTextNode(" · " + fileSize(f.filesize)));
    main.appendChild(sub);
    li.appendChild(main);
    var end = make("div", "end fileactions");
    if (info.access || info.events) {
      end.appendChild(fileAction("primary", "search", "View", "viewLogFile", f.filename, "Show this file's entries"));
    }
    end.appendChild(fileAction("", "archive", "Split", "splitLogFile", f.filename, "Copy into two files of half the size each"));
    if (info.current) {
      end.appendChild(fileAction("", "rotate", "New file", "rolloverLogFile", f.filename, "Start a new log: this one is kept as an older file"));
    }
    end.appendChild(fileAction("danger", "trash", "Delete", "deleteLogFile", f.filename, "Delete this file"));
    li.appendChild(end);
    list.appendChild(li);
  });
  show("filelist", files.length > 0);
  show("filesempty", files.length === 0);
  setText("filessummary", files.length ? files.length + (files.length === 1 ? " file, " : " files, ") + fileSize(total) : "");
  renderStorage();
}

// free storage, from the status the reader sent when the app opened
function renderStorage() {
  var ok = ajaxobj && ajaxobj.spiffssize > 0;
  show("logstorage", !!ok);
  if (!ok) return;
  var free = Number(ajaxobj.availspiffs) || 0, size = Number(ajaxobj.spiffssize);
  var pct = Math.max(0, Math.min(100, Math.round((free * 100) / size)));
  setText("logstoragetext", fileSize(free) + " of " + fileSize(size) + " (as last read on the Status page)");
  var bar = byId("logstoragebar");
  if (bar) bar.style.width = pct + "%";
  var meter = byId("logstoragemeter");
  if (meter) {
    meter.classList.toggle("warn", pct < 25 && pct >= 10);
    meter.classList.toggle("low", pct < 10);
  }
}

function logMaintenance(action, name) {
  sendWebsocket(JSON.stringify({ command: "logMaintenance", action: action, filename: name }));
}

function viewLogFile(name) {
  theCurrentLogFile = name;
  if (name.indexOf("latestlog") >= 0) {
    getContent("#logcontent");
  } else if (name.indexOf("eventlog") >= 0) {
    getContent("#eventcontent");
  }
}

function splitLogFile(name) {
  logMaintenance("split", name); // the list reloads when the reader has done it
}

function rolloverLogFile(name) {
  confirmAction("Start a new " + (name === LOG_FILE_ACCESS ? "access" : "event") + " log? The current one is kept as " + name +
    ".1 (older files move up one; the oldest, .3, is deleted).", "New file", function() {
    logMaintenance("rollover", name);
  });
}

function deleteLogFile(name) {
  confirmAction("Delete " + name + "? This cannot be undone.", "Delete", function() {
    logMaintenance("delete", name);
  });
}
