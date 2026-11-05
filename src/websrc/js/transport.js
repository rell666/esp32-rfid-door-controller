// transport.js: The WebSocket to the device: sign-in, the session, one outstanding
// paged request with retries, and the dispatch of every message.

function sendWebsocket(msg) {
  websock.send(msg);
}

// Only one paged request is outstanding at a time. If it is not answered it
// is re-sent (the requests are idempotent: they name the page / byte offset).
// Upstream queued every request and re-sent them on a timer whether or not
// they had been answered, which duplicated pages on a slow device.
var pendingRequest = null;

var REQUEST_TIMEOUT_MS = 15000;

function clearPendingRequest() {
  if (pendingRequest) {
    clearTimeout(pendingRequest.timer);
    pendingRequest = null;
  }
}

function retryPendingRequest() {
  if (!pendingRequest) {
    return;
  }
  if (pendingRequest.tries >= 3) {
    clearTimeout(pendingRequest.timer);
    pendingRequest = null;
    var message = "Device did not acknowledge the request";
    if (restorestarted) {
      finishRestore(false, message);
    } else {
      var loading = document.getElementById("loading-img");
      if (loading) loading.style.display = "none";
      showMessage(message);
    }
    return;
  }
  pendingRequest.tries++;
  websock.send(pendingRequest.message);
  pendingRequest.timer = setTimeout(retryPendingRequest, REQUEST_TIMEOUT_MS);
}

function sendWebsocketWithRetry(msg) {
  clearPendingRequest();
  websock.send(msg);
  pendingRequest = { message: msg, tries: 0, timer: setTimeout(retryPendingRequest, REQUEST_TIMEOUT_MS) };
}

function getnextpage(mode) {
  if (byId("loadpages")) {
    byId("loadpages").textContent = "Loading " + page + "/" + haspages;
  }

  // check received previous page
  var isLog = (mode === "geteventlog") || (mode === "getlatestlog");
  if (isLog ? !logeof : page < haspages) {
    page = page + 1;
    var commandtosend = {};
    commandtosend.command = mode;
    commandtosend.page = page;
    if ((mode === "geteventlog") || (mode === "getlatestlog")) {
      commandtosend.filename = theCurrentLogFile;
      commandtosend.pos = logpos;
    }
    sendWebsocketWithRetry(JSON.stringify(commandtosend));
  }
}

function builddata(obj) {
  data = data.concat(obj.list);
}

function socketMessageListener(evt) {
  var obj;
  try {
    obj = JSON.parse(evt.data);
  } catch (e) {
    return; // a bad frame is ignored; the next one is handled as usual
  }
  if (!obj || typeof obj !== "object") return;
  // a result is {"command": "result", "resultof": ...}: both run, in this order
  if (obj.hasOwnProperty("command")) onDeviceCommand(obj);
  if (obj.hasOwnProperty("resultof")) onDeviceResult(obj);
}

