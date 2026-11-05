// state.js: Shared state: the staged settings (config), what the device last sent
// (savedConfig), the connection and the paging of the open list. Only
// settings.js and the pages' Save change config.

var version = "";

var websock = null;

var wsUri = "ws://" + window.location.host + "/ws";

var utcSeconds;

var data = [];

var ajaxobj;

var maxNumRelays=4;

var numRelays=1;

var theCurrentLogFile ="";

// The setup hotspot's password (core/wifi.h SETUP_HOTSPOT_PASSWORD, in the
// README; test/check-docs.mjs checks all three agree). A fresh board's first
// save keeps it, with the hotspot's name (transport.js), so the phone stays
// on the same network; it used to save an open hotspot.
var SETUP_HOTSPOT_PASSWORD = "ironframe-setup";

var config = {
    "command": "configfile",
    "network": {
        "bssid": "",
        "ssid": "IRONFRAME-RFID",
        "wmode": 1,
        "hide": 0,
        "pswd": SETUP_HOTSPOT_PASSWORD,
        "idleoff": 0,
        "idlemins": 15,
        "dhcp": 1,
        "ip": "",
        "subnet": "",
        "gateway": "",
        "dns": "",
        "apip": "192.168.4.1",
        "apsubnet": "255.255.255.0",
        "fallbackmode": 0,
        "fallbackpswd": ""
    },
    "hardware": {
        "readertype": 1,
        "wgd0pin": 4,
        "wgd1pin": 5,
        "wifipin": 255,
        "rtype": 1,
        "rhold": 1,
        "ltype": 0,
        "rpin": 21,
        "rtime": 400,
        "doorname": "Door",
        "beeperpin" : 255,
        "ledwaitingpin" : 255,
        "openlockpin": 255,
        "doorbellpin": 255,
        "accessdeniedpin": 255,
        "useridstoragemode": "hexadecimal",
        "requirepincodeafterrfid": 0,
        "allowpincodeonly": 0,
        "removeparitybits": 1,
        "doorstatpin": 255,
        "maxOpenDoorTime": 0
    },
    "general": {
        "hostnm": "ironframe-rfid",
        "restart": 0,
        "logging": 1,
        "pswd": "admin",
        "openinghours": [
          "111111111111111111111111",
          "111111111111111111111111",
          "111111111111111111111111",
          "111111111111111111111111",
          "111111111111111111111111",
          "111111111111111111111111",
          "111111111111111111111111",
        ]
    },
    "mqtt": {
        "enabled": 0,
        "host": "",
        "port": 1883,
        "topic": "",
        "autotopic": 0,
        "user": "",
        "pswd": "",
        "syncrate": 180,
        "mqttlog": 0,
        "remoteadmin": 0,
        "doorcontrol": 0,
        "carduid": 1
    },
    "ntp": {
        "server": "pool.ntp.org",
        "interval": 30,
        "tzinfo": ""
    }
};

var page = 1;

var haspages;

var recordstorestore = 0;

var slot = 0;


var file = {};

// a user backup being read (backup.js): its own pages, rows and retries, not
// the open page's, so opening another list page during it neither mixes that
// page's rows into the file nor stops it. null while no backup runs.
var backupRead = null;

// the Users page was opened during a backup: it loads when the backup ends
var backupUsersWaiting = false;

var restorestarted = false;

// users of the restore the device refused as invalid: {uid, name, why}
var restoreSkipped = [];

var gotInitialData = false;

var wsConnectionPresent = false;

var esprfidcontent;

// Paged log reads carry a byte offset: logpos is where the next page starts,
// logeof is set by the device once the end of the file has been sent.
var logpos = 0;

var logeof = false;

// Page whose data message has arrived and whose "result" is still expected.
var pageDataReceived = 0;

// Session token from /login, presented on the WebSocket and /update.
var sessionToken = sessionStorage.getItem("ifrfid-token") || "";

var configFromDevice = false;

var pendingEdit = null;   // user editor: function(ok, message) run when the device answers "userfile"

var pendingDelete = null; // user table row waiting for the device to confirm "remove"

var scannedCard = null;   // an unknown card scanned on the Users page: addRow fills the new user in from it

// The settings as last received from the device; the review lists what
// differs from them (it used to show the whole configuration as raw JSON).
var savedConfig = null;

// ---- the saved doors (plan 1.9.1 D3) ------------------------------------------
// A door's relay settings as stored on the reader (savedConfig: what a Test
// or a restart acts on), n = 1..4.
function savedRelay(n) {
  var h = (savedConfig && savedConfig.hardware) || {};
  var r = n === 1 ? h : (h["relay" + n] || {});
  var count = Math.min(4, Math.max(1, parseInt(h.numrelays, 10) || 1));
  return {
    pin: n <= count ? jsonInt(r.rpin, 255) : 255,
    hold: jsonInt(r.rhold, 0),
    ltype: jsonInt(r.ltype, 0),
    rtime: jsonInt(r.rtime, 400),
    name: r.doorname ? String(r.doorname) : (count > 1 ? "Door " + n : "the door")
  };
}

// The warning every restart owes a maglock on NO (relay on = locked): the
// door unlocks while the reader restarts (review 8 V8). "" when no door
// with a relay is held locked by it.
function maglockRestartWarning() {
  var doors = [];
  for (var n = 1; n <= 4; n++) {
    var r = savedRelay(n);
    if (r.pin !== 255 && r.hold === 1) doors.push(n);
  }
  if (!doors.length) return "";
  if (doors.length === 1) {
    return "Door " + doors[0] + " is held locked by its relay: it will be unlocked for a second or two while the reader restarts.";
  }
  return "Doors " + doors.slice(0, -1).join(", ") + " and " + doors[doors.length - 1] + " are held locked by their relays: they will be unlocked for a second or two while the reader restarts.";
}

// The reader trusts a time after 2016-01-01 (clock.esp CLOCK_TRUSTED_FROM;
// check-docs compares them): earlier is seconds since it started. One value
// for every page (logs.js had 2018-03-10, review 8 R4-17).
var CLOCK_TRUSTED_FROM = 1451606400;
