// One reader's card and keypad session: card read, optional PIN step,
// PIN-only entry, decision. Pure, so every path is unit-tested on the host;
// rfid.esp only reads the hardware, feeds step() and acts on its result
// (log lines, beeps, LEDs, relays, MQTT, the web UI).
//
// Typed digits never leave this class except to be compared: a PIN-only
// user's uid IS the PIN, so a keypad entry is reported as "keypad".
#pragma once

#include <cstdint>
#include <string>

#include "core/access.h"
#include "core/lockout.h"

namespace core
{

static const uint32_t READER_COOLDOWN_MS = 2000;     // input ignored after a decision
// After an unknown card the reader waits longer, so trying card numbers is
// slow: 5 s, 10 s while unknown cards keep coming (another within a minute).
// A cool-down ignores every card, valid ones too (a guess that opened
// during it would make it useless), so it stays short: valid cards never
// lengthen it, and the unknown-card alarm still counts them
// (2026-10-19, plan 1.9 D1; review 7: about 1,800 guesses an hour before).
static const uint32_t READER_UNKNOWN_COOLDOWN_MS = 5000;
static const uint32_t READER_UNKNOWN_REPEAT_COOLDOWN_MS = 10000;
static const uint32_t READER_UNKNOWN_REPEAT_WINDOW_MS = 60000;
static const uint32_t READER_KEY_TIMEOUT_MS = 10000; // keypad silence that ends a PIN entry
static const size_t READER_MAX_DIGITS = 16;

static const uint32_t KEY_ENTER = 0x0D; // '*' on most keypads
static const uint32_t KEY_ESC = 0x1B;   // '#'

// A card number from the hardware.
struct CardRead
{
	std::string uid;
	std::string type; // shown in the web UI and the log
};

// What the firmware's user lookup returns for /P/<uid>.
struct UserRecord
{
	std::string user;
	std::string pincode;
	int acctype[4] = {0, 0, 0, 0};
	uint32_t validSince = 0;
	uint32_t validUntil = 0;
};

// What the user lookup found. Busy: the record could not be read just now
// (out of memory). Taking that as Missing refused a valid card as Unknown
// and counted it toward the unknown-card lockout.
enum class Lookup : uint8_t
{
	Missing,
	Found,
	Busy,
};

struct ReaderSettings
{
	bool pinRequired = false; // "PIN required after a card"
	bool pinOnly = false;     // "Allow PIN only" (digits with no card)
	int door = -1;            // relay this reader opens; -1 = every permitted door
	int numRelays = 1;
	// Wrong PIN-only entries at every reader together (plan 1.9 D4): each
	// guess is tried against every PIN-only user, and two readers gave a
	// guesser twice the tries. Five lock PIN-only entry at every reader;
	// card+PIN keeps its reader's own lockout, so a guesser outside never
	// locks card+PIN at the reader people leave by. nullptr: none.
	PinLockout *pinOnlyLockout = nullptr;
};

enum class Verdict : uint8_t
{
	None,
	Granted,
	Admin,
	NotValid,
	Expired,
	ClockInvalid,
	Unknown,
	WrongPin,
	KeypadLocked,
	NoPin,       // PIN required, and this card's user has no PIN
	Busy,        // the user record could not be read just now: refused, try again
	Cancelled,
};

// What happened in one step(), for the firmware to act on.
struct ReaderResult
{
	bool pinPrompt = false;  // a card was accepted and its PIN is asked for (LED + key beep)
	bool keyPressed = false; // a digit was taken
	bool timedOut = false;   // a PIN entry ran out of time
	Verdict verdict = Verdict::None;
	// set with a verdict:
	std::string shownUid;    // the card number, or "keypad" for a keypad entry
	std::string username;
	std::string type;        // card type ("" for a keypad entry)
	bool keypadEntry = false;
	int acctype = 0;         // the permission that decided
	int acctypes[4] = {0, 0, 0, 0};
	uint8_t relayMask = 0;   // relays to open
	uint32_t lockoutStarted = 0; // ms: this wrong PIN started a keypad lockout
	uint32_t pinOnlyLockoutStarted = 0; // ms: this wrong PIN-only entry locked PIN-only at every reader
	uint32_t cardAlarmStarted = 0; // ms: this unknown card raised this reader's unknown-card alarm

