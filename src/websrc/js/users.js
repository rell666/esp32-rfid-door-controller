// users.js: Users page: the user list (rows with search, filter, sort and
// paging), the user editor (<dialog>), scan-to-enrol and delete. No library.
//
// The list is the global `data` (transport.js pages it in from the device:
// getUsers / getnextpage / builddata), then usersLoaded() draws it. The list
// changes only once the device has answered: a save through pendingEdit, a
// removal through userRemoved() (sent to every tab).

var USERS_PER_PAGE_SHOWN = 25;

// what the list shows: search text, filter, sort, page (not the global `page`,
// which is transport.js's paging of the device's list)
var usersView = { query: "", filter: "all", sort: "name", pageNo: 1, loaded: false };

var usersRemoving = {};      // uid -> true: removal sent, waiting for the device

var usersRemoveWatch = null; // notices a refused removal (transport clears pendingDelete)

var usersFlashUid = null;    // the row to highlight once (just saved, or a known card scanned)

// the editor: the user being edited (null for a new user) and the UID the
// device said exists, after the admin was warned (a second Save replaces it)
var userEditing = null;

var userReplaceUid = null;

// as core/access.h isDated(): the editor's defaults mean "no limit"
var NO_EXPIRY_FROM = 2145830400; // 2037-12-31: the editor's default end (2038-01-01) means no limit

var DATED_SINCE_FROM = CLOCK_TRUSTED_FROM; // core::DATED_SINCE_FROM, the same 2016-01-01: an earlier start means no start limit

var FAR_FUTURE = 4102444800; // 2100-01-01

// getContent("#userscontent") (ui.js) clones the page and calls this: set
// the page up once, then ask the device for the first page of the list.
function getUsers() {
  var list = byId("userlist");
  if (list && !list.hasAttribute("data-ready")) {
    list.setAttribute("data-ready", "");
    listusers();
  }
  if (backupRead) {
    backupUsersWaiting = true; // a backup is reading the list: loaded when it ends (backup.js)
    return;
  }
  sendWebsocketWithRetry("{\"command\":\"userlist\", \"page\":" + page + "}");
}

function usersPageOpen() {
  return !!byId("userlist");
}

// ---- doors and access types ------------------------------------------------

function userDoorName(i) {
  if (i === 1) {
    return config.hardware.doorname || "";
  }
  var r = config.hardware["relay" + i];
  return (r && r.doorname) || "";
}

// "Access to Front door", or "Access" with one unnamed door (as upstream)
function accessLabel(i) {
  var n = userDoorName(i);
  if (i === 1) return n ? "Access to " + n : "Access";
  return "Access to " + (n || "Relay " + i);
}

function acctypeKey(i) {
  return i === 1 ? "acctype" : "acctype" + i;
}

var ACCTYPE_TEXT = { 1: "Always", 99: "Admin", 0: "Disabled" };

function acctypeText(v) {
  var n = parseInt(v, 10);
  if (ACCTYPE_TEXT.hasOwnProperty(n)) return ACCTYPE_TEXT[n];
  return v === undefined || v === null || v === "" ? "Disabled" : "Access type " + v;
}

function acctypeBadge(v) {
  var n = parseInt(v, 10);
  return n === 1 ? "ok" : n === 99 ? "info" : n === 0 || isNaN(n) ? "bad" : "warn";
}

// The editor's access fields: one per door in use. Door 1 is in the
// template; doors 2-4 have no Admin (as upstream). hardware.js calls this
// when the number of relays changes.
function updateUserModalForm() {
  var holder = byId("useraccess");
  if (!holder) {
    return; // the Users page is not open; it builds them when it opens
  }
  // the filter names door 1 when there are more
  var d1 = numRelays > 1 ? (userDoorName(1) || "Door 1") : "Access";
  var filter = byId("userfilter");
  ["1", "99", "0"].forEach(function(v) {
    var o = filter && filter.querySelector("option[value='" + v + "']");
    if (o) o.textContent = d1 + ": " + ACCTYPE_TEXT[v];
  });
  var first = byId("useracctype");
  first.querySelector("label .ltext").textContent = accessLabel(1);
  for (var i = 2; i <= maxNumRelays; i++) {
    var existing = byId("useracctype" + i);
    if (i > numRelays) {
      if (existing) holder.removeChild(existing);
      continue;
    }
    if (!existing) {
      existing = make("div", { className: "field", id: "useracctype" + i });
      existing.appendChild(make("label", { "for": "acctype" + i, className: "reqd" }));
      var sel = make("select", { id: "acctype" + i, required: "" });
      sel.appendChild(make("option", { value: "1" }, "Always"));
      sel.appendChild(make("option", { value: "0" }, "Disabled"));
      existing.appendChild(sel);
      holder.appendChild(existing);
    }
    var lab = existing.querySelector("label");
    lab.textContent = "";
    lab.appendChild(make("span", "ltext", accessLabel(i)));
  }
  if (usersView.loaded) renderUsers();
}