// What the device sends of its own accord or as data: status, lists, the
// time, a card at a reader, the settings (review 7: one 252-line listener).
function onDeviceCommand(obj) {
  switch (obj.command) {
    case "status":
      ajaxobj = obj;
      applyChipDefaults();
      // A fresh board broadcasts IRONFRAME-RFID-xxxxxx and reports it here.
      // Until the device has sent a config, that is the default: the
      // built-in "IRONFRAME-RFID" made the first save move the hotspot to
      // another name, and the phone dropped off.
      if (!configFromDevice && obj.ssid && config.network.wmode === 1) {
        config.network.ssid = obj.ssid;
      }
      getContent("#statuscontent");
      setTimeIfUnset(obj);
      break;
    case "userlist":
      if (backupRead) {
        backupPageReceived(obj); // the backup's (the Users page waits for it)
        break;
      }
      if (obj.page !== page) {
        break; // stale or duplicate answer
      }
      clearPendingRequest();
      pageDataReceived = page;
      haspages = obj.haspages;
      if (haspages === 0) {
        usersLoaded(); // users.js: the (empty) list is shown
        break;
      }
      builddata(obj);
      break;
    case "eventlist":
    case "latestlist":
      if (obj.page !== page) {
        break; // stale or duplicate answer
      }
      clearPendingRequest();
      pageDataReceived = page;
      haspages = obj.haspages;
      logpos = obj.nextpos;
      logeof = obj.eof;
      builddata(obj);
      break;
    case "listfiles":
      if (obj.page !== page) {
        break;
      }
      clearPendingRequest();
      pageDataReceived = page;
      haspages = obj.haspages;
      if (haspages === 0) {
          document.getElementById("loading-img").style.display = "none";
          initFileListTable();
          break;
        }
        builddata(obj);
        break;
    case "gettime":
      utcSeconds = obj.epoch;
      deviceTime();
      if (obj.epoch > CLOCK_TRUSTED_FROM) { // state.js
        if (ajaxobj) { ajaxobj.timetrusted = true; }
        showClockState(true);
      }
      break;
    case "piccscan":
      listSCAN(obj);
      break;
    case "mustchangepassword":
      showChangePassword(true);
      break;
    case "stepup":
      if (stepUpWait) {
        var answer = stepUpWait;
        stepUpWait = null;
        answer(String(obj.nonce || ""));
      }
      break;
    case "ssidlist":
      listSSID(obj);
      break;
    case "configfile":
      if (settingsBackupTimer) {
        settingsBackupReceived(obj);
        if (configFromDevice) break; // keep the staged edits
      }
      configReceived(obj);
      break;
    case "giveAccess":
      // the answer to Test: the device fired the relay. Up to 1.9.0 every
      // granted card was also broadcast bare, and every open tab showed this
      // on every entry (review 8 V7): only the reply naming a relay counts.
      if (obj.relay) {
        showMessage("Relay " + jsonInt(obj.relay, 1) + " fired: it switches as on a granted card (for its Relay Time if momentary).", "success");
      }
      break;
    default:
      break;
  }

}

