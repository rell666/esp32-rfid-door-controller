// backup.js: Backup & Restore, Restart, Factory Reset and firmware Update.

// ---- backup ------------------------------------------------------------------

// the backup page's "working" line (#loading-img: transport.js hides it if
// the reader stops answering)
function backupBusy(text) {
  var busy = byId("loading-img");
  if (!busy || !byId("bkbusytext")) return;
  setText("bkbusytext", text);
  busy.style.display = text ? "" : "none";
}

// A backup file for the browser to save. The answer can come after the
// page was left (the user list is read page by page, the settings within
// 10 s): the file is still saved, through a link made for it.
function saveBackupFile(obj, anchorId, filename) {
  var temp = null;
  if (!byId(anchorId)) {
    temp = make("a", { id: anchorId, hidden: "" });
    document.body.appendChild(temp);
  }
  saveLogfile(obj, anchorId, filename);
  if (temp) temp.remove();
}

// Backup Users reads the user list into its own rows, with its own page count
// and retries (backupRead, state.js): another list page opened meanwhile
// used the shared ones, so its rows went into the file. The Users page
// waits for the backup (users.js getUsers): the device's answers do not
// say which request they answer.
function backupuser() {
  if (backupRead) return; // already reading
  if (!wsConnectionPresent) {
    showMessage("Not backed up: the reader is not connected.");
    return;
  }
  backupRead = { page: 1, received: 0, list: [], tries: 0, timer: null, message: "" };
  backupBusy("Reading the users from the reader…");
  requestBackupPage();
}

function requestBackupPage() {
  clearTimeout(backupRead.timer);
  // the user list carries PINs for a backup only
  backupRead.message = JSON.stringify({ command: "userlist", page: backupRead.page, backup: 1 });
  backupRead.tries = 0;
  sendWebsocket(backupRead.message);
  backupRead.timer = setTimeout(retryBackupPage, REQUEST_TIMEOUT_MS);
}

function retryBackupPage() {
  if (!backupRead) return;
  if (backupRead.tries >= 3) {
    backupFailed("Not backed up: the reader did not answer.");
    return;
  }
  backupRead.tries++;
  sendWebsocket(backupRead.message);
  backupRead.timer = setTimeout(retryBackupPage, REQUEST_TIMEOUT_MS);
}

// a page of the user list for the backup (transport.js)
function backupPageReceived(obj) {
  if (obj.page !== backupRead.page || backupRead.received === obj.page) return; // stale or duplicate
  backupRead.received = obj.page;
  backupRead.haspages = obj.haspages;
  backupRead.list = backupRead.list.concat(Array.isArray(obj.list) ? obj.list : []);
}

// the device's result for that page: the next page, or the file
function backupPageResult(ok) {
  if (!ok) {
    backupFailed("Not backed up: the reader could not send the user list.");
    return;
  }
  if (backupRead.received !== backupRead.page) return; // a result of a page already handled
  if (backupRead.page < backupRead.haspages) {
    backupRead.page++;
    requestBackupPage();
    return;
  }
  // every page, or none: a reader with no users gets an empty backup file
  var list = backupRead.list;
  backupDone();
  piccBackup({ type: "esp-rfid-userbackup", version: "v0.6", list: list });
}

function backupFailed(message) {
  backupDone();
  showMessage(message);
}

// the backup is over: a Users page opened meanwhile loads now
function backupDone() {
  clearTimeout(backupRead.timer);
  backupRead = null;
  backupBusy("");
  var waiting = backupUsersWaiting;
  backupUsersWaiting = false;
  if (waiting && usersPageOpen()) {
    page = 1;
    data = [];
    getUsers();
  }
}

// Backup Settings saves what the device has stored (getconf), not the page's
// copy: that holds staged, unsaved edits, so a backup taken mid-edit was not
// what the device was running. The reply is routed here by configfile in
// transport.js while settingsBackupTimer is set.
var SETTINGS_BACKUP_TIMEOUT_MS = 10000;
var settingsBackupTimer = null;

