// Policy for an incoming configuration (WebSocket save, settings restore,
// MQTT updateconf), applied after masked secrets have been merged back.
//
// Shared: the firmware calls it (websocket.esp, config.esp), native tests run
// test/vectors/config-policy.json through it, and the UI test simulator runs
// the same vectors through its JavaScript copy (test/e2e/device-sim.mjs), so
// the two cannot drift apart unnoticed.
#pragma once

#include <ArduinoJson.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "magicnumbers.h"
#include "core/adminpass.h"
#include "core/jsonutil.h"
#include "core/pins.h"
#include "core/rtc.h"
#include "core/validate.h"
#include "core/wifiidle.h"

namespace core
{

// The GPIO rules of one chip: its usable pins.
struct PolicyBoard
{
	PinSet pins;
};

inline PolicyBoard policyBoardEsp32() { return {pinSetEsp32()}; }
inline PolicyBoard policyBoardEsp32s3() { return {pinSetEsp32s3()}; }

struct PolicyText
{
	char buf[96];
};

// Every GPIO field a configuration can set: it must be allowed on this chip
// (outputs may not use input-only pins) and no pin may be used twice. The
// RTC's pins (ntp.rtc, the Time page) count while an RTC is set.
inline const char *checkConfigPins(JsonObjectConst hw, JsonObjectConst ntp, const PolicyBoard &b, PolicyText &out)
{
	struct Field
	{
		const char *label;
		JsonVariantConst v;
		bool output;
		bool used;
	};
	// reader 1's pins count only for a Wiegand reader (a stored Wiegand +
	// RDM6300 loads as Wiegand; any other stored type leaves reader 1 off)
	int readerType = jsonInt(hw["readertype"], 0);
	bool wiegand1 = readerType == READER_WIEGAND || readerType == READER_WIEGAND_RDM6300;
	int relays = clampRelayCount(jsonInt(hw["numrelays"], 1), MAX_NUM_RELAYS);
	JsonObjectConst r1 = hw["reader1"];
	JsonObjectConst r2 = hw["reader2"];
	bool reader2 = !r2.isNull() && jsonInt(r2["enabled"], 0) == 1;
	JsonObjectConst rtc = ntp["rtc"];
	bool rtcOn = rtcTypeFrom(jsonInt(rtc["type"], RTC_NONE)) != RTC_NONE;
	Field fields[] = {
		{"Reader 1 D0", hw["wgd0pin"], false, wiegand1},
		{"Reader 1 D1", hw["wgd1pin"], false, wiegand1},
		{"Relay 1", hw["rpin"], true, true},
		{"Relay 2", hw["relay2"]["rpin"], true, relays >= 2},
		{"Relay 3", hw["relay3"]["rpin"], true, relays >= 3},
		{"Relay 4", hw["relay4"]["rpin"], true, relays >= 4},
		{"WiFi LED", hw["wifipin"], true, true},
		{"Door sensor", hw["doorstatpin"], true, true},
		{"Doorbell", hw["doorbellpin"], true, true},
		{"Open button", hw["openlockpin"], true, true},
		{"Denied LED", hw["accessdeniedpin"], true, true},
		{"Beeper", hw["beeperpin"], true, true},
		{"Waiting LED", hw["ledwaitingpin"], true, true},
		{"Reader 1 LED", r1["ledpin"], true, !r1.isNull()},
		{"Reader 1 buzzer", r1["beeperpin"], true, !r1.isNull()},
		{"Reader 2 D0", r2["wgd0pin"], false, reader2},
		{"Reader 2 D1", r2["wgd1pin"], false, reader2},
		{"Reader 2 LED", r2["ledpin"], true, reader2},
		{"Reader 2 buzzer", r2["beeperpin"], true, reader2},
		{"Door 2 sensor", hw["relay2"]["doorstatpin"], true, relays >= 2},
		{"Door 2 exit button", hw["relay2"]["openlockpin"], true, relays >= 2},
		{"Door 3 sensor", hw["relay3"]["doorstatpin"], true, relays >= 3},
		{"Door 3 exit button", hw["relay3"]["openlockpin"], true, relays >= 3},
		{"Door 4 sensor", hw["relay4"]["doorstatpin"], true, relays >= 4},
		{"Door 4 exit button", hw["relay4"]["openlockpin"], true, relays >= 4},
		{"RTC SDA", rtc["sdapin"], true, rtcOn}, // I2C lines are driven (open drain)
		{"RTC SCL", rtc["sclpin"], true, rtcOn},
	};
	const size_t n = sizeof(fields) / sizeof(fields[0]);
	int pins[n];
	for (size_t i = 0; i < n; i++)
		pins[i] = fields[i].used ? jsonInt(fields[i].v, 255) : 255;
	if (rtcOn) // the RTC's pins when none are stored: GPIO21/22
	{
		pins[n - 2] = jsonInt(rtc["sdapin"], RTC_DEFAULT_SDA);
		pins[n - 1] = jsonInt(rtc["sclpin"], RTC_DEFAULT_SCL);
	}
	for (size_t i = 0; i < n; i++)
	{
		if (pins[i] == 255)
			continue;
		if (!pinAllowed(b.pins, pins[i], fields[i].output))
		{
			snprintf(out.buf, sizeof(out.buf), "%s: GPIO %d cannot be used%s on this board",
					 fields[i].label, pins[i], fields[i].output ? " as an output" : "");
			return out.buf;
		}
		for (size_t j = 0; j < i; j++)
		{
			if (pins[j] == pins[i])
			{
				snprintf(out.buf, sizeof(out.buf), "GPIO %d is used twice: %s and %s", pins[i], fields[j].label, fields[i].label);
				return out.buf;
			}
		}
	}
	return nullptr;
}

// A 0/1 setting: missing (the default applies) or 0 or 1.
inline bool isZeroOrOne(JsonVariantConst v)
{
	if (v.isNull())
		return true;
	int n = jsonInt(v, -1);
	return n == 0 || n == 1;
}

struct PolicyResult
{
	const char *problem = nullptr; // NULL: acceptable; else a message for the user
	bool ignoredPassword = false; // the incoming settings carried another admin password; the current one was kept
};

// A host name: 1-32 letters, digits and hyphens (what http://<name>.local
// and DHCP take; the page used to only warn about a space). Empty: the
// default applies.
inline bool isValidHostname(const char *h)
{
	size_t n = strlen(h);
	if (n > 32)
		return false;
	for (const char *c = h; *c; c++)
		if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') || *c == '-'))
			return false;
	return true;
}

// currentHa1 / mustChange: the admin password in force (its Digest HA1,
// core/adminpass.h) and whether it is the factory one that must be changed.
inline PolicyResult applyConfigPolicy(JsonObject incoming, const PolicyBoard &b, const char *currentHa1, bool mustChange, PolicyText &out)
{
	PolicyResult r;
	if (!incoming.containsKey("general"))
		incoming.createNestedObject("general");
	// A settings save, restore or MQTT updateconf always keeps the admin
	// password in force. Only setpassword changes it, and that asks for the
	// current one: a browser left signed in must not be able to take the
	// device over by saving settings with a new password in them.
	if (mustChange)
	{
		r.problem = "Set an admin password first (Change Password)";
		return r;
	}
	const char *pass = incoming["general"]["pswd"];
	// "admin" is the UI's built-in default, sent by a browser that never saw
	// the stored password; the stored hash (a masked value merged back) or
	// the current password typed out is no change; anything else is worth a
	// warning
	r.ignoredPassword = pass != nullptr && !isDefaultAdminPassword(pass) && strcmp(pass, currentHa1) != 0 &&
						!adminPasswordMatches(pass, currentHa1);
	putAdminPassword(incoming["general"], currentHa1, false);
	// Every settings file has these: without hardware the device ran with
	// no doors and no readers (ledger H28.8). An MQTT updateconf gets the
	// stored ones back before this (keepRemoteAdminKept).
	if (!incoming["network"].is<JsonObject>() || !incoming["hardware"].is<JsonObject>())
	{
		r.problem = "The settings have no network or hardware section";
		return r;
	}
	// An AP passphrase of 1-7 characters would silently give an OPEN network.
	JsonObject network = incoming["network"];
	if (!network.isNull() && network["wmode"] == 1)
	{
		const char *ssid = network["ssid"] | "";
		if (*ssid == '\0')
		{
			r.problem = "Access point SSID must not be empty";
			return r;
		}
		if (!isValidApPassword(network["pswd"] | ""))
		{
			r.problem = "Access point password must be empty (open) or 8-63 characters";
			return r;
		}
	}
	if (!network.isNull())
	{
		// longer ones were stored and then dropped at the next start (the
		// hotspot kept its old name)
		if (strlen(network["ssid"] | "") > 32)
		{
			r.problem = "Wi-Fi SSID must be at most 32 characters";
			return r;
		}
		if (strlen(network["pswd"] | "") > 64)
		{
			r.problem = "Wi-Fi password must be at most 64 characters";
			return r;
		}
		if (!isZeroOrOne(network["idleoff"]))
		{
			r.problem = "Turn Wi-Fi off when nobody is connected must be on or off";
			return r;
		}
		JsonVariantConst minutes = network["idlemins"];
		if (!minutes.isNull() && !isValidIdleMinutes(jsonInt(minutes, -1)))
		{
			r.problem = "Turn Wi-Fi off after must be 1-1440 minutes";
			return r;
		}
	}
	JsonObject hardware = incoming["hardware"];
	if (!hardware.isNull())
	{
		if (hardware.containsKey("numrelays"))
			hardware["numrelays"] = clampRelayCount(jsonInt(hardware["numrelays"], 1), MAX_NUM_RELAYS);
		int relays = clampRelayCount(jsonInt(hardware["numrelays"], 1), MAX_NUM_RELAYS);
		int maxOpen = jsonInt(hardware["maxOpenDoorTime"], 0);
		if (maxOpen < 0 || maxOpen > 600)
		{
			r.problem = "Maximum open time must be 0-600 seconds";
			return r;
		}
		for (int i = 0; i < relays; i++)
		{
			const char key[] = {'r', 'e', 'l', 'a', 'y', (char)('1' + i), '\0'}; // i < MAX_NUM_RELAYS (4)
			JsonObjectConst relay = i == 0 ? JsonObjectConst(hardware) : hardware[key].as<JsonObjectConst>();
			// Settings::doorName holds 63 bytes: a longer one was cut short
			if (strlen(relay["doorname"] | "") > 63)
			{
				r.problem = "Door names must be at most 63 characters";
				return r;
			}
			JsonVariantConst rtime = relay["rtime"];
			if (!rtime.isNull() && !isValidRelayTime(jsonInt(rtime, 400)))
			{
				r.problem = "Relay activate time must be 100-30000 ms";
				return r;
			}
			// 0/1 only: any other relay type broke the lock-state reads
			// (every opening logged as forced), any other lock type never
			// fired the relay
			if (!isZeroOrOne(relay["rtype"]))
			{
				r.problem = "Relay type must be Active High or Active Low";
				return r;
			}
			if (!isZeroOrOne(relay["rhold"]))
			{
				r.problem = "When the relay is on, the door must be Unlocked or Locked";
				return r;
			}
			if (!isZeroOrOne(relay["ltype"]))
			{
				r.problem = "Lock type must be Momentary or Continuous";
				return r;
			}
		}
		// only Wiegand readers are left: an MFRC522, PN532 or RDM6300 (also a
		// restored old backup) is refused here, not stored with reader 1 off
		if (jsonInt(hardware["readertype"], 0) != READER_WIEGAND)
		{
			r.problem = "Reader 1 must be a Wiegand reader (MFRC522, PN532 and RDM6300 are no longer supported)";
			return r;
		}
		JsonObject r1 = hardware["reader1"];
		if (!r1.isNull())
		{
			int door = jsonInt(r1["door"], -1);
			if (door < -1 || door >= relays)
			{
				r.problem = "Reader 1 has an invalid door binding";
				return r;
			}
		}
		JsonObject r2 = hardware["reader2"];
		if (!r2.isNull() && jsonInt(r2["enabled"], 0) == 1)
		{
			int door = jsonInt(r2["door"], -2);
			if (door < 0 || door >= relays)
			{
				r.problem = "Reader 2 must be bound to a configured door";
				return r;
			}
		}
	}
	JsonObjectConst ntp = incoming["ntp"];
	JsonVariantConst interval = ntp["interval"];
	if (!interval.isNull())
	{
		int minutes = jsonInt(interval, -1);
		if (minutes < 0 || minutes > 10080)
		{
			r.problem = "NTP sync interval must be 0-10080 minutes";
			return r;
		}
	}
	JsonVariantConst rtcType = ntp["rtc"]["type"];
	if (!rtcType.isNull() && rtcTypeFrom(jsonInt(rtcType, -1)) != jsonInt(rtcType, -1))
	{
		r.problem = "RTC type must be None, DS3231 or DS1307";
		return r;
	}
	// the pins of the hardware and the RTC together
	if (!hardware.isNull() || !ntp.isNull())
	{
		const char *pinProblem = checkConfigPins(hardware, ntp, b, out);
		if (pinProblem)
		{
			r.problem = pinProblem;
			return r;
		}
	}
	JsonObjectConst mqtt = incoming["mqtt"];
	if (!mqtt.isNull() && !isZeroOrOne(mqtt["doorcontrol"]))
	{
		r.problem = "MQTT door control must be Enabled or Disabled";
		return r;
	}
	if (!mqtt.isNull() && !mqtt["port"].isNull())
	{
		int port = jsonInt(mqtt["port"], -1);
		if (port < 1 || port > 65535)
		{
			r.problem = "MQTT port must be 1-65535";
			return r;
		}
	}
	if (!mqtt.isNull() && !mqtt["carduid"].isNull())
	{
		int n = jsonInt(mqtt["carduid"], -1);
		if (n < 0 || n > 2)
		{
			r.problem = "Card number in MQTT must be Off, Last 4 or Full";
			return r;
		}
	}
	if (!isValidHostname(incoming["general"]["hostnm"] | ""))
	{
		r.problem = "Host name must be at most 32 letters, digits and hyphens";
		return r;
	}
	JsonArray hours = incoming["general"]["openinghours"].as<JsonArray>();
	if (hours.isNull())
	{
		r.problem = "Opening hours are required";
		return r;
	}
	if (hours.size() != 7)
	{
		r.problem = "Opening hours must contain seven days";
		return r;
	}
	for (JsonVariant day : hours)
	{
		if (!isValidOpeningHoursDay(day.as<const char *>()))
		{
			r.problem = "Each opening-hours day must contain exactly 24 zero/one values";
			return r;
		}
	}
	return r;
}

// What MQTT remote admin (updateconf) cannot change (option B,
// 2026-10-15): with it someone who can publish to the command topic could
// otherwise turn on door control, move the device to their own broker or
// topic, change the Wi-Fi or admin password, turn off the PIN requirement or
// rewire relays, locks, readers and the RTC. These keep their stored values; the rest
// of the settings (names, opening hours, time, logging, the other MQTT
// options) remote admin still changes. A path naming an object (the whole
// network section, a reader block) covers every key in it.
static const char *const REMOTE_ADMIN_KEPT[] = {
	"network",
	"general.pswd",
	"mqtt.enabled", "mqtt.host", "mqtt.port", "mqtt.user", "mqtt.pswd", "mqtt.topic", "mqtt.autotopic",
	"mqtt.remoteadmin", "mqtt.doorcontrol",
	"hardware.requirepincodeafterrfid", "hardware.allowpincodeonly",
	"hardware.readertype", "hardware.numrelays", "hardware.maxOpenDoorTime",
	"hardware.wgd0pin", "hardware.wgd1pin",
	"hardware.wifipin", "hardware.doorstatpin", "hardware.doorbellpin", "hardware.openlockpin",
	"hardware.accessdeniedpin", "hardware.beeperpin", "hardware.ledwaitingpin",
	"hardware.rpin", "hardware.rtype", "hardware.rhold", "hardware.ltype", "hardware.rtime",
	"hardware.relay2.rpin", "hardware.relay2.rtype", "hardware.relay2.rhold", "hardware.relay2.ltype", "hardware.relay2.rtime",
	"hardware.relay2.doorstatpin", "hardware.relay2.openlockpin",
	"hardware.relay3.rpin", "hardware.relay3.rtype", "hardware.relay3.rhold", "hardware.relay3.ltype", "hardware.relay3.rtime",
	"hardware.relay3.doorstatpin", "hardware.relay3.openlockpin",
	"hardware.relay4.rpin", "hardware.relay4.rtype", "hardware.relay4.rhold", "hardware.relay4.ltype", "hardware.relay4.rtime",
	"hardware.relay4.doorstatpin", "hardware.relay4.openlockpin",
	"hardware.reader1", "hardware.reader2",
	"ntp.rtc",
};

namespace detail
{
inline std::string jsonText(JsonVariantConst v)
{
	std::string out;
	if (!v.isNull())
		serializeJson(v, out);
	return out;
}

// incoming[key] becomes stored[key] (removed if not stored). Sent and
// different: listed as ignored. Not sent: restored without a mention.
// key is a std::string, which ArduinoJson copies (a const char * key is
// kept as a pointer).
inline void keepStoredKey(JsonObject in, JsonObjectConst st, const std::string &key, const std::string &path, std::vector<std::string> &ignored)
{
	JsonVariantConst was = st.isNull() ? JsonVariantConst() : st[key];
	if (in.containsKey(key) && jsonText(in[key]) != jsonText(was))
		ignored.push_back(path);
	if (was.isNull())
		in.remove(key);
	else
		in[key].set(was); // copied: strings included
}
} // namespace detail

// Applies REMOTE_ADMIN_KEPT to an MQTT updateconf: `incoming` (secrets
// already merged back) keeps the values of `stored` for those keys and
// lists in `ignored` each key it tried to change ("network.ssid",
// "mqtt.doorcontrol", ...). `stored` must be the settings in force: with
// none (empty) every protected key would be dropped, so the caller refuses
// instead.
inline void keepRemoteAdminKept(JsonObject incoming, JsonObjectConst stored, std::vector<std::string> &ignored)
{
	for (const char *path : REMOTE_ADMIN_KEPT)
	{
		// walk to the parent object of the last key, in both documents
		JsonObject in = incoming;
		JsonObjectConst st = stored;
		std::string p(path);
		size_t start = 0, dot;
		while ((dot = p.find('.', start)) != std::string::npos)
		{
			std::string part = p.substr(start, dot - start);
			st = st.isNull() ? JsonObjectConst() : st[part].as<JsonObjectConst>();
			JsonObject next = in[part];
			if (next.isNull())
			{
				if (st.isNull())
				{
					in = JsonObject();
					break; // in neither: nothing to keep
				}
				// a section the update left out (or sent as a non-object)
				if (in.containsKey(part))
					ignored.push_back(p.substr(0, dot));
				next = in.createNestedObject(part);
			}
			in = next;
			start = dot + 1;
		}
		if (in.isNull())
			continue;
		std::string key = p.substr(start);
		JsonObjectConst stObj = st.isNull() ? JsonObjectConst() : st[key].as<JsonObjectConst>();
		JsonObject inObj = in[key];
		if (!stObj.isNull() && !inObj.isNull())
		{
			// an object (network, a reader block): name each key it changed
			for (JsonPairConst kv : stObj)
				if (inObj.containsKey(kv.key()) && detail::jsonText(inObj[kv.key()]) != detail::jsonText(kv.value()))
					ignored.push_back(p + "." + kv.key().c_str());
			for (JsonPair kv : inObj)
				if (!stObj.containsKey(kv.key()))
					ignored.push_back(p + "." + kv.key().c_str());
			in[key].set(stObj);
			continue;
		}
		detail::keepStoredKey(in, st, key, p, ignored);
	}
}

} // namespace core
