// When a new firmware image is confirmed (rollback cancelled). Pure, so it
// is tested on the host; system.esp acts on it.
#pragma once

#include <cstddef>
#include <cstdint>

namespace core
{

// 60 s of running plus one served page or WebSocket: the UI is reachable.
static const uint64_t FIRMWARE_CONFIRM_AFTER_MS = 60000;
// Without anyone opening the UI, an image that has run this long without a
// crash or watchdog reset is confirmed anyway. Before, it stayed "pending
// verify" for ever and the next power cut put the old firmware back,
// silently.
static const uint64_t FIRMWARE_CONFIRM_UNATTENDED_MS = 60ULL * 60 * 1000;

inline bool firmwareConfirmDue(uint64_t uptimeMs, bool uiReached)
{
	return uptimeMs >= (uiReached ? FIRMWARE_CONFIRM_AFTER_MS : FIRMWARE_CONFIRM_UNATTENDED_MS);
}

// The start of an image sent to /update, checked before anything is written
// (the browser checks the same in backup.js). An app image starts with the
// image header (magic 0xE9, chip id at byte 12) and its first segment holds
// the app description (magic word 0xABCD5432 at byte 32). A -full-flash
// image starts with 0xFF padding (ESP32: bootloader at 0x1000) or with the
// bootloader, which has no app description (ESP32-S3: bootloader at 0x0).
static const size_t UPDATE_HEAD_BYTES = 36;
static const uint16_t IMAGE_CHIP_ESP32 = 0;
static const uint16_t IMAGE_CHIP_ESP32S3 = 9;

// NULL if the image may be an update for chipId, else the reason.
inline const char *checkUpdateImageHead(const uint8_t *d, size_t len, uint16_t chipId)
{
	if (len < UPDATE_HEAD_BYTES)
		return "The file is too short to be a firmware image";
	if (d[0] != 0xE9)
		return "Not a firmware update image (it does not start with 0xE9). A -full-flash image is for a serial flash only: use ironframe-rfid-<version>.bin";
	uint16_t chip = (uint16_t)(d[12] | (d[13] << 8));
	if (chip != chipId)
		return chipId == IMAGE_CHIP_ESP32 ? "This image is for another chip, not the ESP32 (WROOM)" : "This image is for another chip, not the ESP32-S3";
	uint32_t magic = (uint32_t)d[32] | ((uint32_t)d[33] << 8) | ((uint32_t)d[34] << 16) | ((uint32_t)d[35] << 24);
	if (magic != 0xABCD5432u)
		return "Not a firmware update image: it starts with a bootloader (a -full-flash image). Use ironframe-rfid-<version>.bin";
	return nullptr;
}

} // namespace core
