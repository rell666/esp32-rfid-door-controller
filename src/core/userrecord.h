// User records (/P/<uid>): what is stored (WebSocket userfile, MQTT
// adduser) and what goes out over MQTT. Pure, so it is unit-tested on the
// host, and test/vectors/user-records.json runs through this and through
// the simulator's copy (test/e2e/device-sim.mjs).
#pragma once

#include <ArduinoJson.h>
#include <cmath>
#include <cstdint>
#include <cstring>

#include "core/jsonutil.h"
#include "core/validate.h"

namespace core
{

// 64 bytes is 32 letters with accents. The WebSocket user list packs 50
// users into a 16 KB document (about 250 bytes each without the name) and
// the reader reads a record into 1 KB: both keep room at this cap.
static const size_t MAX_USERNAME_BYTES = 64;
// The keypad takes up to 16 digits (core/reader.h); under 4 is a guess away.
static const size_t MIN_PIN_DIGITS = 4;
static const size_t MAX_PIN_DIGITS = 12;

// A Unix time: a JSON number (truncated) or a decimal string. Before 1970
// counts as 0 (the editor's 1970-01-01 is a little before 0 east of UTC).
inline bool userEpoch(JsonVariantConst v, uint32_t &out)
{
	double d;
	if (v.is<const char *>())
	{
		const char *s = v.as<const char *>();
		bool neg = *s == '-';
		if (neg)
			s++;
		if (*s == '\0' || strlen(s) > 10)
			return false;
		d = 0;
		for (; *s; s++)
		{
			if (*s < '0' || *s > '9')
				return false;
			d = d * 10 + (*s - '0');
		}
		if (neg)
			d = -d;
	}
	else if (v.is<double>() && !v.is<bool>())
		d = v.as<double>();
	else
		return false;
	if (!std::isfinite(d) || d > 4294967295.0)
		return false;
	out = d <= 0 ? 0 : (uint32_t)d;
	return true;
}

// A stored record's role and dates as the reader takes them, for the RAM
// index too: it parsed acctype with `| 0` and the reader with jsonInt, so a
// legacy "acctype":"1" opened but listed as Disabled (review 8 V15). A date
// that is not a number or a decimal string counts as 0.
inline int recordRole(JsonVariantConst v) { return jsonInt(v, 0); }
inline uint32_t recordEpoch(JsonVariantConst v)
{
	uint32_t t = 0;
	return userEpoch(v, t) ? t : 0;
}

// Checks one incoming user (WebSocket userfile, MQTT adduser) and writes the
// form that is stored into out: the known keys only (upstream stored the
// message as sent, command, cmd and doorip included), the uid lower-cased
// (every reader reports hex in lower case), numbers as numbers (a string
// validuntil read as 0: expired). Returns NULL, or the problem for the user.
inline const char *checkUserRecord(JsonObjectConst in, JsonObject out)
{
	const char *uid = in["uid"];
	if (!isValidUid(uid))
		return "Invalid uid: 1-32 letters and digits";
	char lower[MAX_UID_LEN + 1];
	size_t n = strlen(uid);
	for (size_t i = 0; i <= n; i++)
		lower[i] = (uid[i] >= 'A' && uid[i] <= 'Z') ? (char)(uid[i] - 'A' + 'a') : uid[i];

	JsonVariantConst user = in["user"];
	if (!user.isNull() && !user.is<const char *>())
		return "User name must be text";
	const char *name = user | "";
	if (strlen(name) > MAX_USERNAME_BYTES)
		return "User name is too long (at most 32 characters; 64 bytes)";

	JsonVariantConst pinv = in["pincode"];
	if (!pinv.isNull() && !pinv.is<const char *>())
		return "PIN must be 4-12 digits";
	const char *pin = pinv | "";
	size_t pinLen = strlen(pin);
	if (pinLen != 0 && (pinLen < MIN_PIN_DIGITS || pinLen > MAX_PIN_DIGITS || strspn(pin, "0123456789") != pinLen))
		return "PIN must be 4-12 digits";

	int acc[4];
	const char *keys[] = {"acctype", "acctype2", "acctype3", "acctype4"};
	for (int i = 0; i < 4; i++)
	{
		JsonVariantConst a = in[keys[i]];
		acc[i] = a.isNull() ? 0 : jsonInt(a, -1);
		if (acc[i] != 0 && acc[i] != 1 && acc[i] != 99)
			return "Access must be 0 (disabled), 1 (always) or 99 (admin)";
	}

	// replaces: the editor's changed UID, the record that goes in the same
	// command (WebSocket userfile). Not stored.
	JsonVariantConst replaces = in["replaces"];
	if (!replaces.isNull() && !isValidUid(replaces.as<const char *>()))
		return "Invalid uid to replace";

	uint32_t since = 0, until = 0;
	if (!in["validsince"].isNull() && !userEpoch(in["validsince"], since))
		return "Valid since must be a date (Unix time)";
	if (in["validuntil"].isNull())
		return "Valid until is required";
	if (!userEpoch(in["validuntil"], until))
		return "Valid until must be a date (Unix time)";

	out["uid"] = (char *)lower; // char *: copied
	out["user"] = (char *)name;
	out["pincode"] = (char *)pin;
	for (int i = 0; i < 4; i++)
		out[keys[i]] = acc[i];
	out["validsince"] = since;
	out["validuntil"] = until;
	return nullptr;
}

// A record giving admin access (99) on any door: an admin card opens its
// door outside the opening hours and turns the Wi-Fi back on. MQTT adduser
// refuses it (remote admin cannot enrol one, 2026-10-15).
inline bool isAdminRecord(JsonObjectConst record)
{
	for (const char *key : {"acctype", "acctype2", "acctype3", "acctype4"})
		if (jsonInt(record[key], 0) == 99)
			return true;
	return false;
}

// A WebSocket userfile save that needs the admin password as well as a
// session (plan 1.9.1 B1, D1; review 8 V1): one that adds a user (create,
// or no record stored under its uid, which a changed UID always is: the
// create flag is the sender's, so it is not trusted alone), gives admin
// access (99) on any door, or changes the PIN (set, changed or removed).
// A name, the dates or roles 0/1 on a stored user stay session-only.
// record: as checkUserRecord stored it; storedPin: the stored record's
// pincode ("" when it has none or could not be read: a PIN then counts as
// changed).
inline bool userFileNeedsStepUp(bool create, bool hadRecord, JsonObjectConst record, const char *storedPin)
{
	if (create || !hadRecord || isAdminRecord(record))
		return true;
	const char *pin = record["pincode"] | "";
	return strcmp(pin, storedPin ? storedPin : "") != 0;
}

// One user for MQTT getuserlist. Never the PIN: the record's pincode is left
// out, and a PIN-only user (whose uid IS the PIN: the keypad looks the typed
// digits up as a uid) is sent as uid "keypad" with keypad true. haspin says
// whether a PIN is stored. Upstream published the file as stored, PIN and
// all, with any other key that had been saved in it.
inline void publicUserRecord(const char *uid, JsonObjectConst stored, JsonObject out)
{
	const char *pin = stored["pincode"] | "";
	bool keypad = *pin != '\0' && strcmp(pin, uid) == 0;
	out["command"] = "userfile";
	if (keypad)
	{
		out["uid"] = "keypad";
		out["keypad"] = true;
	}
	else
		out["uid"] = (char *)uid; // char *: ArduinoJson copies it (f.name() is the File's buffer)
	out["user"] = stored["user"];
	out["acctype"] = stored["acctype"];
	out["acctype2"] = stored["acctype2"];
	out["acctype3"] = stored["acctype3"];
	out["acctype4"] = stored["acctype4"];
	out["validsince"] = stored["validsince"];
	out["validuntil"] = stored["validuntil"];
	out["haspin"] = *pin != '\0';
}

} // namespace core