function backupset() {
  if (settingsBackupTimer) return; // already asked
  if (!wsConnectionPresent) {
    showMessage("Not backed up: the reader is not connected.");
    return;
  }
  if (byId("backupsetbtn")) byId("backupsetbtn").disabled = true;
  settingsBackupTimer = setTimeout(function() {
    settingsBackupTimer = null;
    if (byId("backupsetbtn")) byId("backupsetbtn").disabled = false;
    // a device with no saved settings sends nothing
    showMessage("Not backed up: the reader sent no settings (it has none saved yet, or did not answer).");
  }, SETTINGS_BACKUP_TIMEOUT_MS);
  sendWebsocket(JSON.stringify({ command: "getconf" }));
}

function settingsBackupReceived(obj) {
  clearTimeout(settingsBackupTimer);
  settingsBackupTimer = null;
  if (byId("backupsetbtn")) byId("backupsetbtn").disabled = false;
  saveBackupFile(obj, "downloadSet", "ironframe-rfid-settings.json");
  if (savedConfig && configChanges(savedConfig, config).length > 0) {
    showMessage("The backup holds the settings saved on the device, not your unsaved changes. To back those up, Save & Reboot first, then back up again.", "warning");
  } else {
    showMessage("Settings backed up to ironframe-rfid-settings.json.", "success");
  }
}

// every page of the user list has arrived (transport.js)
function piccBackup(obj) {
  saveBackupFile(obj, "downloadUser", "ironframe-rfid-users.json");
  var n = obj && Array.isArray(obj.list) ? obj.list.length : 0;
  if (byId("backupuserbtn")) {
    showMessage(n + (n === 1 ? " user" : " users") + " backed up to ironframe-rfid-users.json.", "success");
  }
}

// ---- restore -----------------------------------------------------------------

// the Restore buttons open their hidden file input
function pickBackupFile(id) {
  var input = byId(id);
  if (input) input.click();
}

// the chosen file's text, then the input is emptied (choosing the same file
// again fires onchange again)
function readBackupFile(id, onText) {
  var input = byId(id);
  if (!input || !("files" in input)) return;
  if (input.files.length === 0) {
    showMessage("No file selected to restore.");
    return;
  }
  var reader = new FileReader();
  reader.onload = function() { onText(String(reader.result)); };
  reader.onerror = function() { showMessage("Not restored: the file could not be read."); };
  reader.readAsText(input.files[0]);
  input.value = "";
}

function restoreSet() {
  readBackupFile("restoreSet", function(text) {
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      showMessage("Not restored: this file is not a valid settings backup (not JSON).");
      return;
    }
    if (!json || json.command !== "configfile") {
      // was silently ignored: nothing happened and nothing was said
      showMessage(json && json.type === "esp-rfid-userbackup" ?
        "Not restored: this is a user backup. Use Restore users for it." :
        "Not restored: this file is not an Ironframe RFID settings backup (it has no \"command\": \"configfile\").");
      return;
    }
    var masked = ["network", "mqtt"].filter(function(k) { return json[k] && json[k].pswd === "********"; });
    var note = masked.length === 0 ? "" : " This backup does not contain the " + masked.join(" and ") + " password(s) (backups never include passwords). " +
        "On this same device they are kept; on a different or reset device, enter them again before saving.";
    confirmAction("Stage the settings from this backup? Review them, then Save & Reboot." + note, "Restore", function() {
      config = json;
      if (isObj(json.hardware) && json.hardware.numrelays) {
        numRelays = clampRelays(jsonInt(json.hardware.numrelays, 1));
      }
      markUnsaved();
      showMessage("The settings from the backup are staged. Review them in the bar below, then Save & Reboot.", "info");
    });
  });
}

function restoreUser() {
  readBackupFile("restoreUser", function(text) {
    var json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      showMessage("Not restored: this file is not a valid user backup (not JSON).");
      return;
    }
    if (!json || json.type !== "esp-rfid-userbackup" || !Array.isArray(json.list)) {
      showMessage(json && json.command === "configfile" ?
        "Not restored: this is a settings backup. Use Restore settings for it." :
        "Not restored: this file is not an Ironframe RFID user backup.");
      return;
    }
    if (json.list.length === 0) {
      // restore1by1 read past the end of an empty list
      showMessage("This backup holds no users: there is nothing to restore.", "warning");
      return;
    }
    confirmAction("Restore " + json.list.length + (json.list.length === 1 ? " user" : " users") + " from this backup? Users with the same UID are replaced.", "Restore", function() {
      if (!wsConnectionPresent) {
        showMessage("Not restored: the reader is not connected.");
        return;
      }
      recordstorestore = json.list.length;
      data = json.list;
      restorestarted = true;
      slot = 0;
      restoreSkipped = [];
      showRestoreSkipped();
      setText("restoretitle", "Restoring users…");
      setText("restorenote", "Keep this page open until the restore has finished.");
      hide("restoreclose");
      hide("restoreusers");
      var bar = byId("dynamic");
      bar.className = "bar busy";
      bar.style.width = "0%";
      openDialog("restoremodal", { static: true });
      restore1by1(slot, recordstorestore, data);
    });
  });
}

