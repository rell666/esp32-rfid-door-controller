// The admin (web UI) password is stored as its HTTP Digest HA1,
// MD5("admin:ironframe-rfid:<password>"), never as typed: the login checks
// a Digest response against it directly (passwordIsHash), so the password
// itself is not kept anywhere on the device. Until 1.4.2 config.json held it
// in clear; parseSettings() hashes such a value and says so, and the firmware
// then rewrites config.json once.
//
// config.json "general": "pswd" the HA1 (32 lowercase hex), "pswdhash": 1
// (it is a hash: a 1.4.1 password that happens to be 32 hex characters is
// still recognised as plain text), "pswdchange": 1 while the factory (or a
// too-short legacy) password is in force and must be changed.
#pragma once

#include <ArduinoJson.h>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "core/jsonutil.h"
#include "core/validate.h"

namespace core
{

// The Digest username and realm of /login (webserver.esp).
static const char ADMIN_USER[] = "admin";
static const char ADMIN_REALM[] = "ironframe-rfid";
// adminHa1("admin"): the factory password, the state of a fresh device
static const char FACTORY_ADMIN_HA1[] = "a74c19259b8c3e6262ddca95dd114730";
static const size_t HA1_HEX = 32;

// MD5 (RFC 1321), incremental, no allocation: the firmware's MD5Builder is
// not available to the native tests, and one implementation serves both.
class Md5
{
public:
	Md5() { reset(); }
	void reset()
	{
		s_[0] = 0x67452301;
		s_[1] = 0xefcdab89;
		s_[2] = 0x98badcfe;
		s_[3] = 0x10325476;
		len_ = 0;
	}
	void add(const void *data, size_t n)
	{
		const uint8_t *p = static_cast<const uint8_t *>(data);
		while (n--)
		{
			buf_[len_ % 64] = *p++;
			if (++len_ % 64 == 0)
				block(buf_);
		}
	}
	void add(const char *s) { add(s, strlen(s)); }
	// 32 lowercase hex characters and a NUL
	void hex(char out[HA1_HEX + 1])
	{
		uint64_t bits = len_ * 8;
		uint8_t pad = 0x80;
		add(&pad, 1);
		pad = 0;
		while (len_ % 64 != 56)
			add(&pad, 1);
		uint8_t lenBytes[8];
		for (int i = 0; i < 8; i++)
			lenBytes[i] = (uint8_t)(bits >> (8 * i));
		add(lenBytes, 8);
		static const char digits[] = "0123456789abcdef";
		for (int i = 0; i < 16; i++)
		{
			uint8_t b = (uint8_t)(s_[i / 4] >> (8 * (i % 4)));
			out[2 * i] = digits[b >> 4];
			out[2 * i + 1] = digits[b & 15];
		}
		out[HA1_HEX] = '\0';
		reset();
	}

private:
	static uint32_t rol(uint32_t x, int c) { return (x << c) | (x >> (32 - c)); }
	void block(const uint8_t *b)
	{
		static const uint32_t K[64] = {
			0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
			0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
			0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
			0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
			0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
			0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
			0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
			0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
		static const int R[16] = {7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21};
		uint32_t m[16];
		for (int i = 0; i < 16; i++)
			m[i] = (uint32_t)b[4 * i] | ((uint32_t)b[4 * i + 1] << 8) | ((uint32_t)b[4 * i + 2] << 16) | ((uint32_t)b[4 * i + 3] << 24);
		uint32_t a = s_[0], bb = s_[1], c = s_[2], d = s_[3];
		for (int i = 0; i < 64; i++)
		{
			uint32_t f;
			int g;
			if (i < 16)
				f = (bb & c) | (~bb & d), g = i;
			else if (i < 32)
				f = (d & bb) | (~d & c), g = (5 * i + 1) % 16;
			else if (i < 48)
				f = bb ^ c ^ d, g = (3 * i + 5) % 16;
			else
				f = c ^ (bb | ~d), g = (7 * i) % 16;
			uint32_t t = d;
			d = c;
			c = bb;
			bb = bb + rol(a + f + K[i] + m[g], R[(i / 16) * 4 + i % 4]);
			a = t;
		}
		s_[0] += a;
		s_[1] += bb;
		s_[2] += c;
		s_[3] += d;
	}
	uint32_t s_[4];
	uint64_t len_;
	uint8_t buf_[64];
};

// HA1 of a password as typed, for the login's username and realm.
inline void adminHa1(const char *password, char out[HA1_HEX + 1])
{
	Md5 md5;
	md5.add(ADMIN_USER);
	md5.add(":");
	md5.add(ADMIN_REALM);
	md5.add(":");
	md5.add(password ? password : "");
	md5.hex(out);
}

// 32 lowercase hex characters, as adminHa1() writes and the login compares.
inline bool isHa1(const char *s)
{
	if (s == nullptr || strlen(s) != HA1_HEX)
		return false;
	for (const char *p = s; *p; p++)
		if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f')))
			return false;
	return true;
}

// Same-length strings compared in time that does not depend on where they differ.
inline bool sameSecret(const char *a, const char *b)
{
	size_t la = strlen(a), lb = strlen(b);
	unsigned char diff = la != lb;
	for (size_t i = 0; i < la && i < lb; i++)
		diff |= (unsigned char)(a[i] ^ b[i]);
	return diff == 0;
}

// True if `password` (as typed) is the one whose HA1 is stored.
inline bool adminPasswordMatches(const char *password, const char *storedHa1)
{
	char ha1[HA1_HEX + 1];
	adminHa1(password, ha1);
	return sameSecret(ha1, storedHa1);
}

// Change Password without the password on the wire (review 6: it was sent in
// clear over ws://, the old one too). The page sends the new password's HA1
// encrypted with a key that only the current HA1 and this session's token
// give, and a proof that it knows the current HA1:
//   key   = MD5(currentHa1 ":" token ":set-key")       (16 bytes)
//   enc   = hex(newHa1 bytes XOR key)
//   proof = MD5(currentHa1 ":" token ":" newHa1)
// Someone watching the link sees neither password. The token is single-use
// here (a change ends every session), so the key is too. Returns false if
// the proof does not match; otherwise newHa1 holds the new HA1.
inline bool hexByte(const char *h, uint8_t &out)
{
	uint8_t v = 0;
	for (int i = 0; i < 2; i++)
	{
		char c = h[i];
		v = (uint8_t)(v << 4);
		if (c >= '0' && c <= '9')
			v |= (uint8_t)(c - '0');
		else if (c >= 'a' && c <= 'f')
			v |= (uint8_t)(c - 'a' + 10);
		else
			return false;
	}
	out = v;
	return true;
}

inline void passwordChangeKey(const char *currentHa1, const char *token, char keyHex[HA1_HEX + 1])
{
	Md5 md5;
	md5.add(currentHa1);
	md5.add(":");
	md5.add(token);
	md5.add(":set-key");
	md5.hex(keyHex);
}

inline bool openPasswordChange(const char *currentHa1, const char *token, const char *enc, const char *proof, char newHa1[HA1_HEX + 1])
{
	if (!isHa1(currentHa1) || token == nullptr || *token == '\0' || !isHa1(enc) || !isHa1(proof))
		return false;
	char key[HA1_HEX + 1];
	passwordChangeKey(currentHa1, token, key);
	static const char HEX_DIGITS[] = "0123456789abcdef";
	for (size_t i = 0; i < HA1_HEX; i += 2)
	{
		uint8_t e, k;
		if (!hexByte(enc + i, e) || !hexByte(key + i, k))
			return false;
		uint8_t v = (uint8_t)(e ^ k);
		newHa1[i] = HEX_DIGITS[v >> 4];
		newHa1[i + 1] = HEX_DIGITS[v & 15];
	}
	newHa1[HA1_HEX] = '\0';
	Md5 md5;
	md5.add(currentHa1);
	md5.add(":");
	md5.add(token);
	md5.add(":");
	md5.add(newHa1);
	char want[HA1_HEX + 1];
	md5.hex(want);
	return sameSecret(want, proof);
}

// Step-up (plan 1.9 S1, review 7 V7): a firmware update, a factory reset
// and a settings save that changes network or MQTT need the admin password
// as well as a session, so a session token sniffed from the plain-HTTP
// WebSocket URL is not enough to install firmware or move the device to
// another broker. The page answers a one-use challenge (nonce) from the
// device with MD5(HA1 ":" token ":" nonce ":" action); it keeps the HA1 of
// the password it signed in with in memory, and asks again after a reload.
inline void stepUpProof(const char *ha1, const char *token, const char *nonce, const char *action, char out[HA1_HEX + 1])
{
	Md5 md5;
	md5.add(ha1);
	md5.add(":");
	md5.add(token);
	md5.add(":");
	md5.add(nonce);
	md5.add(":");
	md5.add(action);
	md5.hex(out);
}

inline bool stepUpProofOk(const char *ha1, const char *token, const char *nonce, const char *action, const char *proof)
{
	if (!isHa1(ha1) || token == nullptr || *token == '\0' || nonce == nullptr || *nonce == '\0' || action == nullptr || !isHa1(proof))
		return false;
	char want[HA1_HEX + 1];
	stepUpProof(ha1, token, nonce, action, want);
	return sameSecret(want, proof);
}

// The settings keys a save may change only with a step-up: the network
// (Wi-Fi, addresses, hotspot), MQTT (the broker, its topic, door control
// and remote admin) and, since 1.9.1, hardware (pins, relay type and
// level, relay time, exit buttons, the PIN rules, which apply live: review
// 8 V1) sections.
inline bool stepUpNeededFor(const std::string &changedKey)
{
	return changedKey.compare(0, 8, "network.") == 0 || changedKey.compare(0, 5, "mqtt.") == 0 || changedKey.compare(0, 9, "hardware.") == 0;
}

struct AdminPassword
{
	char ha1[HA1_HEX + 1] = {};
	bool mustChange = true; // the factory (or a too-short legacy) password is in force
	bool migrated = false;	// it was stored in clear: rewrite it as the hash
};

// The admin password of a config.json "general" section. Missing: the
// factory password, nothing to rewrite. Stored in clear (before 1.4.2): its
// HA1, and it must be changed if it was the factory one or too short.
inline AdminPassword storedAdminPassword(JsonObjectConst general)
{
	AdminPassword a;
	const char *pswd = general.isNull() ? nullptr : general["pswd"].as<const char *>();
	if (pswd == nullptr)
	{
		strcpy(a.ha1, FACTORY_ADMIN_HA1);
		return a;
	}
	if (jsonInt(general["pswdhash"], 0) == 1 && isHa1(pswd))
	{
		strcpy(a.ha1, pswd);
		a.mustChange = jsonInt(general["pswdchange"], 0) == 1;
		return a;
	}
	adminHa1(pswd, a.ha1);
	a.mustChange = needsPasswordChange(pswd);
	a.migrated = true;
	return a;
}

// Writes the stored form into a config.json "general" section.
inline void putAdminPassword(JsonObject general, const char *ha1, bool mustChange)
{
	general["pswd"] = (char *)ha1; // copied
	general["pswdhash"] = 1;
	if (mustChange)
		general["pswdchange"] = 1;
	else
		general.remove("pswdchange");
}

} // namespace core
