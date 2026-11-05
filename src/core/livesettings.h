// A settings save without a restart: which settings the firmware can take
// over while it runs, and the copy of exactly those into the running
// settings. Pure, so the decision is unit-tested on the host against shared
// vectors (test/vectors/live-settings.json) that the web UI's copy
// (websrc/js/policy.js settingsNeedRestart) and the simulator's are also
// checked against.
//
// The decision compares the two config.json documents, not two parsed
// Settings: the keys are what the UI, the vectors and the JS copy speak, and
// a key the parser does not know (a newer page, a typo, an old field) shows
// up as a change here and so restarts. A comparison of parsed Settings would
// silently call such a key "no change". Values are compared as the UI's
// review compares them (configChanges in settings.js): true == 1 == "1",
// 16 == "16", an array as its JSON text, a missing key differs from any value.
//
// LIVE = pure policy, timing or text that the firmware reads at the moment of
// use, on the loop() task. Everything else restarts: pins and anything else
// that configures a GPIO, reader types, relay type and count, reader 2 on or
// off, the LED/buzzer drive, Wi-Fi and the network (idle-off aside), the hostname (mDNS, MQTT
// discovery ids), the admin password, the MQTT connection and its
// Home Assistant mode, NTP server, and anything with running state that a
// change would leave inconsistent (lock type, auto-restart).
#pragma once

#include <ArduinoJson.h>
#include <cstring>
#include <string>
#include <vector>

#include "core/settings.h"