// ---- validity ----------------------------------------------------------------

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

// {text, kind, out}: the validity of a user, for the list. As the device
// decides (core/access.h): refused after valid until or before valid since.
function validityOf(u) {
  var since = Number(u.validsince) || 0, until = Number(u.validuntil) || 0, now = nowEpoch();
  // the editor's default end (2038-01-01) and the far future mean no end date
  var hasStart = since >= DATED_SINCE_FROM;
  var hasEnd = until < NO_EXPIRY_FROM || (until < FAR_FUTURE && localDay(until) !== "2038-01-01");
  if (until < now) return { text: "Expired " + localDay(until), kind: "bad", out: true };
  if (since > now) return { text: "From " + localDay(since) + (hasEnd ? " to " + localDay(until) : ""), kind: "warn", out: true };
  if (hasStart && hasEnd) return { text: localDay(since) + " to " + localDay(until), kind: "", out: false };
  if (hasEnd) return { text: "Until " + localDay(until), kind: "", out: false };
  return { text: hasStart ? "Since " + localDay(since) : "No time limit", kind: "", out: false };
}

function userHasPin(u) {
  return u.haspin === true || u.haspin === "true";
}

function findUser(uid) {
  for (var i = 0; i < data.length; i++) {
    if (data[i] && data[i].uid === uid) return data[i];
  }
  return null;
}

// ---- the list ----------------------------------------------------------------

function userMatches(u, q, filter) {
  if (q) {
    var name = String(u.username || "").toLowerCase(), uid = String(u.uid || "").toLowerCase();
    if (name.indexOf(q) < 0 && uid.indexOf(q) < 0) return false;
  }
  if (filter === "pin") return userHasPin(u);
  if (filter === "expired") return validityOf(u).out;
  if (filter !== "all") return String(parseInt(u.acctype, 10)) === filter;
  return true;
}

