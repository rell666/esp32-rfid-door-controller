// Keypad and card-reader lockouts. Pure, so they are unit-tested on the host.
//
// Upstream's only brake on guessing was the 2 s reader cool-down. Failures
// fill a leaky bucket that forgives one every FORGIVE_MS; when it holds
// MAX_FAILS the lockout refuses for FIRST_MS; every further lockout doubles
// that, up to MAX_MS, until the bucket has drained empty after a lockout
// (expire()). A count that restarted after a quiet spell (10 min, up to
// 1.4.0) never locked a guesser who paced below it, about 576 PINs a day;
// a bucket catches any average rate above one per FORGIVE_MS, while a slip
// now and then drains away. A success does not reset it: it used to, so
// anyone who knew one PIN could guess for ever (four wrong, one right).
// A lockout leaves the bucket one short of full, draining from when it ends:
// an empty bucket gave a guesser MAX_FAILS more tries after every lockout
// (about 480 PINs a day at 15 min); now one more failure soon after re-locks,
// so sustained guessing gets about one try per MAX_MS (96 a day), while
// someone who waits (MAX_FAILS - 1) * FORGIVE_MS is back to a full allowance.
//
// PinLockout (wrong PINs): one per reader, kept by core::ReaderSession, so a
// stranger at one door cannot lock out another door or the inside reader
// people leave by. The firmware stores level() in NVS when a lockout starts,
// so a power cycle resumes it (restore()) instead of clearing it.
// CardAlarm (unknown cards) is the same bucket used only to raise an alarm:
// "locked" there means the alarm was raised and is quiet until it ends.
#pragma once

#include <cstdint>

namespace core
{

template <uint8_t MaxFails, uint32_t ForgiveMinutes>
class FailLockout
{
public:
	static const uint8_t MAX_FAILS = MaxFails;
	static const uint32_t FORGIVE_MS = ForgiveMinutes * 60u * 1000u; // one failure drains away per this
	static const uint32_t FIRST_MS = 30000;
	static const uint32_t MAX_MS = 15u * 60u * 1000u;

	// now: milliseconds since boot, 64-bit (no wrap). The 32-bit version came
	// back on 24.8 days after a lockout ended and stayed on for 24.8 more.
	bool locked(uint64_t now) const { return now < until_; }
	uint32_t remainingMs(uint64_t now) const { return locked(now) ? (uint32_t)(until_ - now) : 0; }
	uint8_t failures() const { return fails_; } // in the bucket at the last failure

	// Records a failure. Returns the lockout length in ms when this failure
	// starts a lockout, otherwise 0. Attempts while locked are not counted.
	uint32_t fail(uint64_t now)
	{
		if (locked(now))
			return 0;
		drain(now);
		if (++fails_ < MAX_FAILS)
			return 0;
		lockMs_ = lockMs_ == 0 ? FIRST_MS : (lockMs_ >= MAX_MS / 2 ? MAX_MS : lockMs_ * 2);
		lockFor(now);
		return lockMs_;
	}

	// Length of the last lockout, 0 = none since the bucket last drained
	// empty: what the firmware persists.
	uint32_t level() const { return lockMs_; }

	// After a restart: a lockout of lockMs was started before it. How long
	// ago is unknown, so lock for the whole of it again, and keep doubling
	// from there.
	void restore(uint32_t lockMs, uint64_t now)
	{
		if (lockMs == 0)
			return;
		lockMs_ = lockMs > MAX_MS ? MAX_MS : (lockMs < FIRST_MS ? FIRST_MS : lockMs);
		lockFor(now);
	}

	// Call regularly. Returns true once, when the bucket has drained empty
	// since the last lockout ((MAX_FAILS - 1) * FORGIVE_MS after it ended, if
	// nothing else failed): the level is back to 0 (the firmware then forgets
	// it in NVS) and the next lockout is FIRST_MS again.
	bool expire(uint64_t now)
	{
		if (lockMs_ == 0 || locked(now) || (now - drainedAt_) / FORGIVE_MS < fails_)
			return false;
		lockMs_ = 0;
		return true;
	}

private:
	// Locks for lockMs_ and leaves the bucket one short of full, draining
	// from when the lockout ends.
	void lockFor(uint64_t now)
	{
		until_ = now + lockMs_;
		fails_ = MAX_FAILS - 1;
		drainedAt_ = until_;
	}

	// One failure forgiven per whole FORGIVE_MS since drainedAt_; the part
	// of a period already run carries over.
	void drain(uint64_t now)
	{
		if (fails_ == 0)
		{
			drainedAt_ = now;
			return;
		}
		uint64_t n = (now - drainedAt_) / FORGIVE_MS;
		if (n >= fails_)
		{
			fails_ = 0;
			drainedAt_ = now;
			return;
		}
		fails_ -= (uint8_t)n;
		drainedAt_ += n * FORGIVE_MS;
	}

	uint8_t fails_ = 0;
	uint32_t lockMs_ = 0; // length of the last lockout; 0 = none since the bucket drained
	uint64_t drainedAt_ = 0;
	uint64_t until_ = 0; // locked while now < until_
};

// Steady rates below one failure per FORGIVE_MS are never locked out (at
// most 24 PIN guesses or 48 unknown cards a day per reader); faster ones get
// about one try per MAX_MS lockout once locked, 96 a day per reader.
using PinLockout = FailLockout<5, 60>;   // wrong PINs, one keypad: 5, one forgiven per hour
// Unknown cards no longer lock a reader (2026-10-16: valid cards always
// pass). Up to 1.4.2 a burst of 10 refused every card, valid ones too, so
// anyone with a few cheap tags could keep a door shut to its users.
using CardAlarm = FailLockout<10, 30>; // unknown cards, one reader: an alarm at 10, one forgiven per 30 min

} // namespace core