namespace core
{

// Every key that is applied while the device runs, with where it is read.
// A key not here restarts. Keep in step with LIVE_SETTINGS in
// websrc/js/policy.js and test/e2e/device-sim.mjs (the vectors check both).
static const char *const LIVE_SETTINGS[] = {
	// Relay activate time (each door): relayLoop() passes it to relayPulse()
	// when the door is opened. A pulse already running keeps the relock
	// deadline its esp_timer was armed with; if the new time is shorter the
	// loop's bookkeeping relocks earlier. Either way the door relocks no later
	// than the old time. The NVS boot copy (storeRelayBootFrom) is rewritten by
	// every save, so it stays in step.
	"hardware.rtime",
	"hardware.relay2.rtime",
	"hardware.relay3.rtime",
	"hardware.relay4.rtime",
	// Door names: text for the logs and MQTT messages (doorLabel()); the
	// Home Assistant discovery is published again after the apply.
	"hardware.doorname",
	"hardware.relay2.doorname",
	"hardware.relay3.doorname",
	"hardware.relay4.doorname",
	// Left-open alarm: DoorMonitor::update() takes it each pass. A door open
	// longer than a new, shorter limit raises the alarm at once, as it should.
	"hardware.maxOpenDoorTime",
	// PIN rules: ReaderSettings, built for every reader pass. Applied only
	// while no reader is part-way through a PIN (as Wi-Fi is re-enabled), so
	// a card swiped under "PIN required" is never let in without it.
	"hardware.requirepincodeafterrfid",
	"hardware.allowpincodeonly",
	// Card number format and parity: used when a completed Wiegand frame is
	// decoded (pollWiegandPort() under the port's spinlock); a frame is
	// decoded with one value or the other, never a mix. The ISR only counts bits.
	"hardware.useridstoragemode",
	"hardware.removeparitybits",
	// Which door a reader opens, and its in/out side (logged only): read in
	// the reader pass that decides.
	"hardware.reader1.door",
	"hardware.reader1.direction",
	"hardware.reader2.door",
	"hardware.reader2.direction",
	// Opening hours: read at each access decision.
	"general.openinghours",
	// Write the logs to flash: read at each log write (setlogging already
	// changes it at run time).
	"general.logging",
	// Time zone: TZ is set again with setenv()/tzset() on the loop task and
	// the local time recomputed. (The NTP server is not live: SNTP keeps a
	// pointer to the name and its restart from the loop task is not safe.)
	"ntp.tzinfo",
	// (The NTP interval is not live either: SNTP takes it before it starts.)
	// MQTT options that do not touch the connection: heartbeat interval (the
	// next beat is scheduled with it), events over MQTT, remote admin and door
	// commands (checked per message, on the loop task), card number in access
	// messages.
	"mqtt.syncrate",
	"mqtt.mqttlog",
	"mqtt.remoteadmin",
	"mqtt.doorcontrol",
	"mqtt.carduid",
	// Wi-Fi idle-off and its minutes: the idle timer (core/wifiidle.h) reads
	// them every loop() pass. Ticked, the count starts from the apply (it does
	// not run while unticked); unticked, it stops. Wi-Fi itself is not touched.
	"network.idleoff",
	"network.idlemins",
};

inline bool isLiveSetting(const std::string &key)
{
	for (const char *k : LIVE_SETTINGS)
		if (key == k)
			return true;
	return false;
}

// What a save changes.
struct SettingsChange
{
	bool restart = false;             // a changed key is not live (or nothing could be compared)
	std::string restartKey;           // the first such key, for the event log
	std::vector<std::string> changed; // every changed key, live or not, in document order
};

namespace detail
{
// A value as the UI's review compares it.
inline std::string liveText(JsonVariantConst v)
{
	if (v.is<bool>())
		return v.as<bool>() ? "1" : "0";
	if (v.is<const char *>())
		return v.as<const char *>();
	std::string out;
	serializeJson(v, out);
	return out;
}

inline void noteChange(SettingsChange &c, const std::string &key)
{
	c.changed.push_back(key);
	if (!c.restart && !isLiveSetting(key))
	{
		c.restart = true;
		c.restartKey = key;
	}
}

// Every leaf under v (v itself if it is not an object) is a change: present
// on one side only. An empty object has no leaves, as in the UI.
inline void allChanged(JsonVariantConst v, const std::string &key, SettingsChange &c)
{
	if (!v.is<JsonObjectConst>())
	{
		noteChange(c, key);
		return;
	}
	for (JsonPairConst kv : v.as<JsonObjectConst>())
		allChanged(kv.value(), key + "." + kv.key().c_str(), c);
}

inline void diff(JsonObjectConst a, JsonObjectConst b, const std::string &prefix, SettingsChange &c)
{
	for (JsonPairConst kv : a)
	{
		std::string key = prefix.empty() ? std::string(kv.key().c_str()) : prefix + "." + kv.key().c_str();
		if (prefix.empty() && key == "command")
			continue;
		JsonVariantConst va = kv.value(), vb = b[kv.key().c_str()];
		bool objA = va.is<JsonObjectConst>(), objB = vb.is<JsonObjectConst>();
		if (objA && objB)
			diff(va.as<JsonObjectConst>(), vb.as<JsonObjectConst>(), key, c);
		else if (!b.containsKey(kv.key().c_str()))
			allChanged(va, key, c);
		else if (objA || objB)
		{
			// an object on one side, a value on the other
			allChanged(va, key, c);
			allChanged(vb, key, c);
		}
		else if (liveText(va) != liveText(vb))
			noteChange(c, key);
	}
	for (JsonPairConst kv : b)
	{
		if (a.containsKey(kv.key().c_str()))
			continue;
		std::string key = prefix.empty() ? std::string(kv.key().c_str()) : prefix + "." + kv.key().c_str();
		if (prefix.empty() && key == "command")
			continue;
		allChanged(kv.value(), key, c);
	}
}
} // namespace detail

// before: the stored config.json the running settings were loaded from;
// after: the one just saved. No stored settings (null) always restarts.
inline SettingsChange compareSettings(JsonObjectConst before, JsonObjectConst after)
{
	SettingsChange c;
	if (before.isNull() || after.isNull())
	{
		c.restart = true;
		c.restartKey = "(no stored settings)";
		return c;
	}
	detail::diff(before, after, "", c);
	return c;
}

// Copies the live settings, and only those, from a parse of the saved
// config.json (from) into the running settings (to). Every field here
// belongs to a key in LIVE_SETTINGS; the tests check that copying a parse
// of a save that changes only live keys gives that parse exactly, and that
// one changing only restart keys leaves the running settings untouched.
// Fields the firmware changes at run time (readers[].enabled and pins,
// mqttTopic with its MAC suffix, the admin password) are never touched.
// Text is copied whole (memcpy of the buffer): the last byte of each is
// always NUL, so a reader on another task (MQTT discovery reads door names)
// can see mixed text for a moment but never runs off the end.
inline void copyLiveSettings(const Settings &from, Settings &to)
{
	for (int i = 0; i < MAX_NUM_RELAYS; i++)
	{
		to.activateTime[i] = from.activateTime[i];
		memcpy(to.doorName[i], from.doorName[i], sizeof(to.doorName[i]));
	}
	to.maxOpenDoorTime = from.maxOpenDoorTime;
	to.pinCodeRequested = from.pinCodeRequested;
	to.pinCodeOnly = from.pinCodeOnly;
	to.wiegandReadHex = from.wiegandReadHex;
	to.removeParityBits = from.removeParityBits;
	for (int i = 0; i < MAX_READERS; i++)
	{
		to.readers[i].door = from.readers[i].door;
		to.readers[i].direction = from.readers[i].direction;
	}
	memcpy(to.openingHours, from.openingHours, sizeof(to.openingHours));
	to.loggingEnabled = from.loggingEnabled;
	memcpy(to.tzInfo, from.tzInfo, sizeof(to.tzInfo));
	to.mqttInterval = from.mqttInterval;
	to.mqttEvents = from.mqttEvents;
	to.mqttRemoteAdmin = from.mqttRemoteAdmin;
	to.mqttDoorControl = from.mqttDoorControl;
	to.mqttCardUid = from.mqttCardUid;
	to.wifiIdleOff = from.wifiIdleOff;
	to.wifiIdleMinutes = from.wifiIdleMinutes;
}

// The changed keys as one line for the event log, cut to fit.
inline std::string changedList(const SettingsChange &c, size_t max = 300)
{
	std::string out;
	for (const std::string &k : c.changed)
	{
		if (out.size() + k.size() + 2 > max)
			return out + ", ...";
		out += (out.empty() ? "" : ", ") + k;
	}
	return out;
}

} // namespace core