function restore1by1(i, len, data) {
  var part = 100 / len;
  var bar = document.getElementById("dynamic");
  if (bar) {
    bar.style.width = part * (i + 1) + "%";
    bar.setAttribute("aria-valuenow", Math.round(part * (i + 1)));
  }
  setText("restorestate", "Restoring user " + (i + 1) + " of " + len + "…");
  var datatosend = {};
  datatosend.command = "userfile";
  datatosend.uid = data[i].uid;
  datatosend.pincode = data[i].pincode;
  datatosend.user = data[i].username;
  datatosend.acctype = data[i].acctype;
  for (var r = 2; r <= maxNumRelays; r++) {
    if (data[i].hasOwnProperty("acctype" + r)) {
      datatosend["acctype" + r] = data[i]["acctype" + r];
    }
  }
  datatosend.validsince = data[i].validsince;
  datatosend.validuntil = data[i].validuntil;
  slot++;
  // a restore adds users and PINs: the admin password as well (plan 1.9.1
  // B1), one challenge per user
  withStepUp("userfile", function(step) {
    sendWebsocketWithRetry(JSON.stringify(Object.assign(datatosend, step)));
  }, function(message) { finishRestore(false, message); });
}

// The device accepted the user just sent: the next one, or the end.
function restoreNext() {
  if (slot < recordstorestore) {
    restore1by1(slot, recordstorestore, data);
  } else {
    finishRestore(true);
  }
}

// The device refused the user just sent as invalid (core/userrecord.h):
// note it and go on with the next one.
function restoreSkip(why) {
  var u = data[slot - 1] || {};
  restoreSkipped.push({ uid: String(u.uid), name: u.username ? String(u.username) : "", why: why });
  restoreNext();
}

// The users the device refused, each with its reason, under the progress bar:
// a backup must never look fully restored when it was not.
function showRestoreSkipped() {
  var list = document.getElementById("restoreskipped");
  if (!list) return;
  list.textContent = "";
  show(list, restoreSkipped.length > 0);
  if (!restoreSkipped.length) return;
  list.appendChild(icon("alert"));
  var body = make("div", "skippedbody");
  body.appendChild(make("p", null, restoreSkipped.length + (restoreSkipped.length === 1 ? " user was" : " users were") +
    " not restored. Fix them in the backup file, or add them on the Users page:"));
  var ul = make("ul", "skippedlist");
  restoreSkipped.forEach(function(s) {
    ul.appendChild(make("li", null, s.uid + (s.name ? " (" + s.name + ")" : "") + ": " + s.why));
  });
  body.appendChild(ul);
  list.appendChild(body);
}

// The end of a user restore: ok, or stopped (the device's message, or no
// answer). Also called by transport.js when the device stops answering.
function finishRestore(ok, message) {
  var bar = document.getElementById("dynamic");
  var skipped = restoreSkipped.length;
  var sent = ok ? recordstorestore : Math.max(0, slot - 1);
  var restored = Math.max(0, sent - skipped);
  if (bar) {
    bar.className = "bar " + (!ok ? "danger" : skipped ? "warning" : "ok");
    if (ok) bar.style.width = "100%";
  }
  // the device's message: text, never markup
  setText("restorestate", !ok ? (message || "Restore failed") :
    skipped ? "Completed: " + restored + " restored, " + skipped + " skipped" :
    "Completed: " + restored + (restored === 1 ? " user" : " users") + " restored");
  setText("restoretitle", !ok ? "Restore stopped" : skipped ? "Restore finished, with users skipped" : "Users restored");
  setText("restorenote", !ok ? restored + " of " + recordstorestore + " users were restored before it stopped. You can restore the same file again: users already restored are replaced, not doubled." : "");
  show("restorenote", !ok);
  showRestoreSkipped();
  restorestarted = false;
  slot = 0;
  recordstorestore = 0;
  var dlg = byId("restoremodal");
  if (dlg) dlg.removeAttribute("data-static"); // Escape and the backdrop close it now
  show("restoreclose");
  show("restoreusers", restored > 0);
}

