// Access decision for one card/PIN at one reader. Pure, so the per-door rules
// are unit-tested on the host.
//
// A reader bound to a door (readerDoor >= 0) only ever opens that door, and the
// user's permission for THAT door decides. readerDoor -1 is upstream's single
// reader behaviour: door 1's permission decides, and every door the user may
// use opens.
#pragma once

#include <cstdint>
#include <cstring>

namespace core
{

static const int ACC_GRANTED = 1;
static const int ACC_ADMIN = 99;
static const int ACC_UNKNOWN = 98; // access log only: a card nobody is enrolled with

enum class AccessOutcome : uint8_t
{
	Granted,
	Admin,
	Expired,
	ClockInvalid,
	NotValid, // no permission for this door, outside opening hours, or bad door
};

struct AccessInput
{
	int acctype[4] = {0, 0, 0, 0}; // per door, from the user file
	int numRelays = 1;
	int readerDoor = -1;      // -1 = all doors (legacy single reader)
	uint32_t validSince = 0;
	uint32_t validUntil = 0;
	uint32_t now = 0;
	bool withinOpeningHours = true;
	bool timeTrusted = true;
	bool hoursRestricted = false; // some hour of the week is closed
};

struct AccessDecision
{
	AccessOutcome outcome = AccessOutcome::NotValid;
	uint8_t relayMask = 0; // bit n = open relay n
	int acctype = 0;       // the permission that decided
};

// How a credential reached the reader's decision.
enum class PinPath : uint8_t
{
	Card,        // a card was read; no PIN is asked for
	CardThenPin, // a card was read, then a PIN was typed on the keypad
	PinOnly,     // digits were typed with no card ("Allow pin code only")
};

// Does the PIN typed for this user record match?
//
// Upstream accepted pinCode == uid on every path, so in card+PIN mode a card
// number worked as its own PIN, and in PIN-only mode (where the typed digits
// are looked up as a uid) typing any enrolled card number opened the door.
// The uid is never compared here: only the stored pincode is.
// A user's role at one door as MQTT names it ("access" of an access
// message). Anything but 1 and 99 opens nothing, so it is "Disabled": the
// switch had no default and an out-of-range stored role added no entry,
// shifting every later door's role against doorName (review 8 V17).
inline const char *accessTypeName(int acctype)
{
	switch (acctype)
	{
	case ACC_GRANTED: return "Always";
	case ACC_ADMIN: return "Admin";
	default: return "Disabled";
	}
}

inline bool checkPin(PinPath path, const char *typed, const char *storedPin)
{
	typed = typed ? typed : "";
	storedPin = storedPin ? storedPin : "";
	if (path == PinPath::Card)
		return true;
	if (path == PinPath::PinOnly)
		return *storedPin != 0 && strcmp(typed, storedPin) == 0;
	// card then PIN: a card enrolled without a PIN is refused (PIN required
	// means required; it used to open with the card alone)
	return *storedPin != 0 && strcmp(typed, storedPin) == 0;
}

// Opening hours are seven 24-character strings of 0/1, Monday first, one
// character per local hour.
inline int openingHoursRow(int tmWday) // tm_wday: 0 = Sunday
{
	return (tmWday + 6) % 7;
}

inline bool openAt(const char *const days[7], int tmWday, int hour)
{
	if (tmWday < 0 || tmWday > 6 || hour < 0 || hour > 23)
		return false;
	const char *day = days[openingHoursRow(tmWday)];
	return day != nullptr && strlen(day) == 24 && day[hour] == '1';
}

// True if any hour of the week is closed, i.e. "always" users are limited.
inline bool hoursRestricted(const char *const days[7])
{
	for (int i = 0; i < 7; i++)
		if (days[i] == nullptr || strlen(days[i]) != 24 || strchr(days[i], '0') != nullptr)
			return true;
	return false;
}

// The same, for the fixed buffers of core::Settings.
inline bool openAt(const char (&days)[7][25], int tmWday, int hour)
{
	const char *p[7];
	for (int i = 0; i < 7; i++)
		p[i] = days[i];
	return openAt(p, tmWday, hour);
}
inline bool hoursRestricted(const char (&days)[7][25])
{
	const char *p[7];
	for (int i = 0; i < 7; i++)
		p[i] = days[i];
	return hoursRestricted(p);
}

// A user is dated if the editor's defaults (valid since 1970, valid until
// 2038-01-01) were changed. Records without validuntil count as dated.
static const uint32_t DATED_SINCE_FROM = 1451606400; // 2016-01-01
static const uint32_t NO_EXPIRY_FROM = 2145830400;   // 2037-12-31

inline bool isDated(uint32_t validSince, uint32_t validUntil)
{
	return validSince >= DATED_SINCE_FROM || validUntil < NO_EXPIRY_FROM;
}

inline AccessDecision decideAccess(const AccessInput &in)
{
	AccessDecision d;
	int n = in.numRelays < 1 ? 1 : (in.numRelays > 4 ? 4 : in.numRelays);
	if (in.readerDoor < -1 || in.readerDoor >= n)
		return d; // invalid binding; only -1 is the legacy all-door mode
	int door = in.readerDoor < 0 ? 0 : in.readerDoor;
	d.acctype = in.acctype[door];
	if (d.acctype != ACC_GRANTED && d.acctype != ACC_ADMIN)
		return d;
	if (!in.timeTrusted)
	{
		// Without a clock only what needs no clock is decided: dates and
		// opening hours cannot be checked, so those users wait for the time.
		if (isDated(in.validSince, in.validUntil) || (d.acctype == ACC_GRANTED && in.hoursRestricted))
		{
			d.outcome = AccessOutcome::ClockInvalid;
			return d;
		}
	}
	else if (in.validUntil < in.now || in.validSince > in.now)
	{
		d.outcome = AccessOutcome::Expired;
		return d;
	}
	if (d.acctype == ACC_ADMIN)
	{
		d.outcome = AccessOutcome::Admin;
		d.relayMask = in.readerDoor < 0 ? (uint8_t)((1u << n) - 1) : (uint8_t)(1u << door);
		return d;
	}
	if (in.timeTrusted && !in.withinOpeningHours)
		return d;
	d.outcome = AccessOutcome::Granted;
	if (in.readerDoor < 0)
	{
		for (int i = 0; i < n; i++)
			if (in.acctype[i] == ACC_GRANTED)
				d.relayMask |= (uint8_t)(1u << i);
	}
	else
	{
		d.relayMask = (uint8_t)(1u << door);
	}
	return d;
}

} // namespace core
