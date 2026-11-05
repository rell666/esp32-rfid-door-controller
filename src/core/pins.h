// GPIOs a configuration may use, per chip. The firmware enforces these lists
// (config.esp) and sends them to the web UI, which builds its pin menus from
// them; README-IRONFRAME.md is checked against them.
#pragma once

#include <cstddef>
#include <cstdint>

namespace core
{

// ESP32-S3 (DevKitC-1 style): excludes strapping 0/3/45/46, USB 19/20,
// flash 26-32, octal PSRAM 33-37, UART0 43/44.
static const uint8_t PINS_ESP32S3_IO[] = {1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48};
static const uint8_t PINS_ESP32S3_INPUT_ONLY[] = {0}; // none (placeholder, length 0 below)
static const size_t PINS_ESP32S3_INPUT_ONLY_N = 0;

// Original ESP32 (WROOM-32/32E): excludes strapping 0/2/5/12/15 (12 high at
// boot selects 1.8 V flash and the chip will not start - Wiegand lines idle
// high), UART0 1/3, flash 6-11. 34-39 exist but are input-only and have no
// pull-ups: GPIO34/35 are allowed for reader inputs, never for outputs.
static const uint8_t PINS_ESP32_IO[] = {4, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33};
// GPIO36/39 are excluded: an ESP32 erratum gives them spurious low
// pulses while the SAR ADC is powered, which Wi-Fi does: corrupt Wiegand frames.
static const uint8_t PINS_ESP32_INPUT_ONLY[] = {34, 35};
static const size_t PINS_ESP32_INPUT_ONLY_N = 2;

struct PinSet
{
	const uint8_t *io;
	size_t ioN;
	const uint8_t *inOnly;
	size_t inOnlyN;
};

inline PinSet pinSetEsp32s3() { return {PINS_ESP32S3_IO, sizeof(PINS_ESP32S3_IO), PINS_ESP32S3_INPUT_ONLY, PINS_ESP32S3_INPUT_ONLY_N}; }
inline PinSet pinSetEsp32() { return {PINS_ESP32_IO, sizeof(PINS_ESP32_IO), PINS_ESP32_INPUT_ONLY, PINS_ESP32_INPUT_ONLY_N}; }

inline bool pinAllowed(const PinSet &s, int pin, bool output)
{
	for (size_t i = 0; i < s.ioN; i++)
		if (s.io[i] == pin)
			return true;
	if (!output)
		for (size_t i = 0; i < s.inOnlyN; i++)
			if (s.inOnly[i] == pin)
				return true;
	return false;
}

} // namespace core
