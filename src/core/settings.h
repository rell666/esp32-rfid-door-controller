// The device settings (config.json) as a plain struct, and the parser that
// fills it. Pure, so loading is unit-tested on the host: every vector the
// save policy accepts must load (test/vectors/config-policy.json).
//
// Upstream kept the strings as strdup()'d char pointers (NULL meaning "not
// set") and parsed and applied in one 424-line function. Here every string
// has a fixed buffer and a default, and config.esp only applies the result
// to the hardware.
#pragma once

#include <ArduinoJson.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "magicnumbers.h"
#include "core/adminpass.h"
#include "core/configpolicy.h"
#include "core/jsonutil.h"
#include "core/pins.h"
#include "core/relays.h"
#include "core/secrets.h"
#include "core/validate.h"
#include "core/wifiidle.h"

namespace core
{

// A reader's side of its door, for one door with a reader each side.
enum : uint8_t
{
	READER_DIR_NONE = 0,
	READER_DIR_IN = 1,
	READER_DIR_OUT = 2,
};

// The SNTP sync interval for ntp.interval (minutes), in ms: at least 15 s
// (SNTP's minimum), at most 7 days (the page's limit); 0 = not set: 0 here,
// and the firmware keeps the SDK's default (3 hours). Stored and never
// read before 2026-10-16 (1.5.0 and earlier).
inline uint32_t ntpSyncIntervalMs(int minutes)
{
	if (minutes <= 0)
		return 0;
	if (minutes > 10080)
		minutes = 10080;
	uint32_t ms = (uint32_t)minutes * 60000UL;
	return ms < 15000UL ? 15000UL : ms;
}

inline const char *readerDirName(uint8_t dir)
{
	return dir == READER_DIR_IN ? "in" : dir == READER_DIR_OUT ? "out" : nullptr;
}

struct ReaderConfig
{
	bool enabled = false;       // set by the firmware once the reader is running
	int door = -1;              // relay index it opens; -1 = every permitted door (upstream behaviour; reader 1 defaults to door 1 with two or more doors)
	uint8_t d0 = 255, d1 = 255; // Wiegand data lines
	uint8_t ledPin = 255;       // reader's LED control line
	uint8_t beeperPin = 255;    // reader's buzzer control line
	bool feedbackActiveHigh = true; // true: driven through a transistor; false: pulled low directly (diode)
	uint8_t direction = 0;      // READER_DIR_*: which way a person goes through the door; logged, not enforced
};

struct Ip4
{
	uint8_t b[4] = {0, 0, 0, 0};
	bool parse(const char *s)
	{
		if (s == nullptr)
			return false;
		unsigned v[4];
		char tail;
		if (sscanf(s, "%u.%u.%u.%u%c", &v[0], &v[1], &v[2], &v[3], &tail) != 4)
			return false;
		for (int i = 0; i < 4; i++)
		{
			if (v[i] > 255)
				return false;
			b[i] = (uint8_t)v[i];
		}
		return true;
	}
};

// Copies s into a fixed buffer; false (and an empty string) if it does not fit.
template <size_t N>
bool setText(char (&dst)[N], const char *s)
{
	if (s == nullptr)
		s = "";
	size_t n = strlen(s);
	if (n >= N)
	{
		dst[0] = '\0';
		return false;
	}
	memcpy(dst, s, n + 1);
	return true;
}

// Display-only text is cut to fit instead.
template <size_t N>
void setTextCut(char (&dst)[N], const char *s)
{
	if (s == nullptr)
		s = "";
	size_t n = strlen(s);
	if (n >= N)
		n = N - 1;
	memcpy(dst, s, n);
	dst[n] = '\0';
}

struct Settings
{
	ReaderConfig readers[MAX_READERS];
	int readertype = READER_NONE; // reader 1: READER_WIEGAND, or READER_NONE (off: a type no longer supported)
	bool pinCodeRequested = false;
	bool pinCodeOnly = false;
	bool wiegandReadHex = true;
	bool removeParityBits = true;

