// Reading a JSON file that an atomic write (storage.esp writeJsonFileAtomic)
// may have left as <path>.bak only: config.json and the user records. Pure,
// so it is unit-tested on the host.
#pragma once

namespace core
{

enum class JsonRead
{
	Ok,
	Missing,  // no such file
	Corrupt,  // the file is there but not valid JSON
	NoMemory, // not enough memory (or document) to parse it: says nothing about the file
};

enum class JsonRecover
{
	Read,      // <path> read
	Recovered, // <path> was missing or corrupt: <path>.bak read and moved into its place
	Failed,    // neither could be read (or the .bak could not be moved)
	NoMemory,  // could not tell (out of memory); no file was touched
};

// fs: exists/remove/rename. read(name) parses one file into the caller's
// document and returns a JsonRead. Out of memory is not corruption: a good
// config.json must never be replaced by an older .bak because the heap was
// short at that moment. keepBackup: config.json keeps its .bak; a user
// record's leftover .bak is removed once the record reads. *first: how
// <path> itself read (Missing or Corrupt when the .bak was used).
template <typename FS, typename Reader>
JsonRecover readJsonRecover(FS &fs, const char *path, const char *backup, bool keepBackup, Reader read, JsonRead *first = nullptr)
{
	JsonRead current = read(path);
	if (first != nullptr)
		*first = current;
	if (current == JsonRead::Ok)
	{
		if (!keepBackup && fs.exists(backup))
			fs.remove(backup);
		return JsonRecover::Read;
	}
	if (current == JsonRead::NoMemory)
		return JsonRecover::NoMemory;
	JsonRead old = read(backup);
	if (old == JsonRead::NoMemory)
		return JsonRecover::NoMemory;
	if (old != JsonRead::Ok)
		return JsonRecover::Failed;
	if (fs.exists(path))
		fs.remove(path);
	if (!fs.rename(backup, path))
		return JsonRecover::Failed;
	return JsonRecover::Recovered;
}

// The settings files: config.json and what an atomic write leaves of it.
static const char *const SETTINGS_FILES[] = {"/config.json", "/config.json.bak", "/config.json.tmp"};

// BOOT-hold recovery on a filesystem that mounts: removes the settings and
// nothing else, so the users in /P and the logs survive (it used to format
// the whole partition). fs: exists/remove. False if one is still there.
template <typename FS>
bool eraseSettingsFiles(FS &fs)
{
	for (const char *name : SETTINGS_FILES)
		if (fs.exists(name))
			fs.remove(name);
	for (const char *name : SETTINGS_FILES)
		if (fs.exists(name))
			return false;
	return true;
}

// Which reset: the web page's factory reset, or BOOT-hold recovery (both its
// paths: settings-only erase and the full-format fallback).
enum class ResetKind
{
	Factory,
	Recovery,
};

// NVS keys (storage.esp) every reset removes: the commissioned flag, an admin
// password set before the first save (its hash; "adminpw" held it in clear
// up to 1.4.1), and the lockout levels.
static const char *const RESET_NVS_KEYS[] = {"commissioned", "adminha1", "adminpw", "pinlock", "pinlock1", "pinlock2", "cardlock1", "cardlock2"};

// The exit-button boot copy (door.esp "exitboot"). A factory reset removes
// it: a blank board went on opening on the old exit buttons. BOOT-hold
// recovery keeps it, so the exit buttons of a board whose settings were lost
// still open its doors (2026-10-15).
// The relay copy (config.esp "relayboot": each relay pin and its locked
// level) survives both: erasing it (1.4.2 to 1.5.0) left the relay pins of a
// freshly reset board undriven from power-up, floating, so the lock could
// release. It is rewritten by the next settings the board loads
// (2026-10-16, J11 option b).
static const char *const FACTORY_NVS_KEYS[] = {"exitboot"};

// nvs: isKey/remove (Preferences, opened read-write).
template <typename Nvs>
void clearResetNvsKeys(Nvs &nvs, ResetKind kind)
{
	for (const char *key : RESET_NVS_KEYS)
		if (nvs.isKey(key))
			nvs.remove(key);
	if (kind == ResetKind::Factory)
		for (const char *key : FACTORY_NVS_KEYS)
			if (nvs.isKey(key))
				nvs.remove(key);
}

} // namespace core
