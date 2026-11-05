// network.js: Wireless Network page. Also the small helpers the settings
// pages (network, general, mqtt, ntp) share: radio groups, password fields.

// what the device sends instead of a stored password; sent back, it keeps it
var SP_MASK = "********";

// the value of the checked radio of group `name` on the open page ("" if none)
function spRadio(name) {
  var r = document.querySelector("#ajaxcontent input[name=\"" + name + "\"]:checked");
  return r ? r.value : "";
}

function spSetRadio(name, value) {
  document.querySelectorAll("#ajaxcontent input[name=\"" + name + "\"]").forEach(function(r) {
    r.checked = r.value === String(value);
  });
}

// a radio group of 0/1 from a config value (missing or odd = 0)
function spSetFlag(name, v) {
  spSetRadio(name, jsonInt(v, 0) === 1 ? "1" : "0");
}

// A select set to `value`; a value the menu does not list (set by a backup,
// MQTT or an older UI) is added as its own option, so a Save does not
// silently replace it with the first entry or an empty value.
function spSelect(id, value, text) {
  var sel = byId(id);
  var v = String(value === undefined || value === null ? "" : value);
  var found = Array.prototype.some.call(sel.options, function(o) { return o.value === v; });
  if (!found) {
    sel.appendChild(make("option", { value: v }, text));
  }
  sel.value = v;
}

// stageSection, and once the page's values are staged the page's earlier
// "Not staged" errors go (errors stay until closed, and on a phone they sit
// over the save bar)
function spStage(section, value) {
  var ok = stageSection(section, value);
  if (ok) {
    document.querySelectorAll("#msgarea .toast.danger").forEach(function(t) {
      if (/^Not staged:/.test(t.textContent)) dismissMessage(t);
    });
  }
  return ok;
}

// Show / Hide on a password field (data-arg: the input's id)
function spReveal(id) {
  var input = byId(id);
  var btn = document.querySelector("#ajaxcontent [data-onclick=\"spReveal\"][data-arg=\"" + id + "\"]");
  var showing = input.type === "password";
  input.type = showing ? "text" : "password";
  if (btn) {
    btn.textContent = showing ? "Hide" : "Show";
    btn.setAttribute("aria-pressed", showing ? "true" : "false");
  }
}

// "The saved password is kept" under a password field still holding the mask
function spKeptHint(id) {
  show(id + "-kept", byId(id).value === SP_MASK);
}

// ---- the page ---------------------------------------------------------------

var scanPick = null;   // the network picked in the scan results: {ssid, bssid}

var scanTimer = null;

var SCAN_TIMEOUT_MS = 15000;

function isAPMode() {
  return byId("wmodeap").checked;
}

function savenetwork() {
  var wmode = 0;
  var n = JSON.parse(JSON.stringify(config.network));
  // n.dhcp stays as saved unless Client mode sets it: the hidden DHCP radios
  // are not read in Hotspot mode, and writing 0 there forced a restart and
  // left a later Client switch on a fixed address (bench run, ledger H25)
  n.hide = 0;
  n.ssid = byId("inputtohide").value;
  if (isAPMode()) {
    wmode = 1;
    n.bssid = "";
    if (!checkOctects("ipaddress")) {
      return;
    }
    if (!checkOctects("subnet")) {
      return;
    }
    n.apip = byId("ipaddress").value;
    n.apsubnet = byId("subnet").value;
    n.hide = spRadio("hideapenable") === "1" ? 1 : 0;
  } else {
    // only when locking to one access point was chosen: a scan used to fill
    // the BSSID unseen, and the device then joined that access point only
    n.bssid = byId("bssidlock").checked ? byId("wifibssid").value.trim() : "";
    if (byId("bssidlock").checked && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.bssid)) {
      // the firmware reads any text as hex pairs: a typo locked it to a radio that does not exist
      showMessage("Not staged: BSSID must be six pairs of hex digits, for example aa:bb:cc:dd:ee:ff (or untick Lock to this access point)");
      byId("wifibssid").focus();
      return;
    }
    if (spRadio("dhcpenabled") === "1") {
      n.dhcp = 1;
    } else {
      n.dhcp = 0;
      if (!checkOctects("ipaddress")) {
        return;
      }
      if (!checkOctects("subnet")) {
        return;
      }
      if (!checkOctects("dnsadd")) {
        return;
      }
      if (!checkOctects("gateway")) {
        return;
      }
      n.ip = byId("ipaddress").value;
      n.dns = byId("dnsadd").value;
      n.subnet = byId("subnet").value;
      n.gateway = byId("gateway").value;
    }
  }
  n.wmode = wmode;
  n.pswd = byId("wifipass").value;

  n.fallbackmode = parseInt(spRadio("fallbackmode")) || 0;
  n.fallbackpswd = byId("fallbackpass").value;
  // the device never opens the fallback hotspot without a password (8-63,
  // WPA2); a stored one comes back masked, which is 8 characters
  if (n.fallbackmode === 1 && (n.fallbackpswd.length < 8 || n.fallbackpswd.length > 63)) {
    showMessage("Not staged: WiFi fallback mode needs a fallback hotspot password of 8-63 characters");
    byId("fallbackpass").focus();
    return;
  }
  delete n.offtime; // WiFi Timeout, until 1.7: the device turns a stored one into idle-off
  n.idleoff = byId("idleoff").checked ? 1 : 0;
  var mins = Number(byId("idlemins").value);
  var minsOk = Math.floor(mins) === mins && mins >= 1 && mins <= 1440;
  if (n.idleoff === 1 && !minsOk) {
    showMessage("Not staged: Turn Wi-Fi off after must be 1-1440 minutes");
    byId("idlemins").focus();
    return;
  }
  n.idlemins = minsOk ? mins : 15;
  return spStage("network", n);
}

