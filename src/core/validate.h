// Input validators shared by the WebSocket and MQTT command handlers.
// Pure C++ (no Arduino dependency) so they are unit-tested on the host.
#pragma once

#include <cstddef>
#include <cstdlib>
#include <cstring>

namespace core
{

// A user id becomes a file name under /P/, so it must never contain a path
// separator, "..", or anything else LittleFS would interpret. Card UIDs are Wiegand
// card numbers, hex or decimal (User ID storage mode), or a PIN code.
static const size_t MAX_UID_LEN = 32;

inline bool isValidUid(const char *uid)
{
	if (uid == nullptr)
		return false;
	size_t len = strlen(uid);
	if (len == 0 || len > MAX_UID_LEN)
		return false;
	for (size_t i = 0; i < len; i++)
	{
		char c = uid[i];
		bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
		if (!ok)
			return false;
	}
	return true;
}

// Accepts only the log files this firmware creates:
//   /eventlog.json  /latestlog.json
// optionally followed by ".<n>" (rotation) or ".split.<n>" (manual split),
// where <n> is 1-5 digits. Everything else (config.json, user files,
// traversal) is rejected.
inline bool isValidLogFilename(const char *name)
{
	if (name == nullptr)
		return false;
	const char *bases[] = {"/eventlog.json", "/latestlog.json"};
	for (const char *base : bases)
	{
		size_t bl = strlen(base);
		if (strncmp(name, base, bl) != 0)
			continue;
		const char *rest = name + bl;
		if (*rest == '\0')
			return true;
		if (*rest != '.')
			return false;
		rest++;
		if (strncmp(rest, "split.", 6) == 0)
			rest += 6;
		size_t digits = 0;
		while (rest[digits] >= '0' && rest[digits] <= '9')
			digits++;
		return digits >= 1 && digits <= 5 && rest[digits] == '\0';
	}
	return false;
}

// Parses a relay/door index sent by a remote client. Returns -1 unless the
// value is a plain non-negative integer below numRelays.
inline int parseRelayIndex(const char *s, int numRelays)
{
	if (s == nullptr || *s == '\0')
		return -1;
	for (const char *p = s; *p; p++)
	{
		if (*p < '0' || *p > '9')
			return -1;
	}
	if (strlen(s) > 3)
		return -1;
	int v = atoi(s);
	return (v >= 0 && v < numRelays) ? v : -1;
}

// Policy for the admin (web UI) password.
static const size_t MIN_ADMIN_PASSWORD_LEN = 8;

inline bool isDefaultAdminPassword(const char *p)
{
	return p == nullptr || *p == '\0' || strcmp(p, "admin") == 0;
}

inline bool isAcceptableAdminPassword(const char *p)
{
	return !isDefaultAdminPassword(p) && strlen(p) >= MIN_ADMIN_PASSWORD_LEN && strlen(p) <= 64;
}

// The factory password, and short passwords carried over from upstream configs,
// must be replaced before the device does anything else.
inline bool needsPasswordChange(const char *p)
{
	return !isAcceptableAdminPassword(p);
}

// Relay count from a config file, clamped to the arrays it indexes.
inline int clampRelayCount(int n, int maxRelays)
{
	return n < 1 ? 1 : (n > maxRelays ? maxRelays : n);
}

// Momentary relay hold time ("rtime", milliseconds). Upstream never checked
// it: a negative value became a huge unsigned hold and the door never
// relocked.
static const int MIN_RELAY_MS = 100;
static const int MAX_RELAY_MS = 30000;

inline bool isValidRelayTime(int ms)
{
	return ms >= MIN_RELAY_MS && ms <= MAX_RELAY_MS;
}

inline int clampRelayTime(int ms)
{
	return ms < MIN_RELAY_MS ? MIN_RELAY_MS : (ms > MAX_RELAY_MS ? MAX_RELAY_MS : ms);
}

inline bool isValidOpeningHoursDay(const char *hours)
{
	return hours != nullptr && strlen(hours) == 24 && strspn(hours, "01") == 24;
}

// A WPA2 passphrase must be 8-63 characters; empty means an open AP.
inline bool isValidApPassword(const char *p)
{
	size_t n = p ? strlen(p) : 0;
	return n == 0 || (n >= 8 && n <= 63);
}

// The fallback hotspot's password (network.fallbackpswd): WPA2, so 8-63
// characters, never empty. Without one the fallback hotspot does not open:
// it used to open with no password after 5 minutes without the router.
inline bool isValidFallbackPassword(const char *p)
{
	size_t n = p ? strlen(p) : 0;
	return n >= 8 && n <= 63;
}

} // namespace core
