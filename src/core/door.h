// One door's contact: Door Open / Door Closed, forced entry (opened while the
// lock was not released) and the open-too-long alarm. Pure, so it is tested
// on the host; door.esp keeps one per door and acts on the result (event
// log, MQTT "door"/"tamper" state).
#pragma once

#include <cstdint>

namespace core
{

struct DoorLog
{
	const char *type; // "INFO" / "WARN"
	const char *src;  // "door" / "tamper"
	const char *desc;
};

struct DoorUpdate
{
	int logs = 0;
	DoorLog log[2];
	bool doorChanged = false; // publish the door state
	bool doorOpen = false;
	bool tamperChanged = false; // publish the tamper state
	bool tamper = false;

	void add(const char *type, const char *src, const char *desc)
	{
		if (logs < 2)
			log[logs++] = DoorLog{type, src, desc};
	}
};

// A door opened this soon after its lock relocked is a normal entry, not a
// forced one: someone pulling the door just as the pulse ends, or a slow
// maglock release.
static const uint32_t DOOR_RELOCK_GRACE_MS = 3000;

// A door contact closes to GND when the door is shut, and its pin has the
// internal pull-up: LOW is shut, HIGH is open. A cut or unplugged contact
// wire also reads HIGH, so it shows as open (and raises the alarms) instead
// of hiding a forced door. Upstream read LOW as open, the reverse of the
// documented wiring.
inline bool contactOpen(int level) { return level != 0; }

// A doorbell button also closes to GND (pull-up on the pin): LOW is ringing.
// Upstream treated HIGH as ringing, so an idle button rang from boot.
inline bool doorbellPressed(int level) { return level == 0; }

// The doorbell's ringing state from its debounced press: one change per
// press, so one log line and one MQTT ON/OFF pair.
class DoorbellMonitor
{
public:
	// pressed: the debounced button is pressed. Returns +1 when it starts
	// ringing, -1 when it stops, 0 otherwise.
	int update(bool pressed)
	{
		if (pressed == _ringing)
			return 0;
		_ringing = pressed;
		return pressed ? 1 : -1;
	}

	bool ringing() const { return _ringing; }

private:
	bool _ringing = false;
};

class DoorMonitor
{
public:
	// contactOpen: the debounced contact reads open. lockReleased: the
	// door's relay is energised (or the door has no relay). now: uptime ms
	// (64-bit). maxOpenSeconds: 0 = no alarm.
	DoorUpdate update(bool contactOpen, bool lockReleased, uint64_t now, uint32_t maxOpenSeconds)
	{
		DoorUpdate u;
		if (lockReleased)
		{
			_wasReleased = true;
			_releasedAt = now;
		}
		bool justRelocked = _wasReleased && now - _releasedAt < DOOR_RELOCK_GRACE_MS;
		if (!_started)
		{
			_started = true;
			_open = contactOpen;
			u.doorChanged = true;
			u.doorOpen = contactOpen;
			if (contactOpen)
			{
				_openSince = now;
				if (!lockReleased)
					raise(u, "Door was open when controller started");
			}
			return u;
		}
		if (_open && !contactOpen)
		{
			_open = false;
			u.add("INFO", "door", "Door Closed");
			u.doorChanged = true;
			u.doorOpen = false;
			if (_tamper)
			{
				_tamper = false;
				u.tamperChanged = true;
				u.tamper = false;
			}
			return u;
		}
		if (!_open && contactOpen)
		{
			_open = true;
			u.add("INFO", "door", "Door Open");
			u.doorChanged = true;
			u.doorOpen = true;
			if (!lockReleased && !justRelocked)
				raise(u, "Door was tampered!");
			else
				_openSince = now;
			return u;
		}
		if (maxOpenSeconds != 0 && _open && !_tamper && now - _openSince >= (uint64_t)maxOpenSeconds * 1000)
			raise(u, "Door wasn't closed within max open time!");
		return u;
	}

	bool open() const { return _open; }
	bool tamper() const { return _tamper; }

private:
	bool _started = false;
	bool _open = false;
	bool _tamper = false;
	uint64_t _openSince = 0;
	bool _wasReleased = false; // the lock has been seen released since boot
	uint64_t _releasedAt = 0;  // last update() that saw it released

	void raise(DoorUpdate &u, const char *desc)
	{
		_tamper = true;
		u.add("WARN", "tamper", desc);
		u.tamperChanged = true;
		u.tamper = true;
	}
};

} // namespace core