// Hotspot: the reader's own network, its own address; no scan, no DHCP
function handleAP() {
  byId("ipaddress").value = config.network.apip || "";
  byId("subnet").value = config.network.apsubnet || "";
  show("hideap");
  hide("hideBSSID");
  hide("scanb");
  hide("scanbox");
  hide("dhcp");
  hide("dhcpnote");
  show("staticip1");
  hide("staticip2");
  setText("ssidlabel", "Hotspot name (SSID)");
  setText("passlabel", "Hotspot password");
  setText("wmodehint", "The reader makes its own Wi-Fi network. Join it and open http://" + (config.network.apip || "192.168.4.1") + " to reach this page.");
  byId("ipaddress").placeholder = "192.168.4.1";
  passwordHints();
}

function handleDHCP() {
  if (isAPMode()) {
    return; // the hotspot always has a fixed address
  }
  var dhcp = spRadio("dhcpenabled") === "1";
  if (!dhcp) {
    byId("ipaddress").value = config.network.ip || "";
    byId("subnet").value = config.network.subnet || "";
  }
  show("staticip1", !dhcp);
  show("staticip2", !dhcp);
  show("dhcpnote", dhcp);
  byId("ipaddress").placeholder = "192.168.1.50";
}

// Client: join an existing network
function handleSTA() {
  hide("hideap");
  show("hideBSSID");
  show("scanb");
  show("dhcp");
  setText("ssidlabel", "Network name (SSID)");
  setText("passlabel", "Password");
  setText("wmodehint", "The reader joins your Wi-Fi network. Type its name or Scan for it.");
  showBssid();
  handleDHCP();
  passwordHints();
}

function listnetwork() {
  scanPick = null;
  byId("inputtohide").value = config.network.ssid || "";
  byId("wifipass").value = config.network.pswd || "";
  // filled in either mode: switching mode on the page keeps them
  byId("wifibssid").value = config.network.bssid || "";
  byId("bssidlock").checked = !!config.network.bssid;
  byId("dnsadd").value = config.network.dns || "";
  byId("gateway").value = config.network.gateway || "";
  spSetFlag("hideapenable", config.network.hide);
  spSetRadio("dhcpenabled", jsonInt(config.network.dhcp, 1) === 0 ? "0" : "1");
  spSetFlag("fallbackmode", config.network.fallbackmode);
  byId("fallbackpass").value = config.network.fallbackpswd || "";
  byId("idleoff").checked = jsonInt(config.network.idleoff, 0) === 1;
  byId("idlemins").value = jsonInt(config.network.idlemins, 15);
  showIdleOff();
  if (config.network.wmode === 1) {
    byId("wmodeap").checked = true;
    handleAP();
  } else {
    byId("wmodesta").checked = true;
    handleSTA();
  }
  showFallback();
}

function showBssid() {
  show("bssidrow", byId("bssidlock").checked);
}

// The picked network fills the BSSID only while "Lock to this access point"
// is ticked (and the name was not changed by hand since).
function listBSSID() {
  if (byId("bssidlock").checked && scanPick && (scanPick.ssid === null || scanPick.ssid === byId("inputtohide").value)) {
    byId("wifibssid").value = scanPick.bssid;
  }
}

