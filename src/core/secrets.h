// Keeps stored passwords out of anything sent to a browser or MQTT broker.
// getconf replies carry SECRET_MASK instead of the real value; when a config
// comes back with SECRET_MASK still in place, the stored value is kept.
#pragma once

#include <ArduinoJson.h>
#include <cstring>
#include <string>

#include "core/validate.h"

namespace core
{

static const char SECRET_MASK[] = "********";

struct SecretPath
{
	const char *section;
	const char *key;
};

static const SecretPath SECRET_PATHS[] = {
	{"network", "pswd"},
	{"network", "fallbackpswd"},
	{"general", "pswd"},
	{"mqtt", "pswd"},
};

// Replace every non-empty secret with the mask. Empty values stay empty so the
// UI can still tell "open network / no MQTT password" from "set".
inline void maskSecrets(JsonObject root)
{
	for (const SecretPath &p : SECRET_PATHS)
	{
		JsonObject section = root[p.section];
		if (section.isNull() || !section.containsKey(p.key))
			continue;
		const char *v = section[p.key];
		if (v != nullptr && *v != '\0')
			section[p.key] = SECRET_MASK;
	}
	// how the admin password is stored (core/adminpass.h) is the device's
	// own business; every save puts it back (applyConfigPolicy)
	JsonObject general = root["general"];
	if (!general.isNull())
	{
		general.remove("pswdhash");
		general.remove("pswdchange");
	}
}

// True if a secret in `incoming` is still the mask, so saving it needs the
// stored value. When a stored config exists but cannot be read (out of
// memory, damaged), such a save must be refused: mergeSecrets() would drop
// the key and an access point saved without a password is an open one.
inline bool secretsNeedStored(JsonObjectConst incoming)
{
	if (incoming.isNull())
		return false;
	for (const SecretPath &p : SECRET_PATHS)
	{
		const char *v = incoming[p.section][p.key];
		if (v != nullptr && strcmp(v, SECRET_MASK) == 0)
			return true;
	}
	return false;
}

// For each secret still equal to the mask in `incoming`, copy the stored value
// from `existing`; if nothing is stored the key is removed. Returns the number
// of secrets restored.
inline int mergeSecrets(JsonObject incoming, JsonObjectConst existing)
{
	int restored = 0;
	for (const SecretPath &p : SECRET_PATHS)
	{
		JsonObject section = incoming[p.section];
		if (section.isNull() || !section.containsKey(p.key))
			continue;
		const char *v = section[p.key];
		if (v == nullptr || strcmp(v, SECRET_MASK) != 0)
			continue;
		JsonObjectConst oldSection = existing.isNull() ? JsonObjectConst() : existing[p.section].as<JsonObjectConst>();
		const char *old = oldSection.isNull() ? nullptr : oldSection[p.key].as<const char *>();
		if (old != nullptr)
		{
			section[p.key] = (char *)old; // char* => ArduinoJson copies the string
			restored++;
		}
		else
		{
			section.remove(p.key);
		}
	}
	return restored;
}

// The card number in MQTT access messages (mqtt "carduid"): 0 none, 1 the
// last 4 characters, 2 all of it. Every access went to the broker with the
// full card number, which is all a cloner needs; last 4 is the default, also
// for settings saved before the key existed.
static const int MQTT_UID_OFF = 0;
static const int MQTT_UID_LAST4 = 1;
static const int MQTT_UID_FULL = 2;

// A stored or received value; anything else is the default.
inline int mqttUidMode(int v)
{
	return v == MQTT_UID_OFF || v == MQTT_UID_FULL ? v : MQTT_UID_LAST4;
}

// The "uid" of an access message for a uid as stored; false: send no uid
// field at all (off). Last 4 is "****" and the last 4 characters; a uid of
// 4 characters or fewer is all mask, or it would be shown whole. "keypad"
// (a keypad entry) and the " " of a button or MQTT open are not card
// numbers and are sent as they are.
inline bool mqttAccessUid(const char *uid, int mode, std::string &out)
{
	mode = mqttUidMode(mode);
	if (mode == MQTT_UID_OFF)
		return false;
	out = uid ? uid : "";
	if (mode == MQTT_UID_FULL || out == "keypad" || !isValidUid(out.c_str()))
		return true;
	out = out.size() > 4 ? "****" + out.substr(out.size() - 4) : "****";
	return true;
}

} // namespace core
