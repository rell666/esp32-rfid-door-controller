// mqtt.js: MQTT Settings page.

// a whole number in [min, max] typed in field `id`, or NaN
function spWholeNumber(id, min, max) {
  var raw = String(byId(id).value).trim();
  var n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  return n >= min && n <= max ? n : NaN;
}

function savemqtt() {
  var m = JSON.parse(JSON.stringify(config.mqtt));
  m.enabled = spRadio("mqttEnabled") === "1" ? 1 : 0;
  m.host = byId("mqtthost").value.trim();
  m.port = spWholeNumber("mqttport", 1, 65535);
  if (isNaN(m.port)) {
    showMessage("Not staged: Port must be a whole number from 1 to 65535 (usually 1883)");
    byId("mqttport").focus();
    return;
  }
  m.topic = byId("mqtttopic").value;
  m.autotopic = byId("mqttautotopic").checked;
  m.user = byId("mqttuser").value;
  m.pswd = byId("mqttpwd").value;
  // a number: the firmware read the text "300" the old page sent as no value and used 180
  m.syncrate = spWholeNumber("syncrate", 1, 4294967);
  if (isNaN(m.syncrate)) {
    showMessage("Not staged: Sync Time must be a whole number of seconds (180 is the default)");
    byId("syncrate").focus();
    return;
  }
  m.mqttlog = spRadio("mqttlog") === "1" ? 1 : 0;
  m.remoteadmin = spRadio("mqttremoteadmin") === "1" ? 1 : 0;
  m.doorcontrol = spRadio("mqttdoorcontrol") === "1" ? 1 : 0;
  m.carduid = parseInt(byId("mqttcarduid").value);
  m.mqttha = spRadio("mqttha") === "1" ? 1 : 0;
  return spStage("mqtt", m);
}

// MQTT off: the rest of the page is kept but dimmed
function mqttEnabledChanged() {
  var on = spRadio("mqttEnabled") === "1";
  document.querySelectorAll("#ajaxcontent .set-mqttbody").forEach(function(e) { e.classList.toggle("set-off", !on); });
  show("mqttoffnote", !on);
}

var CARDUID_HINTS = {
  "1": "Messages show ****1234: enough to tell cards apart, not to clone one.",
  "2": "Messages carry the whole card number: anyone who can read the topic can clone the card.",
  "0": "Messages carry no card number."
};

function mqttHints() {
  spKeptHint("mqttpwd");
  var topic = byId("mqtttopic").value;
  if (topic) {
    var t = topic + (byId("mqttautotopic").checked ? "-xxxxxx" : "");
    setText("topicpreview", "Messages: " + t + "/send · Commands: " + t + "/cmd");
  } else {
    setText("topicpreview", "Set a topic prefix first.");
  }
  setText("carduidhint", CARDUID_HINTS[byId("mqttcarduid").value] || "");
  show("remoteadminwarn", spRadio("mqttremoteadmin") === "1");
  show("doorcontrolwarn", spRadio("mqttdoorcontrol") === "1");
}

function listmqtt() {
  spSetFlag("mqttEnabled", config.mqtt.enabled);
  byId("mqtthost").value = config.mqtt.host || "";
  byId("mqttport").value = config.mqtt.port === undefined || config.mqtt.port === null ? 1883 : config.mqtt.port;
  byId("mqtttopic").value = config.mqtt.topic || "";
  byId("mqttautotopic").checked = jsonInt(config.mqtt.autotopic, 0) !== 0;
  byId("mqttuser").value = config.mqtt.user || "";
  byId("mqttpwd").value = config.mqtt.pswd || "";
  byId("syncrate").value = jsonInt(config.mqtt.syncrate, 0) || 180;
  spSetFlag("mqttlog", config.mqtt.mqttlog);
  spSetFlag("mqttha", config.mqtt.mqttha);
  spSetFlag("mqttremoteadmin", config.mqtt.remoteadmin);
  spSetFlag("mqttdoorcontrol", config.mqtt.doorcontrol);
  // missing (saved before 1.4.2): the device shows the last 4
  byId("mqttcarduid").value = String([0, 1, 2].indexOf(jsonInt(config.mqtt.carduid, 1)) >= 0 ? jsonInt(config.mqtt.carduid, 1) : 1);
  mqttEnabledChanged();
  mqttHints();
}