function sortUsers(list, by) {
  var key = function(u) {
    if (by === "uid") return String(u.uid || "");
    if (by === "until") return Number(u.validuntil) || 0;
    return String(u.username || "").toLowerCase();
  };
  return list.slice().sort(function(a, b) {
    var x = key(a), y = key(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return String(a.uid).localeCompare(String(b.uid));
  });
}

function initialsOf(name) {
  var words = String(name || "").trim().split(/\s+/).filter(function(w) { return /[0-9A-Za-zÀ-￿]/.test(w); });
  if (!words.length) return "?";
  var pick = function(w) { var m = w.match(/[0-9A-Za-zÀ-￿]/); return m ? m[0] : ""; };
  return (pick(words[0]) + (words.length > 1 ? pick(words[words.length - 1]) : "")).toUpperCase();
}

function userRow(u) {
  var li = make("li", { className: "tappable urow", tabindex: "0", role: "button", "data-uid": u.uid });
  var v = validityOf(u);
  var acc = parseInt(u.acctype, 10);
  var removing = !!usersRemoving[u.uid];
  li.setAttribute("aria-label", (u.username || u.uid) + ", UID " + u.uid + (removing ? ", being removed" : ""));
  if (removing) li.classList.add("removing");
  if (v.out || acc === 0) li.classList.add("inactive");
  if (u.uid === usersFlashUid) li.classList.add("flash");

  li.appendChild(make("span", "uavatar" + (acc === 99 ? " admin" : acc === 0 ? " off" : ""), initialsOf(u.username)));
  var main = make("div", "main");
  var title = make("div", "title utitle");
  title.appendChild(make("span", "uname", u.username === "" || u.username === undefined ? "(no name)" : String(u.username)));
  main.appendChild(title);
  main.appendChild(make("div", "sub mono uuid", String(u.uid)));
  var tags = make("div", "utags");
  for (var i = 1; i <= numRelays; i++) {
    var val = u[acctypeKey(i)];
    var label = numRelays > 1 ? (userDoorName(i) || (i === 1 ? "Door 1" : "Relay " + i)) + ": " + acctypeText(val) : acctypeText(val);
    tags.appendChild(make("span", "badge " + acctypeBadge(val), label));
  }
  tags.appendChild(make("span", v.kind ? "badge " + v.kind : "badge", v.text));
  if (userHasPin(u)) {
    var pin = make("span", "badge pinbadge");
    pin.appendChild(icon("key", "icon-xs"));
    pin.appendChild(document.createTextNode("PIN set"));
    tags.appendChild(pin);
  }
  if (removing) tags.appendChild(make("span", "badge warn", "Removing..."));
  main.appendChild(tags);
  li.appendChild(main);
  var end = make("div", "end");
  end.appendChild(icon("chevron", "muted"));
  li.appendChild(end);
  return li;
}

function usersShown() {
  var q = usersView.query.trim().toLowerCase();
  return sortUsers(data.filter(function(u) { return u && userMatches(u, q, usersView.filter); }), usersView.sort);
}

function renderUsers() {
  var list = byId("userlist");
  if (!list || !usersView.loaded) return; // usersLoaded() draws it once complete
  var shown = usersShown();
  var pages = Math.max(1, Math.ceil(shown.length / USERS_PER_PAGE_SHOWN));
  // a flashed row (just saved, or scanned) is shown on its page
  if (usersFlashUid) {
    for (var f = 0; f < shown.length; f++) {
      if (shown[f].uid === usersFlashUid) { usersView.pageNo = Math.floor(f / USERS_PER_PAGE_SHOWN) + 1; break; }
    }
  }
  usersView.pageNo = Math.min(Math.max(1, usersView.pageNo), pages);
  var start = (usersView.pageNo - 1) * USERS_PER_PAGE_SHOWN;
  var frag = document.createDocumentFragment();
  shown.slice(start, start + USERS_PER_PAGE_SHOWN).forEach(function(u) { frag.appendChild(userRow(u)); });
  list.textContent = "";
  list.appendChild(frag);
  usersFlashUid = null;

  var total = data.length;
  var filtered = usersView.query.trim() !== "" || usersView.filter !== "all";
  setText("usercount", total === 0 ? "" : filtered ? shown.length + " of " + total + (total === 1 ? " user" : " users") : total + (total === 1 ? " user" : " users"));
  show("usercount", total > 0);

  var empty = byId("usersempty");
  empty.textContent = "";
  if (total === 0) {
    empty.appendChild(icon("users", "emptyicon"));
    empty.appendChild(make("p", "emptytitle", "No users yet"));
    empty.appendChild(make("p", null, "Hold a card to the reader to add it, or press New user."));
  } else if (shown.length === 0) {
    empty.appendChild(make("p", "emptytitle", "No users match"));
    var clear = make("button", { type: "button", className: "btn small" }, "Clear search and filter");
    clear.addEventListener("click", clearUserSearch);
    empty.appendChild(clear);
  }
  show(empty, shown.length === 0);
  show(list, shown.length > 0);

  show("userpager", pages > 1);
  setText("userpageinfo", shown.length ? (start + 1) + "–" + Math.min(start + USERS_PER_PAGE_SHOWN, shown.length) + " of " + shown.length : "");
  byId("userprev").disabled = usersView.pageNo <= 1;
  byId("usernext").disabled = usersView.pageNo >= pages;
}

function clearUserSearch() {
  usersView.query = "";
  usersView.filter = "all";
  usersView.pageNo = 1;
  byId("usersearch").value = "";
  byId("userfilter").value = "all";
  renderUsers();
}

function userSearchFor(text) {
  usersView.query = text;
  usersView.pageNo = 1;
  byId("usersearch").value = text;
  renderUsers();
}

// transport.js: every page of the list has arrived (or the list is empty)
function usersLoaded() {
  if (!usersPageOpen()) return;
  var loading = byId("loading-img");
  if (loading) loading.style.display = "none";
  usersView.loaded = true;
  renderUsers();
}

// transport.js: the device removed this user (asked here or in another tab)
function userRemoved(uid) {
  delete usersRemoving[uid];
  if (!usersPageOpen()) return;
  data = data.filter(function(u) { return !u || u.uid !== uid; });
  if (userEditing && userEditing.uid === uid && isDialogOpen("editor-modal")) {
    // removed in another tab while open here: a save now adds the user again
    userEditing = null;
    show("deleteuserbtn", false);
    showEditorNote("This user has just been removed from the reader (perhaps in another tab). Save adds them again as a new user.", "warning");
  }
  renderUsers();
}

// A refused removal: transport.js clears pendingDelete and shows the
// device's reason; the row loses its "Removing..." mark.
function watchRemoval(uid) {
  clearInterval(usersRemoveWatch);
  usersRemoveWatch = setInterval(function() {
    if (!usersPageOpen()) {
      clearInterval(usersRemoveWatch);
      usersRemoveWatch = null;
      return;
    }
    if (pendingDelete && pendingDelete.value.uid === uid) return;
    clearInterval(usersRemoveWatch);
    usersRemoveWatch = null;
    if (usersRemoving[uid] && findUser(uid)) {
      delete usersRemoving[uid]; // refused, or never answered for this tab
      renderUsers();
    }
  }, 300);
}

function deleteUser(u) {
  confirmAction("Remove " + u.uid + " (" + u.username + ") from the reader? This cannot be undone.", "Remove", function() {
    closeDialog("editor-modal");
    pendingDelete = { value: { uid: u.uid, username: u.username } }; // leaves the list when the device confirms
    usersRemoving[u.uid] = true;
    renderUsers();
    watchRemoval(u.uid);
    sendWithStepUp("remove", { uid: u.uid, command: "remove" }, function(message) {
      pendingDelete = null; // not sent: the row stays
      delete usersRemoving[u.uid];
      renderUsers();
      showMessage(message);
    });
  });
}

// A card held to the reader (the device broadcasts "piccscan"): only while
// Users is open. An unknown card opens New user with its UID; a known one
// finds its user. With the editor open, an unknown card fills in the UID.
function listSCAN(obj) {
  if (!usersPageOpen()) return;
  var uid = String(obj.uid || "").toLowerCase();
  if (!uid) return;
  if (isDialogOpen("editor-modal")) {
    if (pendingEdit) return; // saving: leave the form as it is
    if (obj.known === 1) {
      showEditorNote("Card " + uid + " already belongs to " + (obj.user || "a user") + ".", "warning");
      return;
    }
    var field = byId("uid");
    field.value = uid;
    setPiccType(obj.type);
    uidChanged();
    showEditorNote("Card " + uid + " scanned: its UID is filled in.", "info");
    return;
  }
  if (obj.known === 1) {
    usersFlashUid = findUser(uid) ? uid : null;
    usersView.filter = "all";
    byId("userfilter").value = "all";
    userSearchFor(uid);
  } else {
    scannedCard = obj;
    newUser();
  }
}

// ---- the editor ------------------------------------------------------------

function showEditorError(text) {
  setText("editorerror", text);
  show("editorerror", !!text);
}

function showEditorNote(text, kind) {
  var n = byId("editornote");
  if (!n) return;
  n.className = "banner " + (kind || "info");
  n.textContent = text || "";
  show(n, !!text);
  if (text) n.parentNode.scrollTop = 0; // the note is at the top of the form
}

function setPiccType(type) {
  var has = type !== undefined && type !== null && type !== "";
  byId("picctype").value = has ? String(type) : "";
  show("picctyperow", has);
}

function setSaveButton(text, disabled) {
  var b = byId("saveuserbtn");
  b.textContent = text;
  b.disabled = !!disabled;
  byId("deleteuserbtn").disabled = !!disabled; // not while a save waits
}

// The PIN field: a stored PIN is never shown, only that there is one (it can
// be kept, replaced or removed).
function showPinState(hasPin) {
  var pin = byId("pincode");
  pin.value = ""; // never sent by the device
  pin.disabled = false;
  pin.placeholder = hasPin ? "PIN set: leave empty to keep it" : "Pin code";
  byId("removepin").checked = false;
  show("removepinrow", hasPin);
}

function removePinChanged() {
  var pin = byId("pincode");
  var removing = byId("removepin").checked;
  if (removing) pin.value = "";
  pin.disabled = removing;
  pin.placeholder = removing ? "The PIN is removed on save" : "PIN set: leave empty to keep it";
}

// UIDs are stored in lower case (every reader reports lower-case hex). A UID
// changed after the device's "exists" warning clears that warning.
function uidChanged() {
  var f = byId("uid");
  var lower = f.value.toLowerCase();
  if (lower !== f.value) {
    var at = f.selectionStart;
    f.value = lower;
    try { f.setSelectionRange(at, at); } catch (e) {}
  }
  if (userReplaceUid !== null && lower !== userReplaceUid) {
    userReplaceUid = null;
    setSaveButton("Save changes", !!pendingEdit);
    showEditorError("");
  }
  // this page's list (it may be stale: the device decides on Save)
  var other = lower && findUser(lower);
  var clash = other && (!userEditing || userEditing.uid !== lower);
  setText("uidclash", clash ? "This UID already belongs to " + (other.username || "another user") + ". Save asks before replacing them." : "");
  show("uidclash", !!clash);
}

function datesChanged() {
  var since = byId("validsince").value, until = byId("validuntil").value;
  show("datewarn", !!(since && until && until < since));
}

function resetEditor() {
  byId("editor").reset();
  userReplaceUid = null;
  showEditorError("");
  showEditorNote("");
  show("uidclash", false);
  show("datewarn", false);
  setPiccType("");
  setSaveButton("Save changes", false);
  updateUserModalForm();
  document.querySelectorAll("#useraccess option[data-extra]").forEach(function(o) { o.remove(); });
}

function newUser() {
  if (!usersPageOpen()) return;
  userEditing = null; // a New user after an Edit must not count as editing that user
  resetEditor();
  showPinState(false);
  show("deleteuserbtn", false);
  setText("editor-title", "New user");
  if (scannedCard) { // opened by an unknown card: its UID and type, used once
    byId("uid").value = String(scannedCard.uid).toLowerCase();
    setPiccType(scannedCard.type);
    showEditorNote("New card scanned at the reader: its UID is filled in.", "info");
    scannedCard = null;
    uidChanged();
  }
  openDialog("editor-modal", { static: false });
  if (byId("uid").value) byId("username").focus();
}

// The editor closes on a backdrop tap or Escape only while nothing has been
// typed: a stray tap lost a half-entered user (review 8 R4-22).
function editorDirty() {
  byId("editor-modal").setAttribute("data-static", "");
}

function editUser(uid) {
  var u = findUser(uid);
  if (!u || usersRemoving[uid]) return;
  userEditing = u;
  resetEditor();
  // lower case, as the device stores it (a record saved before 1.4.0 in
  // upper case moves to the lower-case UID on save)
  byId("uid").value = String(u.uid).toLowerCase();
  byId("username").value = u.username === undefined || u.username === null ? "" : String(u.username);
  showPinState(userHasPin(u));
  for (var i = 1; i <= numRelays; i++) {
    var sel = byId(acctypeKey(i));
    var v = u[acctypeKey(i)];
    var n = parseInt(v, 10);
    if (isNaN(n)) n = 0;
    if (!sel.querySelector("option[value='" + n + "']")) {
      // an access type this page has no name for: kept as it is
      sel.appendChild(make("option", { value: String(n), "data-extra": "" }, "Access type " + n));
    }
    sel.value = String(n);
  }
  byId("validsince").value = u.validsince ? localDay(u.validsince) : "1970-01-01";
  byId("validuntil").value = localDay(Number(u.validuntil) || 0);
  datesChanged();
  show("deleteuserbtn", true);
  setText("editor-title", "Edit " + (u.username || u.uid));
  openDialog("editor-modal", { static: false });
  byId("editor-title").focus(); // not the UID: no keyboard popping up on a phone
}

// Save: one "userfile" command; the list changes only once the device has
// stored the user (as Delete waits for "remove"). On a refusal the dialog
// stays open with the device's reason and the list keeps what the device holds.
function saveUser(e) {
  e.preventDefault();
  var form = byId("editor");
  if (form.checkValidity && !form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if (pendingEdit) {
    // one save at a time (an earlier one, from a closed editor, may still wait)
    if (byId("saveuserbtn").textContent !== "Saving...") {
      showEditorError("The reader has not answered the last save yet. Try again in a moment.");
    }
    return;
  }
  var editing = userEditing;
  var oldUid = editing ? editing.uid : null;
  var datatosend = {};
  datatosend.command = "userfile";
  datatosend.uid = byId("uid").value.toLowerCase();
  datatosend.pincode = byId("pincode").value;
  // an empty PIN on a user who has one keeps it, unless Remove is ticked
  if (datatosend.pincode === "" && oldUid && userHasPin(editing) && !byId("removepin").checked) {
    datatosend.keeppin = 1;
  }
  // a keypad-only user (its PIN is also its UID) is found by the digits
  // alone, so it needs at least 6 (2026-10-19, plan 1.9 D4); a card's
  // PIN stays 4-12, and a stored shorter one keeps working until changed
  if (datatosend.pincode !== "" && datatosend.pincode === datatosend.uid && datatosend.pincode.length < 6) {
    showEditorError("A keypad-only user's PIN (also its UID) must be at least 6 digits.");
    byId("pincode").focus();
    return;
  }
  datatosend.user = byId("username").value;
  for (var i = 1; i <= maxNumRelays; i++) {
    var sel = byId(acctypeKey(i));
    // a door not in use keeps what the user had there (0 for a new user)
    datatosend[acctypeKey(i)] = i <= numRelays && sel ? parseInt(sel.value, 10) : (editing ? (parseInt(editing[acctypeKey(i)], 10) || 0) : 0);
  }
  datatosend.validsince = dayEpoch(byId("validsince").value, false);
  datatosend.validuntil = dayEpoch(byId("validuntil").value, true);
  // a changed UID: the device stores the new record and removes the old one
  // in this one command, or changes nothing (a separate "remove" after the
  // save left the old card valid if the link dropped between)
  var renamedFrom = oldUid && oldUid !== datatosend.uid ? oldUid : null;
  if (renamedFrom) {
    datatosend.replaces = renamedFrom;
  }
  // a new user or a changed UID must not replace someone else's record
  // unannounced: the device refuses if the UID exists (this page's list may
  // be stale), and a second Save after the warning replaces it
  var replacing = userReplaceUid === datatosend.uid;
  if ((!oldUid || renamedFrom) && !replacing) {
    datatosend.create = 1;
  }
  var values = {
    uid: datatosend.uid,
    username: datatosend.user,
    acctype: datatosend.acctype,
    acctype2: datatosend.acctype2,
    acctype3: datatosend.acctype3,
    acctype4: datatosend.acctype4,
    validsince: datatosend.validsince,
    validuntil: datatosend.validuntil,
    haspin: datatosend.pincode !== "" || datatosend.keeppin === 1
  };
  var editTimer = null;
  var thisEdit = pendingEdit = function(ok, message, unsure) {
    clearTimeout(editTimer);
    if (!document.contains(form)) {
      return; // the page was left meanwhile; it reloads the list when opened
    }
    var open = isDialogOpen("editor-modal");
    setSaveButton("Save changes", false);
    var problem = null;
    if (unsure) {
      problem = message; // no answer: the user may or may not be stored
    } else if (!ok && message === "A user with this UID already exists") {
      userReplaceUid = datatosend.uid;
      problem = "Not saved: UID " + datatosend.uid + " already belongs to another user. Save again to replace that user, or change the UID.";
      setSaveButton("Replace user", false);
    } else if (!ok) {
      problem = "Not saved: " + (message || "the device refused the user");
    }
    if (problem) {
      showEditorError(problem);
      if (!open) showMessage(problem); // the dialog was closed while saving
      return;
    }
    userReplaceUid = null;
    // the replaced user (same UID) and, after a UID change, the old record
    data = data.filter(function(u) { return u && u.uid !== values.uid && (!renamedFrom || u.uid !== renamedFrom); });
    data.push(values);
    usersFlashUid = values.uid;
    if (!userMatches(values, usersView.query.trim().toLowerCase(), usersView.filter)) {
      // the saved user would be hidden by the search or filter: show it
      usersView.query = "";
      usersView.filter = "all";
      byId("usersearch").value = "";
      byId("userfilter").value = "all";
    }
    if (userEditing === editing) userEditing = null;
    closeDialog("editor-modal");
    renderUsers();
    showMessage((editing ? "Saved " : "Added ") + (values.username || values.uid) + ".", "success");
  };
  showEditorError("");
  setSaveButton("Saving...", true);
  editTimer = setTimeout(function() {
    if (pendingEdit === thisEdit) {
      failPendingEdit("The device did not answer, so the user may not be saved. Check the user list, then save again.");
    }
  }, USER_SAVE_TIMEOUT_MS);
  // a new user, a replaced one, admin access or a PIN set or removed: the
  // admin password as well (the device decides, core::userFileNeedsStepUp,
  // plan 1.9.1 B1); a name, dates or role on a stored user does not ask
  var admin = [1, 2, 3, 4].some(function(i) { return datatosend[acctypeKey(i)] === 99; });
  var pinChange = datatosend.pincode !== "" || (!!oldUid && userHasPin(editing) && datatosend.keeppin !== 1);
  if (datatosend.create === 1 || replacing || admin || pinChange) {
    withStepUp("userfile", function(step) {
      sendWebsocket(JSON.stringify(Object.assign({}, datatosend, step)));
    }, function(message) {
      if (pendingEdit !== thisEdit) return;
      clearTimeout(editTimer);
      pendingEdit = null;
      thisEdit(false, message);
    });
    return;
  }
  sendWebsocket(JSON.stringify(datatosend));
}

// ---- the page --------------------------------------------------------------

function rowUid(e) {
  var li = e.target.closest && e.target.closest("li.urow");
  return li ? li.getAttribute("data-uid") : null;
}

function bindUsersPage() {
  byId("usersearch").addEventListener("input", function() {
    usersView.query = this.value;
    usersView.pageNo = 1;
    renderUsers();
  });
  byId("userfilter").addEventListener("change", function() {
    usersView.filter = this.value;
    usersView.pageNo = 1;
    renderUsers();
  });
  byId("usersort").addEventListener("change", function() {
    usersView.sort = this.value;
    usersView.pageNo = 1;
    renderUsers();
  });
  var turn = function(by) {
    usersView.pageNo += by;
    renderUsers();
    var card = document.querySelector(".ulistcard");
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
  };
  byId("userprev").addEventListener("click", function() { turn(-1); });
  byId("usernext").addEventListener("click", function() { turn(1); });
  var list = byId("userlist");
  list.addEventListener("click", function(e) {
    var uid = rowUid(e);
    if (uid !== null) editUser(uid);
  });
  list.addEventListener("keydown", function(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var uid = rowUid(e);
    if (uid !== null) {
      e.preventDefault();
      editUser(uid);
    }
  });
  byId("editor").addEventListener("submit", saveUser);
  byId("uid").addEventListener("input", uidChanged);
  byId("removepin").addEventListener("change", removePinChanged);
  byId("validsince").addEventListener("input", datesChanged);
  byId("validuntil").addEventListener("input", datesChanged);
  byId("validsince").addEventListener("change", datesChanged);
  byId("validuntil").addEventListener("change", datesChanged);
  byId("deleteuserbtn").addEventListener("click", function() {
    if (userEditing && !pendingEdit) deleteUser(userEditing);
  });
}

// The page has just been put in place (getUsers): bind the controls.
function listusers() {
  usersView = { query: "", filter: "all", sort: usersView.sort, pageNo: 1, loaded: false };
  usersRemoving = {};
  userEditing = null;
  userReplaceUid = null;
  scannedCard = null;
  byId("usersort").value = usersView.sort;
  bindUsersPage();
  updateUserModalForm();
}
