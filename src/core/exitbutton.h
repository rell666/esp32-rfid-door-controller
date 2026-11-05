// Exit button debounce, fed both from a GPIO interrupt and from loop().
//
// Polled from loop() alone (Bounce2, up to 1.4.0), a press made while loop()
// was busy (a web page or MQTT command writing flash, a user list) and let go
// before it came back was never seen: the door stayed shut. door.esp now
// also calls edge() from an any-edge interrupt, so a press that ended
// meanwhile is latched and opens the door at the next poll().
//
// A press is the pin held LOW for DEBOUNCE_US without a break, the same
// rule as Bounce2's 30 ms stable interval: contact bounce and short
// glitches on a long cable are not presses. Reported once: when loop() sees
// it held long enough, or, if loop() missed all of it, at the release.
// Pure, so it is tested on the host; door.esp holds the spinlock around it.
#pragma once

#include <cstdint>

// edge() is called from a GPIO interrupt: it must be inlined into the IRAM
// interrupt handler, never left as a call into flash (test/check-iram.py).
#if defined(__GNUC__)
#define EXIT_INLINE inline __attribute__((always_inline))
#else
#define EXIT_INLINE inline
#endif

namespace core
{

class ExitButton
{
public:
	static const uint32_t DEBOUNCE_US = 30000;

	// The level when the button is set up. Held down then (a stuck button,
	// a wiring fault) is not a press: it has to be let go first, as Bounce2.
	void begin(bool low, uint64_t nowUs)
	{
		low_ = low;
		lowSinceUs_ = nowUs;
		reported_ = low;
		latched_ = false;
	}

	// The pin changed (interrupt), or loop() read it: low = pulled to GND.
	EXIT_INLINE void edge(bool low, uint64_t nowUs)
	{
		if (low)
		{
			if (!low_)
			{
				low_ = true;
				lowSinceUs_ = nowUs;
			}
			return;
		}
		if (low_ && !reported_ && nowUs - lowSinceUs_ >= DEBOUNCE_US)
			latched_ = true; // a whole press that loop() did not see
		low_ = false;
		reported_ = false;
	}

	// loop(): the level now. True once per press.
	bool poll(bool low, uint64_t nowUs)
	{
		edge(low, nowUs);
		if (latched_)
		{
			latched_ = false;
			return true;
		}
		if (low_ && !reported_ && nowUs - lowSinceUs_ >= DEBOUNCE_US)
		{
			reported_ = true;
			return true;
		}
		return false;
	}

private:
	bool low_ = false;
	bool reported_ = false; // this press (the current LOW) has been reported
	bool latched_ = false;	// a press ended before loop() saw it
	uint64_t lowSinceUs_ = 0;
};

} // namespace core
