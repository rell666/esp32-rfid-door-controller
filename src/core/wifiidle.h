// Wi-Fi idle-off: Wi-Fi turns off once nobody has been connected for a set
// time (a device joined to the board's hotspot, or a signed-in page open).
// Opt-in on the Network page (network.idleoff, network.idlemins). An admin
// card or a power cycle turns Wi-Fi back on. Pure, so it is tested on the
// host; main.cpp acts on it.
//
// It replaces WiFi Timeout (network.offtime, until 1.7), which counted only
// the time the board was connected to a router: a hotspot install, the usual
// production one, never turned off.
#pragma once

#include <cstdint>

#include "core/wifi.h"

namespace core
{

// network.idlemins: 1 minute to a day, 15 by default
static const int WIFI_IDLE_MINUTES_DEFAULT = 15;
static const int WIFI_IDLE_MINUTES_MAX = 1440;

inline bool isValidIdleMinutes(int minutes)
{
	return minutes >= 1 && minutes <= WIFI_IDLE_MINUTES_MAX;
}

// A stored WiFi Timeout (seconds) as idle-off minutes: rounded up, so Wi-Fi
// never goes off sooner than it did, at most a day; 0 = it was off. 32 bits,
// as on the ESP32 (unsigned long): not seconds + 59, which wraps there.
inline int idleMinutesFromOfftime(uint32_t seconds)
{
	uint32_t m = seconds / 60 + (seconds % 60 ? 1 : 0);
	return m > (uint32_t)WIFI_IDLE_MINUTES_MAX ? WIFI_IDLE_MINUTES_MAX : (int)m;
}

// What the idle timer runs on. The setup hotspot of a board with no settings
// always closes after its fixed minutes (2026-10-17: there is no tick
// box to read yet); otherwise the Network page's tick box and minutes.
struct IdleRule
{
	bool enabled;
	int minutes;
};

inline IdleRule idleRule(bool setupHotspot, bool idleOff, int idleMinutes)
{
	if (setupHotspot)
		return {true, SETUP_HOTSPOT_IDLE_MINUTES};
	return {idleOff, idleMinutes};
}

// The idle timer, ticked every loop() pass. Due once `running` (idle-off
// ticked and Wi-Fi up) has held with nobody connected for `minutes`. Anything
// else starts the count again: someone connected, Wi-Fi off (so a wake by
// admin card or power-up gets a full period), idle-off unticked, minutes out
// of range, and the first pass after boot. In 64-bit milliseconds of uptime.
class IdleOff
{
public:
	bool tick(uint64_t nowMs, bool running, int minutes, bool anyoneConnected)
	{
		if (!started || !running || anyoneConnected || !isValidIdleMinutes(minutes))
		{
			started = true;
			since = nowMs;
			return false;
		}
		return nowMs - since >= (uint64_t)minutes * 60000ULL;
	}

private:
	uint64_t since = 0;
	bool started = false;
};

} // namespace core