// The answer to a request: {"command": "result", "resultof": <request>, "result": true|false}.
function onDeviceResult(obj) {
  if (obj.result === false && /password was not confirmed/.test(obj.message || "")) {
    signinHa1 = null; // wrong or changed: ask next time
    stepUpRequired = true;
  }
  if (obj.resultof === "userlist" && backupRead) {
    backupPageResult(obj.result === true); // the backup's, not the open page's
    return;
  }
  var pagedResult = ["userlist", "eventlist", "latestlist", "listfiles"].indexOf(obj.resultof) >= 0;
  if (pagedResult) {
    if (pageDataReceived !== page && obj.result === true) {
      return; // result of a page we already handled (or never accepted)
    }
    pageDataReceived = 0;
    // a refused page is final: no retries, no spinner, the reason shown (a
    // bare false was retried three times and then blamed on the device)
    if (obj.result === false && !obj.hasOwnProperty("message")) {
      obj.message = "The device could not send this page.";
    }
  }
  if (progressOp && PROGRESS_OF_RESULT[obj.resultof] === progressOp) {
    // the answer to Save & Reboot, Restart or Factory reset
    if (obj.result === true) {
      progressFinished(obj.restart); // restart: false = applied without a restart
    } else {
      progressFailed(obj.message);
    }
    return;
  }
  if (obj.result === false && obj.hasOwnProperty("message") && obj.resultof !== "logfileMaintenance") {
    clearPendingRequest();
    if (obj.resultof === "userfile" && restorestarted && obj.invalid === true) {
      restoreSkip(obj.message); // that user only: the rest of the backup goes on
      return;
    } else if (obj.resultof === "userfile" && restorestarted) {
      finishRestore(false, obj.message || "Restore failed");
    } else if (obj.resultof === "userfile" && pendingEdit) {
      var refusedEdit = pendingEdit;
      pendingEdit = null;
      refusedEdit(false, obj.message); // shown in the user dialog
      return;
    }
    if (obj.resultof === "remove") {
      pendingDelete = null; // not removed: the row stays
    }
    document.getElementById("loading-img") && (document.getElementById("loading-img").style.display = "none");
    if (obj.resultof === "setlogging") {
      // not changed on the device: show what it still does
      if (byId("logging")) byId("logging").value = parseInt(config.general.logging) === 0 ? "0" : "1";
    }
    if (obj.resultof === "setpassword") {
      setText("changepasserror", obj.message);
      show("changepasserror");
    } else {
      showMessage(obj.message);
    }
    return;
  }
  switch (obj.resultof) {
    case "clearevent":
      if (obj.result === true) openMenuPage("eventlog"); // reload: the log is empty now
      break;
    case "clearlatest":
      if (obj.result === true) openMenuPage("latestlog");
      break;
    case "setlogging":
      if (obj.result === true) {
        config.general.logging = parseInt(byId("logging").value) === 0 ? 0 : 1;
        // stored on the device already: not an unsaved change
        if (savedConfig && savedConfig.general) savedConfig.general.logging = config.general.logging;
        show("loggingsaved");
      }
      break;
    case "setpassword":
      if (obj.result === true) {
        sessionStorage.removeItem("ifrfid-token");
        // shown on the sign-in dialog after the reload
        sessionStorage.setItem("ifrfid-notice", "Password changed. Please sign in with the new password.");
        document.location = "index.html";
      }
      break;
    case "userlist":
      if (page < haspages && obj.result === true) {
        getnextpage("userlist");
      } else if (page === haspages) {
        usersLoaded(); // users.js: every page has arrived, the list is shown
        break;
      }
      break;
    case "eventlist":
      if (!byId("saveeventlogbtn")) {
        break; // the Event Log was left while it loaded: stop reading it
      }
      document.getElementById("saveeventlogbtn").disabled=true;
      document.getElementById("cleareventlogbtn").disabled=true;
      if (!logeof && obj.result === true) {
        getnextpage("geteventlog");
      } else {
        initEventTable();
        document.getElementById("saveeventlogbtn").disabled=false;
        // only enable delete button for main event log
        // others need to be done from the maintenance section
        if (theCurrentLogFile === "/eventlog.json") {
          document.getElementById("cleareventlogbtn").disabled=false;
        }
        document.getElementById("loading-img").style.display = "none";
      }
      break;
    case "latestlist":
      if (!byId("savelatestlogbtn")) {
        break; // the Access Log was left while it loaded: stop reading it
      }
      document.getElementById("savelatestlogbtn").disabled=true;
      document.getElementById("clearlatestlogbtn").disabled=true;
      if (!logeof && obj.result === true) {
        getnextpage("getlatestlog");
      } else {
        initLatestLogTable();
        document.getElementById("savelatestlogbtn").disabled=false; 
        if (theCurrentLogFile === "/latestlog.json")
        {
          document.getElementById("clearlatestlogbtn").disabled=false; 
        } 
        document.getElementById("loading-img").style.display = "none";
      }
      break;
    case "listfiles":
      if (page < haspages && obj.result === true) {
        getnextpage("listfiles");
      } else if (page === haspages) {
        initFileListTable();
        document.getElementById("loading-img").style.display = "none";
      }
      break;
    case "logfileMaintenance":
      if (obj.result === false) 
      {
        showMessage(obj.hasOwnProperty("message") ? obj.message : "Operation failed");
      } else
      {
        openMenuPage("logmaintenance");
      }
      break;
    case "userfile":
      clearPendingRequest();
      if (restorestarted && obj.result === true) {
        restoreNext();
      } else if (obj.result === true && pendingEdit) {
        var savedEdit = pendingEdit;
        pendingEdit = null;
        savedEdit(true);
      }
      break;
    case "remove":
      // sent to every tab, naming the user removed: drop that row from
      // the user list if it is open here, and finish this tab's own
      // delete only if it is that user
      if (obj.result === true) {
        if (pendingDelete && pendingDelete.value.uid === obj.uid) {
          pendingDelete = null;
        }
        userRemoved(obj.uid); // users.js: drop that user from the list if it is open
      }
      break;
    default:
      break;
  }

}

function logout() {
  // Revoke the session on the device (not just in this tab), then go back to
  // the login page. Upstream sent bogus Basic credentials to /login, which
  // now counts as a failed login and five logouts would lock the IP out.
  try {
    if (websock && websock.readyState === 1) {
      websock.send(JSON.stringify({ command: "logout", token: sessionToken }));
    }
  } catch (e) {}
  sessionStorage.removeItem("ifrfid-token");
  sessionToken = "";
  setTimeout(function() { document.location = "index.html"; }, 200);
  return false;
}

