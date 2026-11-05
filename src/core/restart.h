// One gate for every software restart (plan 1.9.1 B3, D6; review 8 V3).
// Pure, so the decision is tested on the host; main.cpp feeds it and acts.
//
// Save & Reboot, Restart, the end of a firmware update, MQTT updateconf and
// the factory reset restarted at once: a PIN being typed was cut short and
// a maglock on NO was released mid-pulse. Since 1.8.1 the scheduled and the
// low-memory restarts wait for idle (core/memguard.h); now every restart
// does, for at most GRACE_MS: an admin who asked for a restart gets it
// within half a minute however busy the doors are.
#pragma once

#include <cstdint>

namespace core
{

class RestartGate
{
public:
	static const uint64_t GRACE_MS = 30000;

	// A restart is wanted from now (uptime ms); a second ask keeps the first time.
	void ask(uint64_t now)
	{
		if (!_wanted)
		{
			_wanted = true;
			_askedAt = now;
		}
	}
	bool wanted() const { return _wanted; }
	uint64_t askedAt() const { return _askedAt; }

	// Restart now: nothing in progress, or the grace has run out.
	bool due(uint64_t now, bool idle) const
	{
		return _wanted && (idle || now - _askedAt >= GRACE_MS);
	}

private:
	bool _wanted = false;
	uint64_t _askedAt = 0;
};

} // namespace core