	// 255 = no relay: nothing is driven until a saved configuration names a
	// pin (an unset 0 would toggle GPIO0, the boot strap)
	int numRelays = 1;
	int relayPin[MAX_NUM_RELAYS] = {255, 255, 255, 255};
	// hardware.rtype (1: the relay switches on with HIGH) is read into
	// relayUnlock below. hardware.rhold: 0 = relay on -> door unlocked (strike, or maglock on NC;
	// stored configs without the key), 1 = relay on -> door locked (maglock
	// on NO: released when the controller fails or loses power)
	int relayHold[MAX_NUM_RELAYS] = {0, 0, 0, 0};
	// the pin level that unlocks the door: rtype XOR relayHold. Everything
	// that drives or reads a relay uses this one (relayBankOf).
	int relayUnlock[MAX_NUM_RELAYS] = {1, 1, 1, 1};
	int lockType[MAX_NUM_RELAYS] = {LOCKTYPE_MOMENTARY, LOCKTYPE_MOMENTARY, LOCKTYPE_MOMENTARY, LOCKTYPE_MOMENTARY};
	unsigned long activateTime[MAX_NUM_RELAYS] = {400, 400, 400, 400};
	char doorName[MAX_NUM_RELAYS][64] = {};
	// per door: its contact and its exit button (door 1: hardware.doorstatpin
	// and .openlockpin, as upstream; doors 2-4: in relay2..relay4)
	uint8_t doorPin[MAX_NUM_RELAYS] = {255, 255, 255, 255};
	uint8_t exitPin[MAX_NUM_RELAYS] = {255, 255, 255, 255};

	uint8_t accessdeniedpin = 255;
	uint8_t beeperpin = 255;
	uint8_t doorbellpin = 255;
	uint8_t ledwaitingpin = 255;
	uint8_t wifipin = 255;
	uint16_t maxOpenDoorTime = 0; // seconds; 0 = no alarm

	// network
	bool accessPointMode = false; // configured mode (the fallback AP is separate)
	char ssid[33] = "";
	char wifiPassword[65] = "";
	uint8_t bssid[6] = {0, 0, 0, 0, 0, 0};
	bool networkHidden = false;
	bool fallbackMode = false;
	char fallbackPassword[64] = ""; // the fallback hotspot's (8-63; none = no fallback hotspot)
	bool dhcpEnabled = true;
	Ip4 ipAddress, subnetIp, gatewayIp, dnsIp;
	Ip4 accessPointIp, accessPointSubnetIp;
	bool wifiIdleOff = false;                        // network.idleoff: Wi-Fi off once nobody is connected (core/wifiidle.h)
	int wifiIdleMinutes = WIFI_IDLE_MINUTES_DEFAULT; // network.idlemins: for this long

	// general
	char deviceHostname[33] = "ironframe-rfid";
	// the admin password's Digest HA1 (core/adminpass.h), never the password
	char adminHa1[HA1_HEX + 1] = "a74c19259b8c3e6262ddca95dd114730"; // FACTORY_ADMIN_HA1
	bool adminMustChange = true; // the factory password is in force: it must be changed first
	unsigned long autoRestartIntervalSeconds = 0;
	bool loggingEnabled = true; // write the event and access logs to flash (Logs > Log Settings)
	char openingHours[7][25] = {};

	// time
	char ntpServer[64] = "pool.ntp.org";
	int ntpInterval = 0;
	char tzInfo[64] = "";
	int rtcType = RTC_NONE; // ntp.rtc.type: RTC_DS3231, RTC_DS1307 (core/rtc.h); read at start only
	uint8_t rtcSda = RTC_DEFAULT_SDA;
	uint8_t rtcScl = RTC_DEFAULT_SCL;