function bssidLockChanged() {
  listBSSID();
  showBssid();
}

// the name typed by hand: a scanned network picked before no longer applies
function ssidTyped() {
  if (scanPick && scanPick.ssid !== null && scanPick.ssid !== byId("inputtohide").value) {
    scanPick = null;
    document.querySelectorAll("#ssid .set-scanitem[aria-pressed=true]").forEach(function(b) { b.setAttribute("aria-pressed", "false"); });
  }
}

function signalPercent(rssi) {
  var x = parseInt(rssi);
  return isNaN(x) ? 0 : Math.min(Math.max(2 * (x + 100), 0), 100);
}

function pickNetwork(item, btn) {
  scanPick = { ssid: item.ssid ? String(item.ssid) : null, bssid: String(item.bssid || "") };
  document.querySelectorAll("#ssid .set-scanitem").forEach(function(b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
  if (scanPick.ssid !== null) {
    byId("inputtohide").value = scanPick.ssid;
  } else {
    byId("inputtohide").focus(); // a hidden network: its name has to be typed
  }
  listBSSID();
}

// The device's scan results (transport.js, "ssidlist"). SSIDs come from any
// nearby radio: they go into the page as text only, never as HTML.
function listSSID(obj) {
  var list = byId("ssid");
  if (!list) {
    return; // the page was left while scanning
  }
  clearTimeout(scanTimer);
  byId("scanb").disabled = false;
  setText("scanbtext", "Scan again");
  list.textContent = "";
  var items = (obj && Array.isArray(obj.list) ? obj.list : []).slice().sort(function(a, b) {
    return signalPercent(b.rssi) - signalPercent(a.rssi);
  });
  setText("scanstate", items.length ? items.length + (items.length === 1 ? " network found. Tap one to use it." : " networks found. Tap one to use it.") :
    "No networks found. Check the reader is in range of the access point, or type the name.");
  items.forEach(function(item) {
    var pct = signalPercent(item.rssi);
    var btn = make("button", { type: "button", className: "set-scanitem", "aria-pressed": "false" });
    btn.appendChild(make("span", "set-bars set-bars" + Math.min(4, Math.ceil(pct / 25)), ""));
    var main = make("span", "main");
    main.appendChild(make("span", "title" + (item.ssid ? "" : " muted"), item.ssid ? String(item.ssid) : "(hidden network)"));
    var sub = "Signal " + pct + " % · BSSID " + String(item.bssid || "?");
    if (item.channel !== undefined) sub += " · channel " + String(item.channel);
    main.appendChild(make("span", "sub mono", sub));
    btn.appendChild(main);
    if (scanPick && scanPick.bssid === String(item.bssid)) {
      btn.setAttribute("aria-pressed", "true");
    }
    btn.addEventListener("click", function() { pickNetwork(item, btn); });
    var li = make("li");
    li.appendChild(btn);
    list.appendChild(li);
  });
  listBSSID();
}

function scanWifi() {
  sendWebsocket("{\"command\":\"scan\"}");
  byId("scanb").disabled = true;
  setText("scanbtext", "Scanning...");
  show("scanbox");
  byId("ssid").textContent = "";
  var state = byId("scanstate");
  state.textContent = "";
  state.appendChild(make("span", "spinner"));
  state.appendChild(make("span", null, "Looking for networks: this takes a few seconds."));
  clearTimeout(scanTimer);
  scanTimer = setTimeout(function() {
    if (!byId("scanb")) return;
    byId("scanb").disabled = false;
    setText("scanbtext", "Scan again");
    setText("scanstate", "The reader did not answer. Try again.");
  }, SCAN_TIMEOUT_MS);
}

// the minutes and what stops while Wi-Fi is off: shown while the box is ticked
function showIdleOff() {
  show("idleminsrow", byId("idleoff").checked);
}

function showFallback() {
  show("fallbackpassrow", spRadio("fallbackmode") === "1");
  passwordHints();
}

// the kept-password notes, the open-hotspot warning and the length count
function passwordHints() {
  spKeptHint("wifipass");
  spKeptHint("fallbackpass");
  show("apopenwarn", isAPMode() && byId("wifipass").value === "");
  var fp = byId("fallbackpass").value;
  setText("fallbackpass-count", fp === SP_MASK || fp === "" ? "" : fp.length + " characters" + (fp.length < 8 || fp.length > 63 ? " (needs 8 to 63)" : ""));
}

function maskHints() {
  passwordHints();
}