	bool granted() const { return verdict == Verdict::Granted || verdict == Verdict::Admin; }
	bool denied() const
	{
		return verdict == Verdict::NotValid || verdict == Verdict::Expired || verdict == Verdict::ClockInvalid ||
			   verdict == Verdict::WrongPin || verdict == Verdict::KeypadLocked ||
			   verdict == Verdict::NoPin || verdict == Verdict::Busy;
	}
};

// Io supplies:
//   Lookup lookup(const char *uid, UserRecord &out) the user file, if any
//   void clock(AccessInput &in)                    fills now, timeTrusted,
//                                                  hoursRestricted, withinOpeningHours
class ReaderSession
{
public:
	enum class State : uint8_t
	{
		Waiting,    // for a card (or, with PIN-only, a first digit)
		CardSwiped, // a card was read; with PIN required, waiting for its PIN
		PinEntered, // ready to decide
	};

	// After a decision: every card and key is ignored.
	bool coolingDown(uint64_t now) const { return now < _cooldownUntil; }
	bool waitingForPin() const { return _awaitingKeys; }
	// Hardware readers are polled only while nothing is in progress.
	bool idle() const { return _state == State::Waiting && !_awaitingKeys; }
	// A card would be taken now: idle and not cooling down.
	bool acceptsCard(uint64_t now) const { return idle() && !coolingDown(now); }
	// Unknown cards at this reader: raises an alarm, refuses nothing (a valid
	// card always opens; the firmware expires it).
	CardAlarm &cardAlarm() { return _cardAlarm; }
	// Wrong PINs at this reader's keypad (restored, expired and persisted by
	// the firmware, as the card lockout). Per reader: one shared lockout let
	// a stranger at the outside keypad lock card+PIN at the inside reader
	// people leave by.
	PinLockout &pinLockout() { return _pinLockout; }

	// Frames were lost (the Wiegand queue overran) while a PIN was being
	// typed or awaited: the digits are not what was typed, so the entry ends
	// with no decision and no lockout count, and the cool-down starts (it
	// drops the rest of the burst). Returns verdict Cancelled, or None if no
	// PIN entry was in progress (review 8 V4, plan 1.9.1 C1).
	ReaderResult cancel(uint64_t now)
	{
		ReaderResult r;
		if (!_awaitingKeys)
			return r;
		r.verdict = Verdict::Cancelled;
		r.keypadEntry = _keypadOnly || _uid.empty();
		r.shownUid = r.keypadEntry ? std::string("keypad") : _uid;
		end(now);
		return r;
	}

	// One pass: an optional card and an optional key, then the decision if
	// one is due, then the keypad timeout. now: uptime ms (64-bit).
	template <typename Io>
	ReaderResult step(Io &io, const ReaderSettings &cfg, uint64_t now, const CardRead *card, const uint32_t *key)
	{
		ReaderResult r;
		if (coolingDown(now))
			return r;
		if (card != nullptr && acceptsCard(now))
			takeCard(io, cfg, now, *card, r);
		if (key != nullptr)
			takeKey(cfg, now, *key, r);
		if (_state != State::Waiting && _verdict == Verdict::None)
			decide(io, cfg, now);
		if (_verdict != Verdict::None)
		{
			report(now, r, cfg.pinOnlyLockout);
			end(now, _verdict == Verdict::Unknown);
		}
		else if (_awaitingKeys && now - _lastKeyAt >= READER_KEY_TIMEOUT_MS)
		{
			r.timedOut = true;
			end(0);
		}
		return r;
	}

private:
	State _state = State::Waiting;
	Verdict _verdict = Verdict::None;
	std::string _uid, _type, _pin, _input, _user;
	bool _keypadOnly = false;
	bool _awaitingKeys = false; // a PIN is being typed or awaited; the timeout runs
	uint64_t _lastKeyAt = 0;    // uptime ms of the card or the last key
	uint64_t _cooldownUntil = 0;
	uint64_t _lastUnknownAt = 0; // uptime ms of the last unknown card (0: none)
	int _acctype = 0;
	int _acctypes[4] = {0, 0, 0, 0};
	uint8_t _relayMask = 0;
	CardAlarm _cardAlarm;
	PinLockout _pinLockout;

