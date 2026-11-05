// Wiegand frame decoder, one instance per reader.
//
// The upstream library (matjack1 "Wiegand Protocol Library for esp-rfid")
// keeps its state in static members, so a board can only ever have one
// Wiegand reader. This is the same algorithm moved into an object, with the
// arithmetic kept bit-for-bit identical (32-bit words, same parity handling,
// same key translation) so card numbers already stored as user ids do not
// change. test/native/tests.cpp checks it against frames built from scratch.
//
// onBit() runs in the GPIO interrupt and closes frames into a small queue;
// poll() runs in loop() under that reader's spinlock (see wiegand.esp).
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

// onBit() is called from a GPIO interrupt: it must be inlined into the IRAM
// interrupt handler, never left as a call into flash.
#if defined(__GNUC__)
#define WIEGAND_INLINE inline __attribute__((always_inline))
#else
#define WIEGAND_INLINE inline
#endif

namespace core
{

struct WiegandResult
{
	int type = 0;      // bit count: 4/8 = key press, 24/26/32/34 = card
	uint32_t code = 0; // card number or key (ENTER 0x0d, ESC 0x1b)
};

// What a reader's decoder has thrown away since start-up (Status page): a
// steady rise points at wiring (long cable, missing pull-ups, crosstalk).
struct WiegandCounters
{
	uint32_t glitches;   // edges ignored as noise (closer than GLITCH_US)
	uint32_t badFrames;  // frames of no card or key length, or a corrupt 8-bit key
	uint32_t parity;     // 26/34-bit frames with bad parity
	uint32_t overruns;   // frames lost: the queue was full
};

// A frame as it came off the wire, before decoding.
struct WiegandRaw
{
	uint32_t high, low;
	int bits;
};

class WiegandDecoder
{
public:
	// Times are microseconds from a free-running 32-bit clock; only
	// differences are used, so its wrap (every 71 minutes) does not matter.
	static const uint32_t FRAME_GAP_US = 25000; // this much silence ends a frame
	// A second edge sooner than this after the last one is noise (contact
	// bounce, crosstalk between D0 and D1): Wiegand bits are at least 200 us
	// apart and the ESP32 inputs have no hysteresis.
	static const uint32_t GLITCH_US = 150;
	// frames closed by onBit() and not yet polled: 4 lost digits of a PIN
	// typed during a 2 s loop() stall (a log split, a large delete), and the
	// garbled PIN counted toward the keypad lockout (review 8 V4)
	static const int QUEUE = 32;

	void reset()
	{
		_high = 0;
		_low = 0;
		_last = 0;
		_bits = 0;
		_head = 0;
		_queued = 0;
	}

	// One pulse on D0 (bit 0) or D1 (bit 1). Called from the interrupt.
	// A bit that follows the frame gap first closes the previous frame into
	// the queue: framing used to be left to poll() in loop(), so a loop() held
	// up longer than the gap between two frames (two key presses during a
	// flash write) merged them into one burst that was thrown away.
	WIEGAND_INLINE void onBit(int one, uint32_t nowUs)
	{
		if (_bits > 0)
		{
			uint32_t dt = nowUs - _last;
			if (dt < GLITCH_US)
			{
				_glitches++;
				return;
			}
			if (dt > FRAME_GAP_US)
				closeFrame();
		}
		_bits++;
		if (_bits > 31)
		{
			_high |= ((0x80000000u & _low) >> 31);
			_high <<= 1;
			if (one)
				_low |= 1;
			_low <<= 1;
		}
		else
		{
			if (one)
				_low |= 1;
			_low <<= 1;
		}
		_last = nowUs;
	}

	// Returns true and fills out with the next complete frame: one closed by
	// onBit(), or the one in progress once FRAME_GAP_US of silence has
	// followed it. Incomplete, odd-length or corrupt frames are discarded
	// (false; the next call carries on with the next frame).
	bool poll(uint32_t nowUs, bool removeParityBits, WiegandResult &out)
	{
		if (_queued == 0)
		{
			if (_bits == 0 || (uint32_t)(nowUs - _last) <= FRAME_GAP_US)
				return false;
			closeFrame();
			if (_queued == 0)
				return false;
		}
		WiegandRaw f = _queue[_head];
		_head = (_head + 1) % QUEUE;
		_queued--;
		return decode(f, removeParityBits, out);
	}

