// Login throttling and WebSocket session tokens.
// Pure C++ so the policy is unit-tested on the host; the firmware supplies
// the time (milliseconds since boot, 64-bit, so nothing wraps) and a hardware
// RNG.
#pragma once

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace core
{

// Failed-login throttle. Per client IP: after MAX_FAILURES wrong passwords
// inside WINDOW_MS, that IP is refused (even with the right password) for
// BLOCK_MS. Unknown IPs evict the least recently seen slot, so on its own an
// attacker cycling through 9+ addresses guessed without limit. Device-wide:
// GLOBAL_MAX_FAILURES inside WINDOW_MS from any IPs refuse every login for
// GLOBAL_FIRST_MS, doubling while it goes on (to GLOBAL_MAX_MS), back to the
// start after a successful login or GLOBAL_QUIET_MS without failures. The
// cost: someone guessing can keep the admin out of the web UI meanwhile;
// cards, PINs and signed-in sessions keep working.
class LoginLimiter
{
public:
	static const uint8_t MAX_FAILURES = 5;
	static const uint32_t WINDOW_MS = 5UL * 60UL * 1000UL;
	static const uint32_t BLOCK_MS = 5UL * 60UL * 1000UL;
	static const size_t SLOTS = 8;
	static const uint8_t GLOBAL_MAX_FAILURES = 20;
	static const uint32_t GLOBAL_FIRST_MS = 60UL * 1000UL;
	static const uint32_t GLOBAL_MAX_MS = 15UL * 60UL * 1000UL;
	static const uint32_t GLOBAL_QUIET_MS = 60UL * 60UL * 1000UL;

	// /login: refused for this IP or for everyone. (The WebSocket upgrade,
	// which needs a session token, only checks the per-IP block.)
	bool loginRefused(uint32_t ip, uint64_t now) const { return isBlocked(ip, now) || globallyBlocked(now); }
	bool globallyBlocked(uint64_t now) const { return now < _globalUntil; }

	// How long /login stays refused for this IP (ms; 0 = not refused): the
	// longer of its own block and a device-wide one. Sent as Retry-After so
	// the sign-in page can say the real wait (1-15 min device-wide, 5 per IP).
	uint64_t refusedForMs(uint32_t ip, uint64_t now) const
	{
		uint64_t wait = globallyBlocked(now) ? _globalUntil - now : 0;
		if (isBlocked(ip, now))
		{
			uint64_t own = find(ip)->blockedUntil - now;
			if (own > wait)
				wait = own;
		}
		return wait;
	}

	bool isBlocked(uint32_t ip, uint64_t now) const
	{
		const Slot *s = find(ip);
		return s != nullptr && s->blocked && now < s->blockedUntil;
	}

	// Returns true if this failure caused (or continues) a block.
	bool recordFailure(uint32_t ip, uint64_t now)
	{
		bool global = recordGlobalFailure(now);
		Slot *s = findOrAlloc(ip, now);
		if (s->blocked && now >= s->blockedUntil)
		{
			s->blocked = false;
			s->failures = 0;
		}
		if (s->failures == 0 || (now - s->firstFailure) > WINDOW_MS)
		{
			s->failures = 0;
			s->firstFailure = now;
		}
		s->lastSeen = now;
		if (s->failures < 255)
			s->failures++;
		if (s->failures >= MAX_FAILURES)
		{
			s->blocked = true;
			s->blockedUntil = now + BLOCK_MS;
		}
		return s->blocked || global;
	}

	void recordSuccess(uint32_t ip)
	{
		Slot *s = find(ip);
		if (s != nullptr && !s->blocked)
			*s = Slot();
		_globalFailures = 0;
		_globalBlockMs = 0;
	}

private:
	struct Slot
	{
		uint32_t ip = 0;
		bool used = false;
		uint8_t failures = 0;
		bool blocked = false;
		uint64_t firstFailure = 0;
		uint64_t blockedUntil = 0;
		uint64_t lastSeen = 0;
	};
	Slot _slots[SLOTS];
	uint8_t _globalFailures = 0;
	uint64_t _globalFirst = 0, _globalLast = 0, _globalUntil = 0;
	uint32_t _globalBlockMs = 0; // length of the last device-wide block; 0 = none

	bool recordGlobalFailure(uint64_t now)
	{
		if (_globalBlockMs != 0 && now - _globalLast > GLOBAL_QUIET_MS)
			_globalBlockMs = 0;
		_globalLast = now;
		if (globallyBlocked(now))
			return true;
		if (_globalFailures == 0 || now - _globalFirst > WINDOW_MS)
		{
			_globalFailures = 0;
			_globalFirst = now;
		}
		if (++_globalFailures < GLOBAL_MAX_FAILURES)
			return false;
		_globalFailures = 0;
		_globalBlockMs = _globalBlockMs == 0 ? GLOBAL_FIRST_MS : (_globalBlockMs >= GLOBAL_MAX_MS / 2 ? GLOBAL_MAX_MS : _globalBlockMs * 2);
		_globalUntil = now + _globalBlockMs;
		return true;
	}

	const Slot *find(uint32_t ip) const
	{
		for (const Slot &s : _slots)
			if (s.used && s.ip == ip)
				return &s;
		return nullptr;
	}
	Slot *find(uint32_t ip)
	{
		for (Slot &s : _slots)
			if (s.used && s.ip == ip)
				return &s;
		return nullptr;
	}
	Slot *findOrAlloc(uint32_t ip, uint64_t now)
	{
		Slot *s = find(ip);
		if (s)
			return s;
		Slot *victim = &_slots[0];
		for (Slot &c : _slots)
		{
			if (!c.used)
			{
				victim = &c;
				break;
			}
			// never evict an active block while a free/unblocked slot exists
			bool cActive = c.blocked && now < c.blockedUntil;
			bool vActive = victim->blocked && now < victim->blockedUntil;
			if ((vActive && !cActive) || (vActive == cActive && c.lastSeen < victim->lastSeen))
				victim = &c;
		}
		*victim = Slot();
		victim->used = true;
		victim->ip = ip;
		victim->lastSeen = now;
		return victim;
	}
};

// Random bearer tokens handed out by /login and required on the WebSocket
// upgrade (?token=...) and on /update. This replaces upstream's reliance on
// the browser replaying cached Basic credentials, which any web page the
// admin visited could trigger (cross-site WebSocket hijacking).
class SessionStore
{
public:
	static const size_t SLOTS = 4;
	static const size_t TOKEN_HEX = 32; // 128 bits
	static const uint32_t IDLE_MS = 12UL * 60UL * 60UL * 1000UL;
	// however busy: a token that kept being used never ended until a restart
	// or a password change (review 7, plan 1.9 S2)
	static const uint32_t MAX_AGE_MS = 24UL * 60UL * 60UL * 1000UL;

	typedef uint32_t (*RandomFn)();

	// Writes a new NUL-terminated token into out (TOKEN_HEX + 1 bytes).
	void issue(RandomFn rnd, uint64_t now, char *out)
	{
		Slot *victim = &_slots[0];
		for (Slot &s : _slots)
		{
			if (!s.used || expired(s, now))
			{
				victim = &s;
				break;
			}
			if (s.lastUsed < victim->lastUsed)
				victim = &s;
		}
		static const char hex[] = "0123456789abcdef";
		for (size_t i = 0; i < TOKEN_HEX; i += 8)
		{
			uint32_t r = rnd();
			for (size_t j = 0; j < 8; j++)
			{
				victim->token[i + j] = hex[r & 0xF];
				r >>= 4;
			}
		}
		victim->token[TOKEN_HEX] = '\0';
		victim->used = true;
		victim->lastUsed = now;
		victim->issued = now;
		memcpy(out, victim->token, TOKEN_HEX + 1);
	}

	// Constant-time comparison against every live slot; refreshes on success.
	bool validate(const char *token, uint64_t now)
	{
		if (token == nullptr || strlen(token) != TOKEN_HEX)
			return false;
		bool ok = false;
		for (Slot &s : _slots)
		{
			if (!s.used || expired(s, now))
				continue;
			uint8_t diff = 0;
			for (size_t i = 0; i < TOKEN_HEX; i++)
				diff |= (uint8_t)(s.token[i] ^ token[i]);
			if (diff == 0)
			{
				s.lastUsed = now;
				ok = true;
			}
		}
		return ok;
	}

	// Still valid, without counting as a use (the open-socket sweep: a
	// socket must close once its session has ended, idle or at the 24 h cap).
	bool alive(const char *token, uint64_t now) const
	{
		if (token == nullptr || strlen(token) != TOKEN_HEX)
			return false;
		bool ok = false;
		for (const Slot &s : _slots)
		{
			if (!s.used || expired(s, now))
				continue;
			uint8_t diff = 0;
			for (size_t i = 0; i < TOKEN_HEX; i++)
				diff |= (uint8_t)(s.token[i] ^ token[i]);
			ok = ok || diff == 0;
		}
		return ok;
	}

	void revokeAll()
	{
		for (Slot &s : _slots)
			s = Slot();
	}

	// Logout: forget one token (constant-time match).
	void revoke(const char *token)
	{
		if (token == nullptr || strlen(token) != TOKEN_HEX)
			return;
		for (Slot &s : _slots)
		{
			if (!s.used)
				continue;
			uint8_t diff = 0;
			for (size_t i = 0; i < TOKEN_HEX; i++)
				diff |= (uint8_t)(s.token[i] ^ token[i]);
			if (diff == 0)
				s = Slot();
		}
	}

private:
	struct Slot
	{
		bool used = false;
		uint64_t lastUsed = 0;
		uint64_t issued = 0;
		char token[TOKEN_HEX + 1] = {0};
	};
	Slot _slots[SLOTS];

	static bool expired(const Slot &s, uint64_t now) { return (now - s.lastUsed) > IDLE_MS || (now - s.issued) > MAX_AGE_MS; }
};

// Digest-auth nonces issued by /login's 401 challenge. Each one is accepted
// once and only for NONCE_TTL_MS, so a sniffed Authorization header cannot be
// replayed to mint new session tokens (the web server library alone does not
// check that a nonce was ever issued).
class NonceStore
{
public:
	static const size_t SLOTS = 16;
	static const size_t NONCE_HEX = 32;
	static const uint32_t NONCE_TTL_MS = 120UL * 1000UL;
	// live nonces one address may hold: a /login flood from one address
	// replaces its own, and cannot evict another's between its challenge and
	// its answer (it took all 8 slots, and every other login failed)
	static const size_t PER_OWNER = 2;

	// owner: the client's address (IPv4 as a number)
	void issue(SessionStore::RandomFn rnd, uint64_t now, char *out, uint32_t owner = 0)
	{
		Slot *victim = nullptr, *mineOldest = nullptr;
		size_t mine = 0;
		for (Slot &s : _slots)
		{
			if (s.used && (now - s.issued) <= NONCE_TTL_MS && s.owner == owner)
			{
				mine++;
				if (mineOldest == nullptr || s.issued < mineOldest->issued)
					mineOldest = &s;
			}
		}
		if (mine >= PER_OWNER)
			victim = mineOldest;
		else
		{
			// a free or stale slot; else the oldest of an address that holds
			// PER_OWNER, so addresses with one challenge each are never pushed
			// out by a few that hold two (four addresses took all 8 slots and
			// the admin's answer always failed: review 7, plan 1.9 S3); only if
			// every address holds one, the oldest
			Slot *oldest = &_slots[0], *oldestFull = nullptr;
			for (Slot &s : _slots)
			{
				if (!s.used || (now - s.issued) > NONCE_TTL_MS)
				{
					victim = &s;
					break;
				}
				if (s.issued < oldest->issued)
					oldest = &s;
				if (held(s.owner, now) >= PER_OWNER && (oldestFull == nullptr || s.issued < oldestFull->issued))
					oldestFull = &s;
			}
			if (victim == nullptr)
				victim = oldestFull ? oldestFull : oldest;
		}
		static const char hex[] = "0123456789abcdef";
		for (size_t i = 0; i < NONCE_HEX; i += 8)
		{
			uint32_t r = rnd();
			for (size_t j = 0; j < 8; j++)
			{
				victim->nonce[i + j] = hex[r & 0xF];
				r >>= 4;
			}
		}
		victim->nonce[NONCE_HEX] = '\0';
		victim->used = true;
		victim->issued = now;
		victim->owner = owner;
		memcpy(out, victim->nonce, NONCE_HEX + 1);
	}

	// live nonces held by one address
	size_t held(uint32_t owner, uint64_t now) const
	{
		size_t n = 0;
		for (const Slot &s : _slots)
			if (s.used && (now - s.issued) <= NONCE_TTL_MS && s.owner == owner)
				n++;
		return n;
	}

	// True if nonce was issued, is fresh and unused; it is spent either way.
	bool consume(const char *nonce, uint64_t now)
	{
		if (nonce == nullptr || strlen(nonce) != NONCE_HEX)
			return false;
		for (Slot &s : _slots)
		{
			if (s.used && strncmp(s.nonce, nonce, NONCE_HEX) == 0)
			{
				bool fresh = (now - s.issued) <= NONCE_TTL_MS;
				s = Slot();
				return fresh;
			}
		}
		return false;
	}

private:
	struct Slot
	{
		bool used = false;
		uint64_t issued = 0;
		uint32_t owner = 0;
		char nonce[NONCE_HEX + 1] = {0};
	};
	Slot _slots[SLOTS];
};

// DNS rebinding: a page on another site whose name the attacker then points
// at this device reaches it with that name in Host. True if host (the Host
// header: a name or IPv4 address, optionally :port and a trailing dot) is
// one of allowed (case-insensitive; empty and 0.0.0.0 entries are skipped).
// An IPv6 literal is refused: the device is reached over IPv4.
inline bool hostAllowed(const char *host, const char *const *allowed, size_t n)
{
	if (host == nullptr)
		return false;
	size_t len = strlen(host);
	const char *colon = strrchr(host, ':');
	if (colon != nullptr)
	{
		if (strchr(host, ':') != colon)
			return false;
		size_t digits = strlen(colon + 1);
		if (digits == 0 || digits > 5)
			return false;
		for (const char *p = colon + 1; *p; p++)
			if (*p < '0' || *p > '9')
				return false;
		len = (size_t)(colon - host);
	}
	if (len > 0 && host[len - 1] == '.')
		len--;
	if (len == 0)
		return false;
	for (size_t i = 0; i < n; i++)
	{
		const char *a = allowed[i];
		if (a == nullptr || *a == '\0' || strcmp(a, "0.0.0.0") == 0 || strlen(a) != len)
			continue;
		size_t j = 0;
		while (j < len && tolower((unsigned char)host[j]) == tolower((unsigned char)a[j]))
			j++;
		if (j == len)
			return true;
	}
	return false;
}

// Extracts the value of key="..." (or key=...) from a Digest Authorization
// header into out. Returns false if absent or too long.
inline bool digestParam(const char *header, const char *key, char *out, size_t outSize)
{
	if (header == nullptr)
		return false;
	size_t kl = strlen(key);
	const char *p = header;
	while ((p = strstr(p, key)) != nullptr)
	{
		bool startOk = (p == header) || p[-1] == ' ' || p[-1] == ',';
		if (startOk && p[kl] == '=')
		{
			const char *v = p + kl + 1;
			bool quoted = (*v == '"');
			if (quoted)
				v++;
			size_t n = 0;
			while (v[n] && (quoted ? v[n] != '"' : (v[n] != ',' && v[n] != ' ')))
			{
				if (n + 1 >= outSize)
					return false;
				out[n] = v[n];
				n++;
			}
			out[n] = '\0';
			return true;
		}
		p += kl;
	}
	return false;
}

} // namespace core