	// MQTT
	bool mqttEnabled = false;
	char mqttHost[128] = "";
	int mqttPort = 1883;
	char mqttUser[64] = "";
	char mqttPass[128] = "";
	char mqttTopic[128] = "";
	bool mqttAutoTopic = false;
	unsigned long mqttInterval = 180; // heartbeat, seconds
	bool mqttEvents = false;      // events over MQTT instead of the file log
	bool mqttHA = false;          // simple topics and Home Assistant discovery
	bool mqttRemoteAdmin = false; // user/config management commands over MQTT
	bool mqttDoorControl = false; // open/opendoor/close over MQTT
	int mqttCardUid = MQTT_UID_LAST4; // card number in access messages (core::mqttAccessUid)

	bool present = false; // a configuration was loaded
};

// What parseSettings() reports besides the settings.
struct SettingsLoad
{
	const char *problem = nullptr;     // non-null: refused; the device stays fail-secure (configDamaged)
	std::vector<std::string> warnings; // values ignored or clamped, for the event log
	bool passwordMigrated = false;     // the admin password was stored in clear: rewrite config.json with its hash
	bool wifiTimeoutMigrated = false;  // a WiFi Timeout (network.offtime) became idle-off: rewrite config.json (putWifiIdle)
	unsigned long migratedOfftime = 0; // the offtime it was, seconds (0: it was off)
};

namespace detail
{
// A GPIO from the config; one this chip cannot use is ignored (255) with a
// warning instead of being driven: on the flash pins that would crash the
// chip, and on the original ESP32 a Wiegand line on GPIO12 stops it booting.
inline uint8_t pinFrom(JsonVariantConst v, const char *name, bool output, const PinSet &pins, SettingsLoad &load)
{
	int pin = jsonInt(v, 255);
	if (pin == 255)
		return 255;
	if (!pinAllowed(pins, pin, output))
	{
		load.warnings.push_back(std::string("Ignoring unusable GPIO in config: ") + name + "=" + std::to_string(pin));
		return 255;
	}
	return (uint8_t)pin;
}

// Relay hold time, clamped to 100-30000 ms: a config saved before the range
// was enforced may hold anything (a negative value never relocked).
inline unsigned long relayTimeFrom(JsonVariantConst v, int relay, SettingsLoad &load)
{
	int ms = jsonInt(v, 400);
	if (!isValidRelayTime(ms))
	{
		int clamped = clampRelayTime(ms);
		load.warnings.push_back("Relay time out of range, clamped: relay " + std::to_string(relay + 1) + ": " + std::to_string(ms) + " ms -> " + std::to_string(clamped) + " ms");
		ms = clamped;
	}
	return (unsigned long)ms;
}

// reader: 1 or 2, for the warning. A door that does not exist (a hand-edited
// file, or fewer doors than before) leaves the reader unbound (-2): it
// refuses every card as not valid, and said nothing about why (review 8
// V14). Warned at start-up; Status marks it (wiegand[].nodoor).
inline void readerOptions(ReaderConfig &rc, JsonObjectConst src, int defaultDoor, bool allowAll, int numRelays, const PinSet &pins, SettingsLoad &load, int reader)
{
	int door = src.isNull() ? defaultDoor : jsonInt(src["door"], defaultDoor);
	rc.door = (door >= 0 && door < numRelays) || (allowAll && door == -1) ? door : -2;
	if (rc.door == -2)
		load.warnings.push_back("Reader " + std::to_string(reader) + " is set to door " + std::to_string(door + 1) + ", which does not exist (" + std::to_string(numRelays) +
								(numRelays == 1 ? " door" : " doors") + "): it refuses every card until its door is set under Doors & Readers");
	if (!src.isNull())
	{
		rc.ledPin = pinFrom(src["ledpin"], "reader ledpin", true, pins, load);
		rc.beeperPin = pinFrom(src["beeperpin"], "reader beeperpin", true, pins, load);
		rc.feedbackActiveHigh = jsonInt(src["feedbackactivehigh"], 1) != 0;
		int dir = jsonInt(src["direction"], READER_DIR_NONE);
		rc.direction = (dir == READER_DIR_IN || dir == READER_DIR_OUT) ? (uint8_t)dir : (uint8_t)READER_DIR_NONE;
	}
}

inline void parseBssid(const char *s, uint8_t out[6])
{
	for (int i = 0; i < 6 && s != nullptr && *s; i++)
	{
		out[i] = (uint8_t)strtoul(s, nullptr, 16);
		s = strchr(s, ':');
		if (s != nullptr)
			s++;
	}
}

// Upstream stored a numeric UTC offset; POSIX TZ signs are inverted.
inline void legacyTimezone(float tz, char (&out)[64])
{
	if (tz > 0)
		snprintf(out, sizeof(out), "UTC-%.2f", tz);
	else if (tz < 0)
		snprintf(out, sizeof(out), "UTC+%.2f", -tz);
	else
		snprintf(out, sizeof(out), "UTC");
}
} // namespace detail

// The relay arrays of a Settings, as the relay code reads them.
inline RelayBankView relayBankOf(const Settings &s)
{
	return RelayBankView{s.relayPin, s.relayUnlock, s.lockType, s.activateTime, s.numRelays};
}

// The idle-off keys in place of a stored WiFi Timeout (config.esp, once,
// when parseSettings set wifiTimeoutMigrated).
inline void putWifiIdle(JsonObject network, const Settings &cfg)
{
	network.remove("offtime");
	network["idleoff"] = cfg.wifiIdleOff ? 1 : 0;
	network["idlemins"] = cfg.wifiIdleMinutes;
}

// Parses config.json. The refusals are the save policy's (pins, access
// point, opening hours), applied again at load: a file written by an older
// firmware, edited by hand or damaged must not drive the wrong pins.
inline SettingsLoad parseSettings(JsonObjectConst root, const PolicyBoard &board, Settings &cfg)
{
	using namespace detail;
	SettingsLoad load;
	cfg = Settings();
	JsonObjectConst network = root["network"];
	JsonObjectConst hardware = root["hardware"];
	JsonObjectConst general = root["general"];
	JsonObjectConst mqtt = root["mqtt"];
	JsonObjectConst ntp = root["ntp"];
	const PinSet &pins = board.pins;

	PolicyText text;
	if (const char *pinProblem = checkConfigPins(hardware, ntp, board, text))
	{
		load.warnings.push_back(pinProblem);
		load.problem = "Unsafe GPIO configuration refused";
		return load;
	}
	if (network["wmode"] == 1)
	{
		const char *ssid = network["ssid"] | "";
		if (*ssid == '\0' || !isValidApPassword(network["pswd"] | ""))
		{
			load.problem = "Unsafe access-point configuration refused";
			return load;
		}
	}
	JsonArrayConst hours = general["openinghours"].as<JsonArrayConst>();
	if (hours.isNull() || hours.size() != 7)
	{
		load.problem = "Invalid opening-hours configuration refused";
		return load;
	}
	for (JsonVariantConst day : hours)
		if (!isValidOpeningHoursDay(day.as<const char *>()))
		{
			load.problem = "Invalid opening-hours configuration refused";
			return load;
		}
	for (int d = 0; d < 7; d++)
		setText(cfg.openingHours[d], hours[d].as<const char *>());

	// hardware
	if (hardware.containsKey("wifipin"))
		cfg.wifipin = pinFrom(hardware["wifipin"], "wifipin", true, pins, load);
	if (hardware.containsKey("maxOpenDoorTime"))
	{
		int seconds = jsonInt(hardware["maxOpenDoorTime"], 0);
		cfg.maxOpenDoorTime = (seconds >= 0 && seconds <= 600) ? (uint16_t)seconds : 0;
	}
	if (hardware.containsKey("doorbellpin"))
		cfg.doorbellpin = pinFrom(hardware["doorbellpin"], "doorbellpin", true, pins, load);
	if (hardware.containsKey("accessdeniedpin"))
		cfg.accessdeniedpin = pinFrom(hardware["accessdeniedpin"], "accessdeniedpin", true, pins, load);
	if (hardware.containsKey("beeperpin"))
		cfg.beeperpin = pinFrom(hardware["beeperpin"], "beeperpin", true, pins, load);
	if (hardware.containsKey("ledwaitingpin"))
		cfg.ledwaitingpin = pinFrom(hardware["ledwaitingpin"], "ledwaitingpin", true, pins, load);
	// clamp: the relay arrays hold MAX_NUM_RELAYS entries
	cfg.numRelays = hardware.containsKey("numrelays") ? clampRelayCount(jsonInt(hardware["numrelays"], 1), MAX_NUM_RELAYS) : 1;

	// Only Wiegand readers are left (2026-10-16). A stored MFRC522, PN532 or
	// RDM6300 (upstream: 0 when missing) leaves reader 1 off with a warning:
	// refusing the settings would fail secure (Wi-Fi off, doors shut). Wiegand +
	// RDM6300 keeps its Wiegand reader.
	int storedType = jsonInt(hardware["readertype"], 0);
	cfg.readertype = storedType == READER_WIEGAND || storedType == READER_WIEGAND_RDM6300 ? READER_WIEGAND : READER_NONE;
	if (storedType != READER_WIEGAND)
		load.warnings.push_back(cfg.readertype == READER_WIEGAND
			? std::string("Reader 1 type Wiegand + RDM6300: the RDM6300 is no longer supported, the Wiegand reader is used")
			: "Reader 1 type " + std::to_string(storedType) + " is no longer supported (only Wiegand): reader 1 is off until it is set up as a Wiegand reader");
	// reader 1: a new or missing door binding is door 1 when there are two or
	// more doors (it was upstream's "every permitted door", which a stored -1
	// still is); with one door it stays -1
	readerOptions(cfg.readers[0], hardware["reader1"], cfg.numRelays > 1 ? 0 : -1, true, cfg.numRelays, pins, load, 1);
	if (cfg.readertype == READER_WIEGAND)
	{
		cfg.readers[0].d0 = pinFrom(hardware["wgd0pin"], "wgd0pin", false, pins, load);
		cfg.readers[0].d1 = pinFrom(hardware["wgd1pin"], "wgd1pin", false, pins, load);
		cfg.pinCodeRequested = jsonInt(hardware["requirepincodeafterrfid"], 0) != 0;
		cfg.pinCodeOnly = jsonInt(hardware["allowpincodeonly"], 0) != 0;
		cfg.removeParityBits = jsonInt(hardware["removeparitybits"], 1) != 0;
		if (hardware.containsKey("useridstoragemode"))
			cfg.wiegandReadHex = hardware["useridstoragemode"] == "hexadecimal";
	}

	// reader 2: a second Wiegand reader, by default for the second door
	JsonObjectConst reader2 = hardware["reader2"];
	if (!reader2.isNull() && jsonInt(reader2["enabled"], 0) == 1)
	{
		readerOptions(cfg.readers[1], reader2, 1, false, cfg.numRelays, pins, load, 2);
		cfg.readers[1].d0 = pinFrom(reader2["wgd0pin"], "reader2 wgd0pin", false, pins, load);
		cfg.readers[1].d1 = pinFrom(reader2["wgd1pin"], "reader2 wgd1pin", false, pins, load);
		if (cfg.readers[1].d0 == 255 || cfg.readers[1].d1 == 255)
			load.warnings.push_back("Reader 2 enabled but its D0/D1 pins are not usable");
	}

	// relays: 1 in the hardware object itself, 2-4 in relay2..relay4. (The
	// upstream UI stored these as strings, "16", which ArduinoJson 6 reads as
	// 0: the second door's relay ended up on GPIO0.)
	for (int i = 0; i < cfg.numRelays; i++)
	{
		char key[] = {'r', 'e', 'l', 'a', 'y', (char)('1' + i), '\0'};
		JsonObjectConst relay = i == 0 ? hardware : hardware[key].as<JsonObjectConst>();
		cfg.activateTime[i] = relayTimeFrom(relay["rtime"], i, load);
		cfg.lockType[i] = jsonInt(relay["ltype"], LOCKTYPE_MOMENTARY);
		if (cfg.lockType[i] != LOCKTYPE_MOMENTARY && cfg.lockType[i] != LOCKTYPE_CONTINUOUS)
		{
			// the relay loop drives neither kind: it never fired. Momentary relocks.
			load.warnings.push_back("Lock type out of range, momentary used: relay " + std::to_string(i + 1) + ": " + std::to_string(cfg.lockType[i]));
			cfg.lockType[i] = LOCKTYPE_MOMENTARY;
		}
		int rtype = jsonInt(relay["rtype"], 1);
		if (rtype != 0 && rtype != 1)
		{
			// the relays were always driven as active high for any non-zero value
			load.warnings.push_back("Relay type out of range, active high used: relay " + std::to_string(i + 1) + ": " + std::to_string(rtype));
			rtype = 1;
		}
		// missing (settings from before 1.7): 0, the way the relay always worked
		cfg.relayHold[i] = jsonInt(relay["rhold"], 0);
		if (cfg.relayHold[i] != 0 && cfg.relayHold[i] != 1)
		{
			load.warnings.push_back("Relay on = door unlocked used (rhold out of range): relay " + std::to_string(i + 1) + ": " + std::to_string(cfg.relayHold[i]));
			cfg.relayHold[i] = 0;
		}
		cfg.relayUnlock[i] = rtype ^ cfg.relayHold[i];
		cfg.relayPin[i] = pinFrom(relay["rpin"], "rpin", true, pins, load);
		setTextCut(cfg.doorName[i], relay["doorname"] | "");
		cfg.doorPin[i] = pinFrom(relay["doorstatpin"], "doorstatpin", true, pins, load);
		cfg.exitPin[i] = pinFrom(relay["openlockpin"], "openlockpin", true, pins, load);
	}

	// network
	cfg.fallbackMode = jsonInt(network["fallbackmode"], 0) == 1; // older UIs saved "1"
	if (!setText(cfg.fallbackPassword, network["fallbackpswd"] | ""))
		load.warnings.push_back("Fallback hotspot password longer than 63 characters ignored");
	if (network.containsKey("offtime") && !network.containsKey("idleoff"))
	{
		// WiFi Timeout (seconds of router uptime, until 1.7): ticked, with its
		// time in minutes rounded up; config.esp rewrites the file once
		load.wifiTimeoutMigrated = true;
		load.migratedOfftime = network["offtime"] | 0UL;
		int minutes = idleMinutesFromOfftime((uint32_t)load.migratedOfftime);
		cfg.wifiIdleOff = minutes > 0;
		if (minutes > 0)
			cfg.wifiIdleMinutes = minutes;
	}
	else
	{
		cfg.wifiIdleOff = jsonInt(network["idleoff"], 0) == 1;
		int minutes = jsonInt(network["idlemins"], WIFI_IDLE_MINUTES_DEFAULT);
		if (!isValidIdleMinutes(minutes))
		{
			load.warnings.push_back("Turn Wi-Fi off after " + std::to_string(minutes) + " minutes is out of range (1-1440): 15 used");
			minutes = WIFI_IDLE_MINUTES_DEFAULT;
		}
		cfg.wifiIdleMinutes = minutes;
	}
	parseBssid(network["bssid"] | "", cfg.bssid);
	if (!setText(cfg.ssid, network["ssid"] | ""))
		load.warnings.push_back("Wi-Fi SSID longer than 32 characters ignored");
	if (!setText(cfg.wifiPassword, network["pswd"] | ""))
		load.warnings.push_back("Wi-Fi password longer than 64 characters ignored");
	cfg.accessPointMode = network["wmode"] == 1;
	cfg.networkHidden = network["hide"] == 1;
	cfg.dhcpEnabled = network["dhcp"] == 1;
	cfg.ipAddress.parse(network["ip"] | "");
	cfg.subnetIp.parse(network["subnet"] | "");
	cfg.gatewayIp.parse(network["gateway"] | "");
	cfg.dnsIp.parse(network["dns"] | "");
	if (!cfg.accessPointIp.parse(network["apip"] | ""))
		cfg.accessPointIp.parse("192.168.4.1");
	if (!cfg.accessPointSubnetIp.parse(network["apsubnet"] | ""))
		cfg.accessPointSubnetIp.parse("255.255.255.0");

	// general
	const char *host = general["hostnm"] | "";
	setTextCut(cfg.deviceHostname, *host ? host : "ironframe-rfid");
	AdminPassword admin = storedAdminPassword(general);
	strcpy(cfg.adminHa1, admin.ha1);
	cfg.adminMustChange = admin.mustChange;
	load.passwordMigrated = admin.migrated;
	cfg.autoRestartIntervalSeconds = general["restart"] | 0UL;
	// missing in configs saved before the setting existed: keep logging on
	cfg.loggingEnabled = jsonInt(general["logging"], 1) != 0;

	// time
	const char *server = ntp["server"] | "";
	setTextCut(cfg.ntpServer, *server ? server : "pool.ntp.org"); // ESP32 SNTP must not get an empty name
	cfg.ntpInterval = jsonInt(ntp["interval"], 0);
	if (cfg.ntpInterval < 0)
		cfg.ntpInterval = 0;
	if (ntp.containsKey("timezone")) // upstream's numeric offset
		legacyTimezone(ntp["timezone"].as<float>(), cfg.tzInfo);
	if (ntp.containsKey("tzinfo"))
		setTextCut(cfg.tzInfo, ntp["tzinfo"] | "");
	// the RTC (its pins were checked with the others above)
	JsonObjectConst rtc = ntp["rtc"];
	int rtcType = jsonInt(rtc["type"], RTC_NONE);
	cfg.rtcType = rtcTypeFrom(rtcType);
	if (cfg.rtcType != rtcType)
		load.warnings.push_back("RTC type out of range, no RTC used: " + std::to_string(rtcType));
	if (cfg.rtcType != RTC_NONE)
	{
		int sda = jsonInt(rtc["sdapin"], RTC_DEFAULT_SDA), scl = jsonInt(rtc["sclpin"], RTC_DEFAULT_SCL);
		if (sda == 255 || scl == 255)
		{
			load.warnings.push_back("RTC set but its SDA/SCL pins are not: no RTC used");
			cfg.rtcType = RTC_NONE;
		}
		else
		{
			cfg.rtcSda = (uint8_t)sda;
			cfg.rtcScl = (uint8_t)scl;
		}
	}

	// MQTT
	cfg.mqttEnabled = mqtt["enabled"] == 1;
	if (cfg.mqttEnabled)
	{
		bool fits = setText(cfg.mqttHost, mqtt["host"] | "") && setText(cfg.mqttUser, mqtt["user"] | "") &&
					setText(cfg.mqttPass, mqtt["pswd"] | "") && setText(cfg.mqttTopic, mqtt["topic"] | "");
		if (!fits)
			load.warnings.push_back("MQTT host, user, password or topic too long: ignored");
		cfg.mqttPort = jsonInt(mqtt["port"], 1883);
		cfg.mqttAutoTopic = jsonInt(mqtt["autotopic"], 0) != 0;
		if (mqtt.containsKey("syncrate"))
			cfg.mqttInterval = mqtt["syncrate"] | 180UL;
		cfg.mqttEvents = mqtt["mqttlog"] == 1;
		cfg.mqttHA = mqtt["mqttha"] == 1;
		// Remote administration over MQTT (add/delete users, read/replace the
		// config, read the user list) is off unless explicitly enabled.
		cfg.mqttRemoteAdmin = mqtt["remoteadmin"] == 1;
		// Door commands too: anyone who can publish to the command topic
		// could open the doors, guarded only by the device's own (published)
		// IP. Missing or anything but 1 = off.
		cfg.mqttDoorControl = jsonInt(mqtt["doorcontrol"], 0) == 1;
		// missing (settings from before 1.4.2) or unknown: last 4
		cfg.mqttCardUid = mqttUidMode(jsonInt(mqtt["carduid"], MQTT_UID_LAST4));
	}
	cfg.present = true;
	return load;
}

} // namespace core