function wsConnectionActive() {
  wsConnectionPresent = true;
  hide("ws-connection-status");
  if (!gotInitialData) {
    sendWebsocket("{\"command\":\"status\"}");
    sendWebsocket("{\"command\":\"getconf\"}");
    gotInitialData = true;
  }
}

var USER_SAVE_TIMEOUT_MS = 15000;

// The user editor's save, if one is waiting for an answer that will not
// come (the socket closed, or too long): the editor stops "Saving..." and
// says so.
function failPendingEdit(message) {
  if (!pendingEdit) return;
  var edit = pendingEdit;
  pendingEdit = null;
  edit(false, message, true);
}

// refused: the device answered and refused this session (token missing,
// expired or revoked); otherwise it went away or cannot be reached.
function wsConnectionClosed(refused) {
  wsConnectionPresent = false;
  if (rebooting) {
    deviceWentDown = true; // the device restarts on purpose: the progress overlay takes over
    return;
  }
  if (refused) {
    sessionStorage.removeItem("ifrfid-token");
    sessionToken = "";
    openDialog("signin", { static: true });
    return;
  }
  show("ws-connection-status");
  connectWS();
}

// Is the session still good? A WebSocket that never opened says only that
// it failed, not why. "refused" only when the device answers 401 for this
// token (password changed, device restarted, token expired or revoked);
// any other answer, or none, is "retry". It used to be refused whenever the
// device answered at all, so a busy device or a Wi-Fi blip threw the
// sign-in away (2026-10-16).
function sessionCheck(done) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "/session?probe=" + Date.now(), true);
  xhr.setRequestHeader("X-Session-Token", sessionToken);
  xhr.timeout = 4000;
  xhr.onload = function() { done(xhr.status === 401 ? "refused" : "retry"); };
  xhr.onerror = xhr.ontimeout = function() { done("retry"); };
  xhr.send(null);
}

// The next connection attempt in 5 s, while not connected. One timer at a
// time (cleared before it is set): every path that can find itself not
// connected re-arms it, so a reconnect cannot stall (review 8 V6: the only
// timer fired into a connect still in progress and nothing re-armed it).
var wsRetryTimer = null;

function keepWSConnectionOpen() {
  clearTimeout(wsRetryTimer);
  wsRetryTimer = null;
  if (!wsConnectionPresent) {
    wsRetryTimer = setTimeout(connectWS, 5000);
  }
}

function connectWS() {
  if (wsConnectionPresent || !sessionToken) {
    return;
  }
  if (websock && (websock.readyState === WebSocket.CONNECTING || websock.readyState === WebSocket.OPEN)) {
    // one socket at a time: a retry timer firing during a slow connect
    // opened a second. Look again later: this connect may still fail.
    keepWSConnectionOpen();
    return;
  }

  if (window.location.protocol === "https:") {
    wsUri = "wss://" + window.location.host + "/ws";
  } else {
    wsUri = "ws://" + window.location.host + "/ws";
  }
  var opened = false;
  var sock = new WebSocket(wsUri + "?token=" + encodeURIComponent(sessionToken));
  websock = sock;
  sock.addEventListener("message", socketMessageListener);

  sock.onopen = function(evt) {
    opened = true;
    wsConnectionActive();
  };

  sock.onclose = function(evt) {
    if (opened) {
      failPendingEdit("The connection to the device was lost before it answered, so the user may not be saved. Check the user list once it reconnects, then save again.");
    }
    if (opened || rebooting) {
      wsConnectionClosed(false);
      return;
    }
    // Never opened: sign in again only if the device says this session is
    // gone; otherwise keep the session and retry.
    sessionCheck(function(answer) {
      if (websock !== sock) return; // a newer socket has taken over
      if (answer === "refused") {
        wsConnectionClosed(true);
      } else {
        wsConnectionPresent = false;
        show("ws-connection-status");
        keepWSConnectionOpen(); // the next attempt, from here: the earlier timer may have fired already
      }
    });
  };

  keepWSConnectionOpen();
}

function loginError(text) {
  setText("loginerror", text);
  show("loginerror");
}

