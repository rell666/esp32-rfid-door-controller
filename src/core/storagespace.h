#pragma once
#include <stddef.h>

namespace core
{

// Free-space floors on the ~900 KB LittleFS (bench 2026-10-18, ledger H27).
// LittleFS does not return "no space" when a file is written or removed with
// no free block left: it divides by zero in lfs_alloc and the board restarts.
// If that leaves a .tmp behind, the boot sweep removes it on every start and
// crashes there too, so the board never comes up. Nothing may fill it:
// - logs keep LOG_MIN_FREE_BYTES (48 KB) free by deleting their own rotated files;
// - a new user (web page, restore or MQTT) needs USER_MIN_FREE_BYTES, so users
//   stop before the logs start giving way and the store never reaches full;
// - no file at all is written with less than WRITE_MIN_FREE_BYTES left, plus
//   room for the temporary copy and the backup an atomic write keeps.
static const size_t USER_MIN_FREE_BYTES = 64 * 1024;
static const size_t WRITE_MIN_FREE_BYTES = 16 * 1024;

// At most MAX_USERS users (2026-10-18: sites have under 200). Every
// user is a file in one /P directory, and LittleFS finds a file by scanning
// it: a card's lookup took 0.37 s with 500 users and 0.56 s with 776, and
// the store fills at about 720.
static const size_t MAX_USERS = 200;
inline bool userLimitReached(size_t users) { return users >= MAX_USERS; }

// LittleFS usedBytes() and totalBytes() each walk the whole store: about
// 1 s each with 700 users, and every log line asked for both. Free space is
// measured at most every MAX_AGE_MS; writes since are subtracted, so the
// estimate only errs low. A caller about to refuse something measures again
// (fsFreeAtLeast in log.esp), so the estimate never refuses on its own.
class FreeSpace
{
public:
	static const uint64_t MAX_AGE_MS = 30000;
	bool fresh(uint64_t now) const { return _valid && now >= _at && now - _at < MAX_AGE_MS; }
	size_t estimate() const { return _free > _spent ? _free - _spent : 0; }
	void measured(uint64_t now, size_t freeBytes)
	{
		_free = freeBytes;
		_spent = 0;
		_at = now;
		_valid = true;
	}
	void spent(size_t bytes) { _spent += bytes; }

private:
	size_t _free = 0, _spent = 0;
	uint64_t _at = 0;
	bool _valid = false;
};

inline bool newUserFits(size_t freeBytes) { return freeBytes >= USER_MIN_FREE_BYTES; }

inline bool atomicWriteFits(size_t freeBytes, size_t bytes)
{
	return freeBytes >= WRITE_MIN_FREE_BYTES && freeBytes - WRITE_MIN_FREE_BYTES >= 2 * bytes;
}

} // namespace core
