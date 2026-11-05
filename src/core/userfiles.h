// Names in /P: a user record is /P/<uid>; an atomic write (websocket.esp
// writeJsonFileAtomic) also makes <uid>.tmp and, for a moment, <uid>.bak.
// Pure, so it is unit-tested on the host.
#pragma once

#include <cstddef>
#include <cstdio>
#include <cstring>

#include "core/validate.h"

namespace core
{

enum class UserFileKind
{
	Record, // <uid>
	Backup, // <uid>.bak: the previous record during a write; recovered if the record is missing
	Temp,   // <uid>.tmp: a write that never finished
	Other,
};

// Classifies a file name (without "/P/"); base gets the uid for the three
// known kinds.
inline UserFileKind classifyUserFile(const char *name, char *base, size_t baseLen)
{
	if (name == nullptr || baseLen == 0)
		return UserFileKind::Other;
	size_t n = strlen(name);
	UserFileKind kind = UserFileKind::Record;
	if (n > 4 && strcmp(name + n - 4, ".bak") == 0)
		kind = UserFileKind::Backup;
	else if (n > 4 && strcmp(name + n - 4, ".tmp") == 0)
		kind = UserFileKind::Temp;
	size_t len = kind == UserFileKind::Record ? n : n - 4;
	if (len >= baseLen)
		return UserFileKind::Other;
	memcpy(base, name, len);
	base[len] = '\0';
	return isValidUid(base) ? kind : UserFileKind::Other;
}

// Deletes /P/<uid> with the .bak and .tmp an atomic write may have left.
// Upstream removed only /P/<uid>, and a leftover .bak brought the user back
// on the next swipe (readJsonFileRecover). The .bak goes first, so a power
// cut part-way leaves the user present, never resurrected later.
// True only if none of the three is left: a file that could not be removed
// stops it there (a .bak left with no record would bring the user back), and
// the caller must not report the user deleted.
template <typename FS>
bool removeUserFiles(FS &fs, const char *uid)
{
	if (!isValidUid(uid))
		return false;
	char path[MAX_UID_LEN + 8];
	const char *suffixes[] = {".bak", ".tmp", ""};
	for (const char *suffix : suffixes)
	{
		snprintf(path, sizeof(path), "/P/%s%s", uid, suffix);
		if (fs.exists(path))
			fs.remove(path);
		if (fs.exists(path))
			return false;
	}
	return true;
}

// Every file in /P removed in batches of USER_DELETE_BATCH names, the .bak
// files first (as removeUserFiles: a power cut part-way never leaves a .bak
// to bring a deleted user back). It used to list every name in a
// std::vector first: with many users that could outgrow the heap, and
// without exceptions a failed push_back aborts (review 6, reviewer 2).
// True if every file is gone. Io:
//   size_t list(bool backups, char (*out)[USER_FILE_PATH_MAX], size_t max)
//       up to max paths of .bak files (backups) or of the other files
//   bool remove(const char *path)   true if it is gone
// A batch where nothing could be removed ends that pass (no endless loop).
static const size_t USER_DELETE_BATCH = 16;
static const size_t USER_FILE_PATH_MAX = 80;

template <typename Io>
bool removeAllUserFiles(Io &io)
{
	static char names[USER_DELETE_BATCH][USER_FILE_PATH_MAX]; // off the loop() stack; loop() task only
	bool ok = true;
	for (int pass = 0; pass < 2; pass++)
	{
		for (;;)
		{
			size_t n = io.list(pass == 0, names, USER_DELETE_BATCH);
			size_t gone = 0;
			for (size_t i = 0; i < n; i++)
			{
				if (io.remove(names[i]))
					gone++;
				else
					ok = false;
			}
			if (n == 0 || gone == 0)
				break;
		}
	}
	return ok;
}

} // namespace core
