// Release timing for momentary relays, one timer per relay. Upstream kept one
// start time for every relay, so opening one door re-timed the others, and in
// the pass that opened a door another door's elapsed time went negative
// (unsigned wrap) and it re-locked at once.
#pragma once

#include <cstdint>

namespace core
{

class RelayTimer
{
public:
	// nowMs: milliseconds since boot, 64-bit.
	void start(uint64_t nowMs)
	{
		m_running = true;
		m_startedMs = nowMs;
	}

	// True exactly once, when holdMs has elapsed since start().
	bool expired(uint64_t nowMs, uint32_t holdMs)
	{
		if (!m_running || nowMs - m_startedMs < holdMs)
			return false;
		m_running = false;
		return true;
	}

	void stop() { m_running = false; }
	bool running() const { return m_running; }

private:
	bool m_running = false;
	uint64_t m_startedMs = 0;
};

// The relock deadline of a momentary relay, which an esp_timer relocks
// (relayPulse / relayRelockCallback in main.cpp; callers hold the relay
// spinlock). Microseconds since boot.
class RelockDeadline
{
public:
	// Energised at nowUs, to relock holdMs later.
	void arm(int64_t nowUs, unsigned long holdMs) { m_atUs = nowUs + (int64_t)holdMs * 1000; }

	// Forget a pending relock (the caller locks the relay itself).
	void cancel() { m_atUs = 0; }

	// The relock timer fired at nowUs: true, once, if the relay is due to
	// relock. A late callback of an earlier pulse, after the relay was opened
	// again, finds the new deadline and does nothing. Up to 1 ms early still
	// counts (timer granularity).
	bool due(int64_t nowUs)
	{
		if (m_atUs == 0 || nowUs < m_atUs - 1000)
			return false;
		m_atUs = 0;
		return true;
	}

	bool pending() const { return m_atUs != 0; }

private:
	int64_t m_atUs = 0; // 0 = nothing pending
};

} // namespace core
