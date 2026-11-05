// main.js: Start-up: the menu links and the page load. Concatenated last.

// menu link id -> what it opens
var MENU_PAGES = {
  network: "#networkcontent",
  hardware: "#hardwarecontent",
  general: "#generalcontent",
  mqtt: "#mqttcontent",
  ntp: "#ntpcontent",
  users: "#userscontent",
  backup: "#backupcontent",
  logmaintenance: "#logmaintenancecontent"
};

// The settings pages: edits typed there are lost if the page is left before
// its Save (plan 1.9 C1).
var EDITABLE_PAGES = { network: 1, hardware: 1, general: 1, mqtt: 1, ntp: 1 };
var currentPage = "status";
var pageEdited = false;   // a settings page has edits its Save has not staged
var leaveTarget = null;   // the page asked for while pageEdited

// A page's Save (plan 1.9 C2): stage the page's values, then the review, so
// Save leads to saving; closing the review keeps them staged, and the bar
// below says so, for changes on more pages.
function savePage(section) {
  var fn = window["save" + section];
  if (typeof fn === "function" && fn()) {
    pageEdited = false;
    reviewChanges();
  }
}

// fromHistory: the browser's Back or Forward, already in the history
function openMenuPage(id, fromHistory) {
  if (pageEdited && id !== currentPage && EDITABLE_PAGES[currentPage] && MENU_TARGETS[id]) {
    leaveTarget = { id: id, fromHistory: !!fromHistory };
    if (fromHistory) history.pushState({ page: currentPage }, "", "#" + currentPage); // Back undone until Leave
    openDialog("leavedlg");
    return;
  }
  if (MENU_TARGETS[id]) {
    pageEdited = false;
    currentPage = id;
    if (!fromHistory && (!history.state || history.state.page !== id)) history.pushState({ page: id }, "", "#" + id);
  }
  if (id === "status") {
    sendWebsocket("{\"command\":\"status\"}"); // the answer opens the page
  } else if (id === "latestlog") {
    theCurrentLogFile = "/latestlog.json";
    getContent("#logcontent");
  } else if (id === "eventlog") {
    theCurrentLogFile = "/eventlog.json";
    getContent("#eventcontent");
  } else if (id === "reset") {
    closeMenu();
    openDialog("destroy");
  } else if (id === "updatelink") {
    closeMenu();
    openUpdate();
  } else if (id === "changepasslink") {
    closeMenu();
    showChangePassword(false);
  } else if (MENU_PAGES[id]) {
    getContent(MENU_PAGES[id]);
  }
}

// the ids that are pages (not dialogs like reset or update)
var MENU_TARGETS = { status: 1, latestlog: 1, eventlog: 1 };
Object.keys(MENU_PAGES).forEach(function(k) { MENU_TARGETS[k] = 1; });

function leaveStay() {
  leaveTarget = null;
  closeDialog("leavedlg");
}

function leaveGo() {
  var t = leaveTarget;
  leaveTarget = null;
  closeDialog("leavedlg");
  pageEdited = false;
  if (t) openMenuPage(t.id, false);
}

// typing (or a select, tick box or option) on a settings page marks it
// edited; values the page fills in fire no event. "input" only: a text
// field's "change" fires when it loses focus, which can come after its Save.
document.addEventListener("input", function(e) {
  var holder = byId("ajaxcontent");
  if (EDITABLE_PAGES[currentPage] && holder && holder.contains(e.target) && e.target.matches("input, select, textarea")) {
    pageEdited = true;
  }
}, true);

// the phone's Back button goes back a page (plan 1.9 C4)
window.addEventListener("popstate", function(e) {
  var id = e.state && e.state.page;
  if (id && MENU_TARGETS[id] && id !== currentPage) openMenuPage(id, true);
});
history.replaceState({ page: "status" }, "", "#status");

// closing the tab or reloading with edits or staged changes not saved
window.addEventListener("beforeunload", function(e) {
  var bar = document.querySelector(".footer");
  var staged = bar && !bar.hidden;
  if (!rebooting && (pageEdited || staged)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.querySelectorAll("#sidebar a.navlink[id]").forEach(function(a) {
  a.addEventListener("click", function(e) {
    e.preventDefault();
    openMenuPage(a.id);
  });
});

// a link on a page or in the tab bar: data-onclick="showPage" data-arg="<menu id>"
function showPage(id) {
  openMenuPage(id);
}

function start() {
  esprfidcontent = document.createElement("div");
  esprfidcontent.id = "mastercontent"; // holds the page <template>s
  esprfidcontent.style.display = "none";
  document.body.appendChild(esprfidcontent);
  var notice = sessionStorage.getItem("ifrfid-notice");
  if (notice) {
    sessionStorage.removeItem("ifrfid-notice");
    setText("loginnotice", notice);
    show("loginnotice");
  }
  fetch("esprfid.htm").then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function(html) {
    esprfidcontent.innerHTML = html; // our own templates, served by the device
    if (sessionToken) {
      // try the stored session first; a refused upgrade shows the login
      connectWS();
      return;
    }
    openDialog("signin", { static: true });
  }, function() {
    showMessage("The pages could not be loaded from the reader. Reload to try again.");
  });
}

document.addEventListener("touchstart", handleTouchStart, false);

document.addEventListener("touchmove", handleTouchMove, false);

// The page's controls name their handler in data-on<event> (data-arg: one
// argument, "value" for the control's value) instead of inline onclick=:
// the Content-Security-Policy (webserver.esp) runs no inline script, so an
// injected onerror= or <script> does nothing.
["click", "change", "input", "submit"].forEach(function(type) {
  document.addEventListener(type, function(e) {
    var target = e.target && e.target.closest ? e.target.closest("[data-on" + type + "]") : null;
    if (!target) {
      return;
    }
    var fn = window[target.getAttribute("data-on" + type)];
    if (typeof fn !== "function") {
      return;
    }
    if (type === "submit" || (target.tagName === "A" && target.getAttribute("href") === "#")) {
      e.preventDefault(); // the inline handlers returned false
    }
    var arg = target.getAttribute("data-arg");
    if (arg === null) {
      fn();
    } else {
      fn(arg === "value" ? target.value : (/^\d+$/.test(arg) ? Number(arg) : arg));
    }
  });
});

start(); // the last script: everything it uses is defined
