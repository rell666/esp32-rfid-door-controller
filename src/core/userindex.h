// The users held in RAM, sorted by uid, for the lists: the Users page, Backup
// users and MQTT getuserlist. Each page of 50 used to open 50 user files
// inside one WebSocket message, and LittleFS scans the folder for every open,
// so a card or an exit button waited up to about 11 s while the page or a
// backup loaded (ledger H27.6, review 7 V1). The files stay the record: card
// decisions still read the user's own file.
//
// Built after start-up one file per loop() pass (build() in storage.esp), so
// the start stays fast; until ready() the lists read the files as before.
// Kept in step by the two places a user file changes: an atomic write of
// /P/<uid> (put) and removeUserFiles (erase); deleting every user clears it.
#pragma once

#include <ArduinoJson.h>
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "core/userrecord.h"
#include "core/validate.h"

namespace core
{

struct UserEntry
{
	std::string uid;
	std::string name;
	std::string pin;
	int acctype[4] = {0, 0, 0, 0};
	uint32_t validSince = 0;
	uint32_t validUntil = 0;
};

class UserIndex
{
public:
	// The stored record (the JSON in /P/<uid>) for uid, added or replaced.
	void put(const char *uid, JsonObjectConst rec)
	{
		if (!isValidUid(uid))
			return;
		UserEntry e;
		e.uid = uid;
		e.name = rec["user"] | "";
		e.pin = rec["pincode"] | "";
		const char *keys[] = {"acctype", "acctype2", "acctype3", "acctype4"};
		// as the reader reads them (rfid.esp FirmwareUserIo::lookup)
		for (int i = 0; i < 4; i++)
			e.acctype[i] = recordRole(rec[keys[i]]);
		e.validSince = recordEpoch(rec["validsince"]);
		e.validUntil = recordEpoch(rec["validuntil"]);
		auto it = find(e.uid);
		if (it != _users.end() && it->uid == e.uid)
			*it = std::move(e);
		else
			_users.insert(it, std::move(e));
	}

	void erase(const char *uid)
	{
		auto it = find(uid);
		if (it != _users.end() && it->uid == uid)
			_users.erase(it);
	}

	// Every user deleted, or the index cannot be trusted: empty, and not
	// ready until a new build() finishes.
	void clear()
	{
		_users.clear();
		_users.shrink_to_fit();
		_ready = false;
	}

	bool ready() const { return _ready; }
	void setReady() { _ready = true; }
	size_t size() const { return _users.size(); }
	const UserEntry &at(size_t i) const { return _users[i]; }
	bool contains(const char *uid) const
	{
		auto it = std::lower_bound(_users.begin(), _users.end(), std::string(uid), less);
		return it != _users.end() && it->uid == uid;
	}

	// The first user after uid in uid order ("" for the first), or nullptr:
	// a cursor that survives users added or removed between steps.
	const UserEntry *after(const std::string &uid) const
	{
		auto it = std::upper_bound(_users.begin(), _users.end(), uid,
								   [](const std::string &u, const UserEntry &e) { return u < e.uid; });
		return it == _users.end() ? nullptr : &*it;
	}

	// The entry as a stored record (the keys of /P/<uid>), the PIN only with withPin.
	static void toRecord(const UserEntry &e, JsonObject out, bool withPin)
	{
		out["user"] = e.name; // std::string: copied into the document
		const char *keys[] = {"acctype", "acctype2", "acctype3", "acctype4"};
		for (int i = 0; i < 4; i++)
			out[keys[i]] = e.acctype[i];
		out["validsince"] = e.validSince;
		out["validuntil"] = e.validUntil;
		if (withPin)
			out["pincode"] = e.pin;
	}

	// One step of a build over the user folder. Io supplies:
	//   bool nextUid(std::string &uid)  the next valid user name in /P, false at the end
	//   bool read(const char *uid, JsonDocument &doc)  that user's record
	// A user that cannot be read is left out (it opens nothing either). True
	// while there is more to read; at the end the index is ready.
	template <typename Io>
	bool buildStep(Io &io, JsonDocument &doc)
	{
		std::string uid;
		if (!io.nextUid(uid))
		{
			_ready = true;
			return false;
		}
		doc.clear();
		if (io.read(uid.c_str(), doc))
			put(uid.c_str(), doc.as<JsonObjectConst>());
		return true;
	}

private:
	std::vector<UserEntry> _users;
	bool _ready = false;

	static bool less(const UserEntry &e, const std::string &uid) { return e.uid < uid; }
	std::vector<UserEntry>::iterator find(const std::string &uid)
	{
		return std::lower_bound(_users.begin(), _users.end(), uid, less);
	}
};

} // namespace core