function login() {
  var username = "admin";
  var password = document.getElementById("password").value;
  var xhr = new XMLHttpRequest();
  xhr.open("get", "/login", true, username, password);
  xhr.onload = function(e) {
    if (xhr.status === 200) {
      var reply;
      try {
        reply = JSON.parse(xhr.responseText);
      } catch (err) {
        reply = {};
      }
      sessionToken = reply.token || "";
      sessionStorage.setItem("ifrfid-token", sessionToken);
      hide("loginerror");
      closeDialog("signin");
      connectWS();
      // memory only: the forced password change and the step-ups prove it
      signinHa1 = adminHa1(password);
      if (reply.mustchangepassword) {
        showChangePassword(true);
      }
    } else if (xhr.status === 429) {
      // the device says how long (Retry-After, seconds): 1-15 min device-wide, 5 per address
      var wait = parseInt(xhr.getResponseHeader("Retry-After"), 10);
      var mins = wait > 0 ? Math.ceil(wait / 60) : 0;
      loginError("Too many failed attempts. " + (mins > 0 ? "Wait " + mins + (mins === 1 ? " minute" : " minutes") : "Wait up to 15 minutes") + " and try again.");
    } else {
      loginError("Incorrect password.");
    }
  };
  // no answer at all (device off, out of Wi-Fi range): say so, rather than
  // leave the sign-in dialog silent
  xhr.timeout = 15000;
  xhr.onerror = xhr.ontimeout = function() {
    loginError("The device did not answer. Check you are connected to its network and try again.");
  };
  xhr.send(null);
}

// MD5 (RFC 1321) of a string's UTF-8 bytes, as 32 lowercase hex characters:
// for Change Password (core/adminpass.h openPasswordChange), which must not
// send either password over the link.
function md5hex(str) {
  var bytes = unescape(encodeURIComponent(str));
  var n = bytes.length;
  var words = [];
  for (var i = 0; i < n; i++) {
    words[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
  }
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  var total = (((n + 8) >> 6) + 1) * 16;
  for (var w = words.length; w < total; w++) {
    words[w] = words[w] | 0;
  }
  words[total - 2] = n * 8;
  var K = [], R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (var k = 0; k < 64; k++) {
    K[k] = Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296) | 0;
  }
  var h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  for (var b = 0; b < total; b += 16) {
    var a = h[0], bb = h[1], c = h[2], d = h[3];
    for (var j = 0; j < 64; j++) {
      var f, g;
      if (j < 16) { f = (bb & c) | (~bb & d); g = j; }
      else if (j < 32) { f = (d & bb) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = bb ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (bb | ~d); g = (7 * j) % 16; }
      var t = d;
      d = c;
      c = bb;
      var x = (a + f + K[j] + words[b + g]) | 0;
      var r = R[(j >> 4) * 4 + (j % 4)];
      bb = (bb + ((x << r) | (x >>> (32 - r)))) | 0;
      a = t;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + bb) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
  }
  var out = "";
  for (var q = 0; q < 16; q++) {
    out += ("0" + ((h[q >> 2] >>> ((q % 4) * 8)) & 255).toString(16)).slice(-2);
  }
  return out;
}

function adminHa1(password) {
  return md5hex("admin:ironframe-rfid:" + password);
}

// The setpassword message (core::openPasswordChange): the new HA1 encrypted
// under the current one and this session's token, and a proof of the current.
function passwordChangeMessage(newPassword, currentHa1) {
  var newHa1 = adminHa1(newPassword);
  var key = md5hex(currentHa1 + ":" + sessionToken + ":set-key");
  var enc = "";
  for (var i = 0; i < 32; i += 2) {
    var v = parseInt(newHa1.substr(i, 2), 16) ^ parseInt(key.substr(i, 2), 16);
    enc += ("0" + v.toString(16)).slice(-2);
  }
  return JSON.stringify({ command: "setpassword", ha1enc: enc, proof: md5hex(currentHa1 + ":" + sessionToken + ":" + newHa1), len: newPassword.length });
}

// The sign-in password's HA1: it proves the current password for the
// forced change and the step-ups without asking for it again. Memory only:
// after a reload the page asks.
var signinHa1 = null;