function restoreOpenUsers() {
  afterModal("restoremodal", function() { showPage("users"); });
}

// ---- restart -----------------------------------------------------------------

function restartESP() {
  var bar = document.querySelector(".savebar");
  var unsaved = !!bar && !bar.hidden; // staged settings (also on a reader with none saved yet)
  // "the doors do not respond" was wrong for a maglock on NO: it unlocks
  var maglock = maglockRestartWarning();
  confirmAction("Restart the reader now? Cards are not read for a few seconds." + (maglock ? " " + maglock : "") +
    (unsaved ? " Your unsaved settings are lost: Save & Reboot keeps them." : ""), "Restart", function() {
    inProgress("restart");
  });
}

// the host name the reader runs with (Status), not the one staged on General
// (review 8 R4-13: a staged new name had to be typed to erase the old device)
function compareDestroy() {
  var running = ajaxobj && ajaxobj.hostname ? String(ajaxobj.hostname) : "";
  byId("destroybtn").disabled = !running || running !== byId("compare").value;
}

function destroy() {
  afterModal("#destroy", function() { inProgress("destroy"); });
}

function upload() {
  // a fresh form each time: a retry used to send the image twice
  var formData = new FormData();
  formData.append("bin", byId("binform").files[0]);
  afterModal("#update", function() { inProgress("upload", formData); });
}

// The image's first bytes, as the device checks them (core::checkUpdateImageHead):
// an app image starts 0xE9, names the chip at byte 12 and has the app
// description magic 0xABCD5432 at byte 32. A -full-flash image does not.
function updateImageProblem(name, size, head) {
  var chipEsp32 = ajaxobj && ajaxobj.chip === "esp32";
  if (/-full/i.test(name)) {
    return "This is a full-flash image (for a serial flash only). Choose " + (chipEsp32 ? "ironframe-rfid-<version>.bin" : "esp32s3.bin") + ".";
  }
  if (ajaxobj && ajaxobj.availsize > 0 && size > ajaxobj.availsize) {
    return "The image (" + size + " bytes) is larger than the update slot (" + ajaxobj.availsize + " bytes).";
  }
  if (head.length < 36) return "The file is too short to be a firmware image.";
  if (head[0] !== 0xE9) return "Not a firmware update image (it does not start with 0xE9).";
  if (ajaxobj && ajaxobj.chip) {
    var chip = head[12] | (head[13] << 8);
    if (chip !== (chipEsp32 ? 0 : 9)) return "This image is for another chip, not the " + (chipEsp32 ? "ESP32 (WROOM)" : "ESP32-S3") + ".";
  }
  if (head[32] !== 0x32 || head[33] !== 0x54 || head[34] !== 0xCD || head[35] !== 0xAB) {
    return "Not a firmware update image: it starts with a bootloader (a full-flash image).";
  }
  return null;
}

function uploadProblem(text) {
  setText("upcheck", text);
  show("upcheck", !!text);
}

function allowUpload() {
  var f = byId("binform").files[0];
  byId("upbtn").disabled = true;
  uploadProblem("");
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function() {
    var problem = updateImageProblem(f.name, f.size, new Uint8Array(reader.result));
    if (problem) {
      uploadProblem(problem);
    } else {
      byId("upbtn").disabled = false;
    }
  };
  reader.onerror = function() { uploadProblem("The file could not be read."); };
  reader.readAsArrayBuffer(f.slice(0, 36));
}

// the Update dialog, named for this board's chip (the text used to say
// esp32s3.bin on every board)
function openUpdate() {
  allowUpload(); // check again: the chip may only be known now
  var maglock = maglockRestartWarning();
  setText("updatemaglock", maglock);
  show("updatemaglock", !!maglock);
  setText("versionhead", version);
  var esp32 = ajaxobj && ajaxobj.chip === "esp32";
  setText("upchip", esp32 ? "ESP32 (WROOM)" : "ESP32-S3");
  // ESP32 releases are named by version; a local build is bin/esp32wroom.bin
  setText("upfile", esp32 ? "ironframe-rfid-<version>.bin" : "esp32s3.bin");
  openDialog("update");
}
