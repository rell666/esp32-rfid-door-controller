// Non-blocking on/off patterns for a reader's buzzer and LED lines.
#pragma once

#include <cstdint>

namespace core
{

class FeedbackPattern
{
public:
	// count pulses of onMs, separated by offMs, starting now (milliseconds
	// since boot, 64-bit).
	void start(uint8_t count, uint16_t onMs, uint16_t offMs, uint64_t now)
	{
		_count = count;
		_on = onMs;
		_off = offMs;
		_start = now;
	}

	// Whether the output should be active at time now.
	bool active(uint64_t now) const
	{
		if (!running(now))
			return false;
		uint32_t period = (uint32_t)_on + _off;
		return (uint32_t)(now - _start) % period < _on;
	}
	bool running(uint64_t now) const
	{
		return _count != 0 && now >= _start && now - _start < (uint64_t)((uint32_t)_on + _off) * _count;
	}

private:
	uint8_t _count = 0;
	uint16_t _on = 0, _off = 0;
	uint64_t _start = 0;
};

// Patterns used for reader feedback.
struct Beep
{
	uint8_t count;
	uint16_t onMs, offMs;
};
static const Beep BEEP_GRANTED = {1, 120, 0};
static const Beep BEEP_ADMIN = {2, 120, 120};
static const Beep BEEP_DENIED = {3, 100, 100};
static const Beep BEEP_KEY = {1, 30, 0};
static const uint16_t LED_GRANTED_MS = 2000;

} // namespace core