	template <typename Io>
	void takeCard(Io &io, const ReaderSettings &cfg, uint64_t now, const CardRead &card, ReaderResult &r)
	{
		_uid = card.uid;
		_type = card.type;
		_state = State::CardSwiped;
		if (!cfg.pinRequired)
			return;
		// PIN required: a known card with a PIN waits for it, with the keypad
		// timeout running; anything else is decided now (a known card with
		// no PIN is refused: NoPin).
		UserRecord rec;
		Lookup found = findCard(io, rec);
		if (found == Lookup::Busy)
		{
			_verdict = Verdict::Busy;
			_state = State::PinEntered;
		}
		else if (found == Lookup::Found && !rec.pincode.empty() && !isKeypadCredential(rec))
		{
			noteUser(rec, cfg); // a wrong key while waiting refuses before decide()
			_awaitingKeys = true;
			_lastKeyAt = now;
			r.pinPrompt = true;
		}
		else
			_state = State::PinEntered;
	}

	void takeKey(const ReaderSettings &cfg, uint64_t now, uint32_t key, ReaderResult &r)
	{
		bool waitingForCardPin = _state == State::CardSwiped && cfg.pinRequired && _awaitingKeys;
		bool pinOnlyEntry = _state == State::Waiting && cfg.pinOnly;
		if (!waitingForCardPin && !pinOnlyEntry)
			return;
		if (key != KEY_ENTER && key != KEY_ESC)
		{
			if (key > 9 || _input.size() >= READER_MAX_DIGITS)
			{
				_state = State::PinEntered;
				_keypadOnly = _keypadOnly || pinOnlyEntry;
				_verdict = _pinLockout.locked(now) || (_keypadOnly && pinOnlyLocked(cfg, now)) ? Verdict::KeypadLocked : Verdict::WrongPin;
				return;
			}
			_input += (char)('0' + key);
			_awaitingKeys = true;
			_lastKeyAt = now;
			r.keyPressed = true;
			return;
		}
		if (!_awaitingKeys)
			return; // ENTER or ESC with nothing typed or awaited
		if (key == KEY_ESC)
		{
			_verdict = Verdict::Cancelled;
			return;
		}
		_pin = _input;
		_input.clear();
		_awaitingKeys = false;
		if (pinOnlyEntry)
		{
			// the digits are looked up as a uid; checkPin() then insists on
			// the stored pincode, so a card number typed in is not a PIN
			_uid = _pin;
			_type.clear();
			_keypadOnly = true;
		}
		_state = State::PinEntered;
	}

	template <typename Io>
	void decide(Io &io, const ReaderSettings &cfg, uint64_t now)
	{
		if (_state == State::CardSwiped && cfg.pinRequired && !_keypadOnly)
			return; // waiting for the PIN
		if (_keypadOnly && (_pinLockout.locked(now) || pinOnlyLocked(cfg, now)))
		{
			_verdict = Verdict::KeypadLocked;
			return;
		}
		UserRecord rec;
		Lookup found = findCard(io, rec);
		if (found == Lookup::Busy)
		{
			// not known to be absent: neither Unknown nor a wrong PIN, and
			// no lockout counts it
			_verdict = Verdict::Busy;
			return;
		}
		if (found == Lookup::Missing)
		{
			// typed digits that match nobody are a wrong PIN, not an unknown card
			_verdict = _keypadOnly ? Verdict::WrongPin : Verdict::Unknown;
			return;
		}
		if (!_keypadOnly && isKeypadCredential(rec))
		{
			// a card whose number is a keypad-only user's uid (= its PIN) is
			// not that user: refused as an unknown card and counted by the
			// unknown-card alarm (review 8 V2, plan 1.9.1 D3). The card path
			// let it in without a PIN, slowed only by the cool-down.
			_verdict = Verdict::Unknown;
			return;
		}
		if (!_keypadOnly)
			noteUser(rec, cfg); // the card's user, also for the PIN refusals below
		PinPath path = _keypadOnly ? PinPath::PinOnly : (cfg.pinRequired ? PinPath::CardThenPin : PinPath::Card);
		if (path == PinPath::CardThenPin && rec.pincode.empty())
		{
			// refused, but not a wrong PIN: nothing was typed, and the
			// keypad lockout is for guessing
			_verdict = Verdict::NoPin;
			return;
		}
		if (path == PinPath::CardThenPin && !rec.pincode.empty() && _pinLockout.locked(now))
		{
			_verdict = Verdict::KeypadLocked;
			return;
		}
		if (!checkPin(path, _pin.c_str(), rec.pincode.c_str()))
		{
			_verdict = Verdict::WrongPin;
			return;
		}
		_user = rec.user;
		AccessInput in;
		for (int i = 0; i < 4; i++)
		{
			in.acctype[i] = rec.acctype[i];
			_acctypes[i] = rec.acctype[i];
		}
		in.numRelays = cfg.numRelays;
		in.readerDoor = cfg.door;
		in.validSince = rec.validSince;
		in.validUntil = rec.validUntil;
		io.clock(in);
		AccessDecision d = decideAccess(in);
		_acctype = d.acctype;
		_relayMask = d.relayMask;
		switch (d.outcome)
		{
		case AccessOutcome::Granted: _verdict = Verdict::Granted; break;
		case AccessOutcome::Admin: _verdict = Verdict::Admin; break;
		case AccessOutcome::Expired: _verdict = Verdict::Expired; break;
		case AccessOutcome::ClockInvalid: _verdict = Verdict::ClockInvalid; break;
		default: _verdict = Verdict::NotValid; break;
		}
		if (_verdict != Verdict::Granted && _verdict != Verdict::Admin)
			_relayMask = 0;
	}

