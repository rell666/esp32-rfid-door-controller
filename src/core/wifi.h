// When a request to bring Wi-Fi back (an admin card, or the station
// connect backstop in wifi.esp) should restart it. Pure, so it is tested on
// the host; main.cpp acts on it.
#pragma once

#include <cstdint>

namespace core
{

// The setup hotspot of a new or reset board (IRONFRAME-RFID-xxxxxx, no
// settings yet): a fixed password, documented in the README. It is a public
// factory default, not a secret: it keeps the hotspot from being open (the
// session token travels in the WebSocket URL), and the factory admin
// password, which must be changed at the first sign-in, still guards the
// pages. The hotspot closes after SETUP_HOTSPOT_IDLE_MINUTES with nobody
// connected; a power cycle opens it again. Until 1.8 it was open, for good.
// The web UI keeps a copy (websrc/js/state.js; test/check-docs.mjs).
static const char SETUP_HOTSPOT_PASSWORD[] = "ironframe-setup";
static const int SETUP_HOTSPOT_IDLE_MINUTES = 15;

// wifiOff: WiFi.getMode() == WIFI_OFF (idle-off switched it off, core/wifiidle.h).
// accessPointMode: the board runs its own hotspot.
// stationConnected: WiFi.isConnected(), which is about the station link only.
// Upstream tested !stationConnected alone, which is always true in access
// point mode, so every admin card restarted a running hotspot.
inline bool shouldEnableWifi(bool wifiOff, bool accessPointMode, bool stationConnected)
{
	if (wifiOff)
		return true;
	return !accessPointMode && !stationConnected;
}

// staLinkLoop (wifi.esp): true once, when the station link has been lost
// for lostMs while it is watched (fallback allowed, station mode, not
// connecting, no fallback hotspot up). Not watched or connected again: the
// count starts over.
class LinkLostWatch
{
public:
	bool tick(uint64_t nowMs, bool watching, bool connected, uint64_t lostMs)
	{
		if (!watching || connected)
		{
			lost = false;
			return false;
		}
		if (!lost)
		{
			lost = true;
			since = nowMs;
			return false;
		}
		if (nowMs - since < lostMs)
			return false;
		lost = false;
		return true;
	}

private:
	bool lost = false;
	uint64_t since = 0;
};

// wifiFallbackLoop (wifi.esp): while the fallback hotspot is up, retry the
// configured network every intervalMs, but not while someone is on the
// hotspot (a station scan moves the radio off its channel under them); that
// turn is skipped, not delayed. next: the time of the next turn, updated.
inline bool fallbackRetryDue(uint64_t nowMs, uint64_t &next, bool someoneOnHotspot, uint64_t intervalMs)
{
	if (nowMs < next)
		return false;
	next = nowMs + intervalMs;
	return !someoneOnHotspot;
}

} // namespace core
