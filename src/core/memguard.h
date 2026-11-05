// Low memory: restart the board, but only when nothing is in progress.
// Pure, so the decision is tested on the host; main.cpp feeds it and acts.
//
// Review 6 (reviewer 2): a fragmented heap can leave every card refused as
// Busy ("Not enough memory to read a user record") and nothing ever
// restarted the board. 2026-10-17: restart, but only when idle (no
// reader part-way through a card or PIN, no door unlocked or held, no
// firmware upload, no settings apply waiting), accepting the short maglock
// release a restart gives (ledger H22.4).
//
// The threshold is not measured on the board (no largest-block figures from
// it exist; the logs were cleared 2026-10-16). It comes from the allocations
// in the code: a settings save and load use 8 KB JSON documents, a card
// lookup a 1 KB one plus LittleFS's 512-byte caches. With the largest free
// block under 8 KB for 10 minutes the settings pages already fail and card
// reads are next. The hourly "Memory" event records the real figures; adjust
// these once there are some.
#pragma once

#include <cstdint>

namespace core
{

// The scheduled restart (General: Auto restart): due once the uptime passes
// the interval, and taken only when idle (idleForRestart(): no card or PIN
// part-way, every door locked, no update or settings apply), as the
// low-memory restart is. It cut a PIN entry or an open pulse, and released
// a maglock on NO at any moment (review 7). An hour past due it goes ahead
// anyway, so a door kept busy cannot put it off for ever.
static const uint64_t AUTO_RESTART_GRACE_S = 3600;

inline bool autoRestartNow(uint64_t uptimeS, uint64_t intervalS, bool idle)
{
	if (intervalS == 0 || uptimeS <= intervalS)
		return false;
	return idle || uptimeS > intervalS + AUTO_RESTART_GRACE_S;
}

class MemGuard
{
public:
	static const uint32_t LOW_BLOCK_BYTES = 8192;   // largest free block below this is "low"
	static const int LOW_SAMPLES = 10;              // samples in a row (one a minute: 10 minutes)
	static const int BUSY_LIMIT = 3;                // card lookups refused for memory in a row
	static const uint64_t MIN_UPTIME_MS = 3600000;  // never in the first hour after any start: at most one an hour
	// wanted this long while never idle: restart anyway. One Continuous door
	// held open kept the board from ever restarting while the other door
	// refused every card as Busy (review 8 V5, plan 1.9.1 C2).
	static const uint64_t GRACE_MS = 3600000;

	// A card lookup refused for lack of memory (Lookup::Busy), or one that
	// read its record (found or not): memory was there, the count restarts.
	void noteBusy()
	{
		if (busy < BUSY_LIMIT)
			busy++;
	}
	void noteLookupOk() { busy = 0; }

	// The largest free block, sampled once a minute.
	void sample(uint32_t largestBlock)
	{
		if (largestBlock < LOW_BLOCK_BYTES)
		{
			if (low < LOW_SAMPLES)
				low++;
		}
		else
			low = 0;
	}

	// Why a restart is wanted (nullptr: it is not), idle or not.
	const char *wanted(uint64_t uptimeMs) const
	{
		if (uptimeMs < MIN_UPTIME_MS)
			return nullptr;
		if (busy >= BUSY_LIMIT)
			return "3 card reads in a row refused for lack of memory";
		if (low >= LOW_SAMPLES)
			return "largest free block under 8192 bytes for 10 minutes";
		return nullptr;
	}

	// The restart to make now: while idle, or once it has been wanted for
	// GRACE_MS however busy. Call it on every check (idle need only be
	// worked out while wanted()): a pass where it is not wanted starts the
	// grace again.
	const char *restartReason(uint64_t uptimeMs, bool idle)
	{
		const char *why = wanted(uptimeMs);
		if (why == nullptr)
		{
			wantedSince = 0;
			return nullptr;
		}
		if (wantedSince == 0)
			wantedSince = uptimeMs;
		return idle || uptimeMs - wantedSince >= GRACE_MS ? why : nullptr;
	}

	// The grace ran out (a restartReason() that was not idle).
	bool overdue(uint64_t uptimeMs) const { return wantedSince != 0 && uptimeMs - wantedSince >= GRACE_MS; }

private:
	int busy = 0;
	int low = 0;
	uint64_t wantedSince = 0; // uptime ms it has been wanted since (0: not wanted)
};

} // namespace core