// ---- step-up (core/adminpass.h stepUpProofOk, plan 1.9 S1) ------------------
// A firmware update, a factory reset and a save that changes network, MQTT
// or (since 1.9.1) Doors & Readers settings carry a proof of the admin
// password, so a session token alone (it travels in the WebSocket URL)
// cannot do them; since 1.9.1 so do Test, Restart, removing a user, adding
// one, admin access or a PIN change, clearing a log, logging on or off and
// moving a set clock (wsCommands[] stepUp, plan 1.9.1 B1).
// ok({stepnonce, stepproof}) once the device's challenge is answered;
// fail(message) if it cannot be.
var stepUpWait = null;
var stepUpRequired = false; // the device refused a save without one: ask from now on

function withStepUp(action, ok, fail) {
  askAdminHa1(function(ha1) {
    stepUpWait = function(nonce) {
      ok({ stepnonce: nonce, stepproof: md5hex(ha1 + ":" + sessionToken + ":" + nonce + ":" + action) });
    };
    if (!websock || websock.readyState !== 1) {
      stepUpWait = null;
      fail("Not connected to the device. Nothing was changed: try again once it reconnects.");
      return;
    }
    sendWebsocket("{\"command\":\"stepup\"}");
  }, fail);
}

// A command with a step-up (the action is its name on the device): sent
// once the challenge is answered; failed(message) if it cannot be (by
// default the message is shown).
function sendWithStepUp(action, msg, failed) {
  withStepUp(action, function(step) {
    sendWebsocket(JSON.stringify(Object.assign({}, msg, step)));
  }, failed || function(message) { showMessage(message); });
}

// The admin password's HA1: kept from the sign-in, or asked for once.
var stepUpAsk = null;

function askAdminHa1(done, fail) {
  if (signinHa1) {
    done(signinHa1);
    return;
  }
  stepUpAsk = { done: done, fail: fail };
  byId("stepuppass").value = "";
  openDialog("stepupdlg", { static: true });
}

function stepUpSubmit() {
  var a = stepUpAsk;
  stepUpAsk = null;
  closeDialog("stepupdlg");
  if (!a) return;
  signinHa1 = adminHa1(byId("stepuppass").value);
  byId("stepuppass").value = "";
  a.done(signinHa1);
}

// fail(message, cancelled): cancelled = the admin chose not to go on, not a
// failure (review 8 R4-21: the progress dialog showed it as a red "Not saved")
function stepUpCancel() {
  var a = stepUpAsk;
  stepUpAsk = null;
  closeDialog("stepupdlg");
  if (a) a.fail("Cancelled: nothing was changed.", true);
}

// A save needs a step-up when it changes the network, MQTT or hardware
// section (the device decides, against what it has stored:
// core::stepUpNeededFor).
function needsStepUp(before, after) {
  if (!before) return false;
  var same = function(k) { return JSON.stringify(before[k] || {}) === JSON.stringify(after[k] || {}); };
  return !same("network") || !same("mqtt") || !same("hardware");
}

function showChangePassword(forced) {
  hide("changepasserror");
  show("changepassforced", forced);
  show("changepassclose", !forced);
  // the forced change proves the password just signed in with; after a
  // reload that is gone, so it is asked for
  var ask = !(forced && signinHa1);
  show("currentpassgroup", ask);
  byId("currentpass").required = ask;
  ["currentpass", "newpass1", "newpass2"].forEach(function(id) { byId(id).value = ""; });
  openDialog("changepass", { static: forced });
}

function changePassword() {
  var p1 = document.getElementById("newpass1").value;
  var p2 = document.getElementById("newpass2").value;
  if (p1 !== p2) {
    setText("changepasserror", "The passwords do not match.");
    show("changepasserror");
    return;
  }
  if (p1.length < 8 || p1.length > 64 || p1 === "admin") {
    setText("changepasserror", "Use 8 to 64 characters, and not 'admin'.");
    show("changepasserror");
    return;
  }
  var current = !byId("currentpassgroup").hidden ? adminHa1(document.getElementById("currentpass").value) : signinHa1;
  sendWebsocket(passwordChangeMessage(p1, current));
}