	int pendingBits() const { return _bits; }
	int queuedFrames() const { return _queued; }
	uint32_t parityErrors() const { return _parityErrors; } // frames dropped for bad parity
	uint32_t glitches() const { return _glitches; }         // edges ignored as noise
	uint32_t overruns() const { return _overruns; }         // frames lost: the queue was full
	uint32_t badFrames() const { return _badFrames; }       // frames dropped: wrong length or corrupt key
	WiegandCounters counters() const { return WiegandCounters{_glitches, _badFrames, _parityErrors, _overruns}; }

private:
	volatile uint32_t _high = 0;
	volatile uint32_t _low = 0;
	volatile uint32_t _last = 0;
	volatile int _bits = 0;
	WiegandRaw _queue[QUEUE] = {};
	int _head = 0;
	int _queued = 0;
	uint32_t _parityErrors = 0;
	uint32_t _glitches = 0;
	uint32_t _overruns = 0;
	uint32_t _badFrames = 0;

	// Full: the oldest frame goes (counted), so the queue holds the latest
	// QUEUE frames; a PIN entry they were part of is cancelled by the caller.
	WIEGAND_INLINE void closeFrame()
	{
		if (_queued == QUEUE)
		{
			_overruns++;
			_head = (_head + 1) % QUEUE;
			_queued--;
		}
		_queue[(_head + _queued) % QUEUE] = WiegandRaw{_high, _low, _bits};
		_queued++;
		_bits = 0;
		_low = 0;
		_high = 0;
	}

	// The arithmetic is upstream's, bit for bit, so stored card numbers do
	// not change.
	bool decode(WiegandRaw f, bool removeParityBits, WiegandResult &out)
	{
		int bits = f.bits;
		if (!(bits == 24 || bits == 26 || bits == 32 || bits == 34 || bits == 8 || bits == 4))
		{
			_badFrames++;
			return false; // noise
		}
		f.low >>= 1;
		if (bits > 32)
			f.high >>= 1;
		if (bits == 8)
		{
			// 8-bit keypad frame: high nibble is the complement of the low one
			uint8_t hi = (uint8_t)((f.low & 0xf0) >> 4);
			uint8_t lo = (uint8_t)(f.low & 0x0f);
			if (lo != (uint8_t)(~hi & 0x0f))
			{
				_badFrames++;
				return false;
			}
			out.type = 8;
			out.code = translateKey(lo);
			return true;
		}
		if (bits == 4)
		{
			out.type = 4;
			out.code = translateKey(f.low & 0x0f);
			return true;
		}
		// Standard 26/34-bit frames carry even parity over the first half
		// and odd over the second; upstream never checked it, so one
		// flipped bit could read as another enrolled card. Checked only
		// with "remove parity bits" on, which assumes that layout.
		if (removeParityBits && (bits == 26 || bits == 34) && !parityOk(f))
		{
			_parityErrors++;
			return false;
		}
		out.type = bits;
		out.code = cardId(f, removeParityBits);
		return true;
	}

	static int popcount64(uint64_t v)
	{
		int c = 0;
		for (; v; v &= v - 1)
			c++;
		return c;
	}

	// After decode()'s shifts a 26-bit frame is low; a 34-bit one is
	// (high << 31) | low (onBit() moves the top bits into high).
	static bool parityOk(const WiegandRaw &f)
	{
		uint64_t raw = f.bits == 34 ? (((uint64_t)f.high << 31) | f.low) : f.low;
		int half = f.bits / 2; // 13 or 17: parity bit plus 12 or 16 data bits
		uint64_t lowMask = (1ull << half) - 1;
		bool evenOk = (popcount64(raw >> half) & 1) == 0;
		bool oddOk = (popcount64(raw & lowMask) & 1) == 1;
		return evenOk && oddOk;
	}

	static uint32_t translateKey(uint32_t k)
	{
		if (k == 0x0b)
			return 0x0d; // * -> ENTER
		if (k == 0x0a)
			return 0x1b; // # -> ESC
		return k;
	}

	static uint32_t cardId(const WiegandRaw &f, bool removeParity)
	{
		uint32_t low = f.low, high = f.high;
		int bits = f.bits;
		if (removeParity)
		{
			if (bits == 26)
				return (low & 0x1FFFFFE) >> 1;
			if (bits == 24)
				return (low & 0x7FFFFE) >> 1;
			if (bits == 34)
			{
				high = (high & 0x03) << 30;
				low >>= 1;
				return high | low;
			}
			if (bits == 32)
				return (low & 0x7FFFFFFE) >> 1;
		}
		if (bits == 34)
			return high | low;
		return low;
	}
};

// The user id a Wiegand card is stored under: its number in decimal, or with
// "User ID storage mode" hexadecimal in lower-case hex without leading zeros,
// as upstream's String(code, HEX) wrote it (stored ids must not change).
inline std::string wiegandUid(uint32_t code, bool hex)
{
	char buf[12];
	snprintf(buf, sizeof(buf), hex ? "%lx" : "%lu", (unsigned long)code);
	return buf;
}

} // namespace core
