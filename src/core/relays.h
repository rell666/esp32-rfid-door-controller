// The relay loop: pure, so it is tested on the host with a fake GPIO.
//
// A relay with no pin (255) is never driven: on the board, 1.0 left unset
// pins at 0, and Test on a never-saved device toggled GPIO0 (the boot strap).
#pragma once

#include <cstdint>

#include "core/pins.h"
#include "core/relaytimer.h"
#include "core/validate.h"

namespace core
{

static const int RELAY_NO_PIN = 255;
static const int RELAY_MOMENTARY = 0;
static const int RELAY_CONTINUOUS = 1;

// Views of the Config relay arrays.
struct RelayBankView
{
	const int *pin;
	const int *activeLevel; // the level that unlocks the door (Settings::relayUnlock)
	const int *lockType;
	const unsigned long *holdMs;
	int count;
};

inline bool relayHasPin(const RelayBankView &b, int i)
{
	return i >= 0 && i < b.count && b.pin[i] >= 0 && b.pin[i] != RELAY_NO_PIN;
}

// Relay i is locked while its pin reads level (not at its unlock level).
// A remote open request is only made for a locked relay: relayLoop toggles a
// continuous relay, so requesting one that is held open locked the door.
inline bool relayLockedAt(const RelayBankView &b, int i, int level)
{
	return relayHasPin(b, i) && level != (b.activeLevel[i] ? 1 : 0);
}

// A granted card requests relay i only if that opens it: a continuous relay
// toggles, so a card on a door held open locked it (review 6 V3).
// 2026-10-16: no card ever locks it; Test on the web page or MQTT close do.
// A momentary relay is always requested, as before.
inline bool cardMayRequest(const RelayBankView &b, int i, int level)
{
	return relayHasPin(b, i) && (b.lockType[i] != RELAY_CONTINUOUS || relayLockedAt(b, i, level));
}

// One pass over the relays. Io provides:
//   int read(int pin), void write(int pin, int level),
//   void pulse(int relay, unsigned long ms)  energise, relock in hardware (esp_timer),
//   void report(int relay, bool unlocked)    MQTT lock state.
template <typename Io>
void relayLoop(Io &io, const RelayBankView &b, bool *request, RelayTimer *timers, uint64_t now)
{
	for (int i = 0; i < b.count; i++)
	{
		if (!relayHasPin(b, i))
		{
			request[i] = false;
			continue;
		}
		int on = b.activeLevel[i] ? 1 : 0, off = 1 - on;
		if (b.lockType[i] == RELAY_CONTINUOUS)
		{
			if (request[i])
			{
				bool wasOff = io.read(b.pin[i]) == off;
				io.report(i, wasOff);
				io.write(b.pin[i], wasOff ? on : off);
				request[i] = false;
			}
		}
		else if (b.lockType[i] == RELAY_MOMENTARY)
		{
			if (request[i])
			{
				io.report(i, true);
				io.pulse(i, b.holdMs[i]);
				timers[i].start(now);
				request[i] = false;
			}
			else if (timers[i].expired(now, b.holdMs[i]))
			{
				io.report(i, false);
				io.write(b.pin[i], off); // normally done already by the hardware timer
			}
		}
	}
}

// Relay pins and their locked (idle) levels, kept in NVS so the first thing
// setup() does is drive them locked. Until the configuration is read from
// LittleFS (after the mount, a possible format and the user-file sweep) the
// pins were inputs and floated for seconds after power-up.
// Format: up to RELAY_BOOT_MAX pairs of {pin, idle level}.
static const size_t RELAY_BOOT_MAX = 4;
struct RelayBootEntry
{
	uint8_t pin;
	uint8_t idle;
};

// Returns the number of bytes written to out (2 per relay with a pin).
inline size_t packRelayBoot(const RelayBankView &b, uint8_t out[RELAY_BOOT_MAX * 2])
{
	size_t n = 0;
	for (int i = 0; i < b.count && i < (int)RELAY_BOOT_MAX; i++)
	{
		if (!relayHasPin(b, i))
			continue;
		out[n++] = (uint8_t)b.pin[i];
		out[n++] = b.activeLevel[i] ? 0 : 1;
	}
	return n;
}

// Reads what packRelayBoot stored. Anything malformed, or a pin this chip
// cannot drive, is dropped: a damaged entry must not drive a flash pin.
inline size_t unpackRelayBoot(const uint8_t *in, size_t len, const PinSet &pins, RelayBootEntry out[RELAY_BOOT_MAX])
{
	size_t n = 0;
	if (len % 2 != 0 || len > RELAY_BOOT_MAX * 2)
		return 0;
	for (size_t i = 0; i + 1 < len; i += 2)
	{
		if (!pinAllowed(pins, in[i], true) || in[i + 1] > 1)
			continue;
		out[n].pin = in[i];
		out[n].idle = in[i + 1];
		n++;
	}
	return n;
}

// Each door's exit button and what it needs to open its relay, also kept in
// NVS: the buttons are attached at boot from this copy, so a door can still be
// opened from inside when config.json is damaged or refused (the loaded
// settings are otherwise the only way to reach them).
// Format: up to RELAY_BOOT_MAX entries of {door, exit pin, relay pin, active
// level, lock type, hold ms low byte, hold ms high byte}.
static const size_t EXIT_BOOT_ENTRY = 7;
struct ExitBootEntry
{
	uint8_t door;
	uint8_t exitPin;
	uint8_t relayPin;
	uint8_t activeLevel; // the level that unlocks the door (Settings::relayUnlock)
	uint8_t lockType;
	uint16_t holdMs;
};

// Returns the number of bytes written to out (EXIT_BOOT_ENTRY per door with
// both an exit button and a relay).
inline size_t packExitBoot(const RelayBankView &b, const uint8_t *exitPin, uint8_t out[RELAY_BOOT_MAX * EXIT_BOOT_ENTRY])
{
	size_t n = 0;
	for (int i = 0; i < b.count && i < (int)RELAY_BOOT_MAX; i++)
	{
		if (!relayHasPin(b, i) || exitPin[i] == RELAY_NO_PIN)
			continue;
		unsigned hold = b.holdMs[i] > 0xffff ? 0xffff : (unsigned)b.holdMs[i];
		out[n++] = (uint8_t)i;
		out[n++] = exitPin[i];
		out[n++] = (uint8_t)b.pin[i];
		out[n++] = b.activeLevel[i] ? 1 : 0;
		out[n++] = (uint8_t)b.lockType[i];
		out[n++] = (uint8_t)(hold & 0xff);
		out[n++] = (uint8_t)(hold >> 8);
	}
	return n;
}

// Reads what packExitBoot stored. A malformed entry, a pin this chip cannot
// use, a lock type or hold time the settings would refuse, or a second entry
// for the same door is dropped.
inline size_t unpackExitBoot(const uint8_t *in, size_t len, const PinSet &pins, ExitBootEntry out[RELAY_BOOT_MAX])
{
	size_t n = 0;
	if (len % EXIT_BOOT_ENTRY != 0 || len > RELAY_BOOT_MAX * EXIT_BOOT_ENTRY)
		return 0;
	bool seen[RELAY_BOOT_MAX] = {};
	for (size_t i = 0; i < len; i += EXIT_BOOT_ENTRY)
	{
		const uint8_t *p = in + i;
		uint16_t hold = (uint16_t)(p[5] | (p[6] << 8));
		if (p[0] >= RELAY_BOOT_MAX || seen[p[0]] || !pinAllowed(pins, p[1], true) || !pinAllowed(pins, p[2], true) ||
			p[1] == p[2] || p[3] > 1 || (p[4] != RELAY_MOMENTARY && p[4] != RELAY_CONTINUOUS) ||
			hold < MIN_RELAY_MS || hold > MAX_RELAY_MS)
			continue;
		seen[p[0]] = true;
		out[n++] = ExitBootEntry{p[0], p[1], p[2], p[3], p[4], hold};
	}
	return n;
}

} // namespace core