	// The card's user and its role at this reader's door, for the log: a
	// PIN refusal comes before decideAccess() sets them, and was logged with
	// no role, shown as "Disabled" (ledger H26.2). Never for keypad-only
	// digits: they are not a card, and a wrong PIN must not name anyone.
	void noteUser(const UserRecord &rec, const ReaderSettings &cfg)
	{
		_user = rec.user;
		for (int i = 0; i < 4; i++)
			_acctypes[i] = rec.acctype[i];
		int door = cfg.door < 0 ? 0 : cfg.door;
		_acctype = door < 4 ? rec.acctype[door] : 0;
	}

	// A keypad-only user: stored under its PIN (pincode == uid), so a card
	// with that number must not match it.
	bool isKeypadCredential(const UserRecord &rec) const
	{
		return !rec.pincode.empty() && rec.pincode == _uid;
	}

	// The record for _uid; Busy when it cannot be read.
	template <typename Io>
	Lookup findCard(Io &io, UserRecord &rec)
	{
		return io.lookup(_uid.c_str(), rec);
	}

	static bool pinOnlyLocked(const ReaderSettings &cfg, uint64_t now)
	{
		return cfg.pinOnlyLockout != nullptr && cfg.pinOnlyLockout->locked(now);
	}

	void report(uint64_t now, ReaderResult &r, PinLockout *pinOnlyLockout)
	{
		r.verdict = _verdict;
		bool pinFailed = _verdict == Verdict::WrongPin || _verdict == Verdict::KeypadLocked;
		r.keypadEntry = _keypadOnly || (pinFailed && _uid.empty());
		r.shownUid = r.keypadEntry ? std::string("keypad") : _uid;
		r.type = r.keypadEntry ? std::string() : _type;
		r.username = _user;
		// a refusal nobody is known for (keypad digits, a record that could
		// not be read): "Unknown", not the "Disabled" of role 0
		r.acctype = r.denied() && _user.empty() ? ACC_UNKNOWN : _acctype;
		for (int i = 0; i < 4; i++)
			r.acctypes[i] = _acctypes[i];
		r.relayMask = _relayMask;
		if (_verdict == Verdict::WrongPin)
		{
			r.lockoutStarted = _pinLockout.fail(now);
			if (_keypadOnly && pinOnlyLockout != nullptr)
				r.pinOnlyLockoutStarted = pinOnlyLockout->fail(now);
		}
		if (_verdict == Verdict::Unknown)
			r.cardAlarmStarted = _cardAlarm.fail(now);
	}

	// Back to waiting; now != 0 starts the cool-down, longer after an
	// unknown card (READER_UNKNOWN_COOLDOWN_MS).
	void end(uint64_t now, bool unknown = false)
	{
		_state = State::Waiting;
		_verdict = Verdict::None;
		_uid.clear();
		_type.clear();
		_pin.clear();
		_input.clear();
		_user.clear();
		_keypadOnly = false;
		_awaitingKeys = false;
		_acctype = 0;
		for (int &a : _acctypes)
			a = 0;
		_relayMask = 0;
		if (now == 0)
			return;
		uint32_t wait = READER_COOLDOWN_MS;
		if (unknown)
		{
			bool repeat = _lastUnknownAt != 0 && now - _lastUnknownAt < READER_UNKNOWN_REPEAT_WINDOW_MS;
			wait = repeat ? READER_UNKNOWN_REPEAT_COOLDOWN_MS : READER_UNKNOWN_COOLDOWN_MS;
			_lastUnknownAt = now;
		}
		_cooldownUntil = now + wait;
	}
};

} // namespace core
