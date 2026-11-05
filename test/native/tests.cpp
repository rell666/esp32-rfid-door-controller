// Host-side tests for src/core/*. Built and run by test/native/run.sh.
#include <memory>
#include <ArduinoJson.h>

#include <algorithm>
#include <cassert>
#include <cstdio>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "core/restart.h"
#include "core/wifi.h"
#include "core/wifiidle.h"
#include "core/wsalive.h"
#include "core/storagespace.h"
#include "core/memguard.h"
#include "core/wscommand.h"
#include "core/firmware.h"
#include "core/assembler.h"
#include "core/mqttqueue.h"
#include "core/auth.h"
#include "core/logfile.h"
#include "core/secrets.h"
#include "core/adminpass.h"
#include "core/validate.h"
#include "core/wiegand.h"
#include "core/access.h"
#include "core/feedback.h"
#include "core/pins.h"
#include "core/jsonutil.h"
#include "core/relaytimer.h"
#include "core/lockout.h"
#include "core/userfiles.h"
#include "core/jsonrecover.h"
#include "core/userrecord.h"
#include "core/exitbutton.h"
#include "core/relays.h"
#include "core/configpolicy.h"
#include "core/reader.h"
#include "core/door.h"

#include "magicnumbers.h"
#include "core/settings.h"
#include "core/livesettings.h"
#include "core/userindex.h"

// Old 32-bit millis() boundaries: 2^31 ms = 24.8 days, 2^32 ms = 49.7 days.
static const uint64_t DAYS_24_8 = 1ull << 31;
static const uint64_t WRAP32 = 1ull << 32;

static int failures = 0;
static int checks = 0;
#define CHECK(cond)                                                          \
	do                                                                       \
	{                                                                        \
		checks++;                                                            \
		if (!(cond))                                                         \
		{                                                                    \
			failures++;                                                      \
			fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
		}                                                                    \
	} while (0)

// ---- fakes ---------------------------------------------------------------

struct FakeFile
{
	const std::string *data;
	size_t pos = 0;
	explicit FakeFile(const std::string &d) : data(&d) {}
	bool seek(size_t p)
	{
		if (p > data->size())
			return false;
		pos = p;
		return true;
	}
	size_t position() const { return pos; }
	int read() { return pos < data->size() ? (unsigned char)(*data)[pos++] : -1; }
};

struct FakeFS
{
	std::map<std::string, std::string> files;
	std::set<std::string> stuck; // remove() fails for these (a worn or full flash)
	bool exists(const char *p) { return files.count(p) > 0; }
	bool remove(const char *p) { return !stuck.count(p) && files.erase(p) > 0; }
	bool rename(const char *a, const char *b)
	{
		if (!files.count(a))
			return false;
		files[b] = files[a];
		files.erase(a);
		return true;
	}
};

static std::string makeLog(int lines, int padTo)
{
	std::string s;
	for (int i = 0; i < lines; i++)
	{
		char buf[64];
		snprintf(buf, sizeof(buf), "{\"type\":\"INFO\",\"src\":\"t\",\"desc\":\"line %d\",\"data\":\"", i);
		std::string line = buf;
		while ((int)line.size() < padTo - 3)
			line += 'x';
		line += "\"}\n";
		s += line;
	}
	return s;
}

// Reads a whole log through the pager the same way the browser does.
static std::vector<std::string> readAll(const std::string &log, size_t perPage, size_t docSize, int *pagesOut, bool *overflowSeen)
{
	std::vector<std::string> out;
	size_t pos = 0;
	int pages = 0;
	for (;;)
	{
		DynamicJsonDocument doc(docSize);
		doc["command"] = "eventlist";
		doc["nextpos"] = 0;
		doc["eof"] = false;
		JsonArray items = doc.createNestedArray("list");
		FakeFile f(log);
		core::LogPage p = core::readLogPage(f, pos, perPage, items, doc);
		doc["nextpos"] = p.nextPos;
		doc["eof"] = p.eof;
		if (doc.overflowed() && overflowSeen)
			*overflowSeen = true;
		// what goes over the wire must round-trip
		std::string wire;
		serializeJson(doc, wire);
		DynamicJsonDocument back(docSize * 2);
		CHECK(!deserializeJson(back, wire));
		CHECK(back["nextpos"].as<size_t>() == p.nextPos);
		for (JsonVariant v : back["list"].as<JsonArray>())
			out.push_back(v.as<std::string>());
		pages++;
		if (p.eof)
			break;
		CHECK(p.nextPos > pos); // always progress
		if (p.nextPos <= pos)
			break;
		pos = p.nextPos;
		if (pages > 100000)
			break;
	}
	if (pagesOut)
		*pagesOut = pages;
	return out;
}

// ---- tests ---------------------------------------------------------------

static void testValidators()
{
	CHECK(core::isValidUid("04a1b2c3"));
	CHECK(core::isValidUid("123456"));
	CHECK(!core::isValidUid(""));
	CHECK(!core::isValidUid(nullptr));
	CHECK(!core::isValidUid("../config.json"));
	CHECK(!core::isValidUid("a/b"));
	CHECK(!core::isValidUid("ab cd"));
	CHECK(!core::isValidUid("123456789012345678901234567890123")); // 33

	CHECK(core::isValidLogFilename("/eventlog.json"));
	CHECK(core::isValidLogFilename("/latestlog.json"));
	CHECK(core::isValidLogFilename("/latestlog.json.3"));
	CHECK(core::isValidLogFilename("/eventlog.json.split.12"));
	CHECK(!core::isValidLogFilename("/config.json"));
	CHECK(!core::isValidLogFilename("/P/04a1b2c3"));
	CHECK(!core::isValidLogFilename("/eventlog.json/../config.json"));
	CHECK(!core::isValidLogFilename("/eventlog.json."));
	CHECK(!core::isValidLogFilename("/eventlog.json.1x"));
	CHECK(!core::isValidLogFilename("/eventlog.jsonx"));
	CHECK(!core::isValidLogFilename("eventlog.json"));
	CHECK(!core::isValidLogFilename(nullptr));

	CHECK(core::parseRelayIndex("0", 1) == 0);
	CHECK(core::parseRelayIndex("3", 4) == 3);
	CHECK(core::parseRelayIndex("4", 4) == -1);
	CHECK(core::parseRelayIndex("9", 1) == -1); // upstream wrote activateRelay[9]
	CHECK(core::parseRelayIndex("-1", 4) == -1);
	CHECK(core::parseRelayIndex("1a", 4) == -1);
	CHECK(core::parseRelayIndex("", 4) == -1);
	CHECK(core::parseRelayIndex(nullptr, 4) == -1);

	CHECK(core::isDefaultAdminPassword("admin"));
	CHECK(core::isDefaultAdminPassword(""));
	CHECK(!core::isAcceptableAdminPassword("admin"));
	CHECK(!core::isAcceptableAdminPassword("short"));
	CHECK(core::isAcceptableAdminPassword("correct-horse"));
}

static void testAssembler()
{
	core::MessageAssembler a(16);
	a.reset();
	CHECK(a.append((const uint8_t *)"{\"a\":", 5));
	CHECK(a.append((const uint8_t *)"1}", 2));
	std::string m = a.take();
	CHECK(m == "{\"a\":1}");
	CHECK(m.c_str()[m.size()] == '\0'); // terminated (upstream over-read here)

	// fragments beyond the cap are refused, never written past the buffer
	a.reset();
	CHECK(a.append((const uint8_t *)"0123456789", 10));
	CHECK(!a.append((const uint8_t *)"0123456789", 10));
	CHECK(a.overflowed());
	CHECK(!a.append((const uint8_t *)"x", 1));
	CHECK(a.take().empty());
	CHECK(!a.overflowed()); // take() resets

	// declared total over the cap is rejected up front (no allocation)
	a.reset(1u << 30);
	CHECK(a.overflowed());
	CHECK(!a.append((const uint8_t *)"x", 1));

	// message type: frames as ESPAsyncWebServer 3.7.10 reports them on real
	// hardware (one-read text frame: opcode 1, message_opcode 0)
	const uint8_t TEXT = 1, BINARY = 2, CONT = 0;
	core::MessageAssembler t(64);
	CHECK(t.trackType(TEXT) == TEXT);  // {"command":"setpassword",...} in one frame
	CHECK(t.trackType(TEXT) == TEXT);  // same frame, later TCP chunk restates it
	CHECK(t.trackType(CONT) == TEXT);  // continuation of a fragmented text message
	CHECK(t.trackType(BINARY) == BINARY);
	CHECK(t.trackType(CONT) == BINARY); // binary continuation stays binary
	CHECK(t.trackType(TEXT) == TEXT);   // next message is text again
	core::MessageAssembler fresh(64);
	CHECK(fresh.trackType(CONT) == 0);  // stray continuation with no start: not text

	// exactly at the cap is fine
	a.reset(16);
	CHECK(a.append((const uint8_t *)"0123456789abcdef", 16));
	CHECK(a.take().size() == 16);

	// shared byte budget: queued plus in-progress messages never exceed it
	core::ByteBudget budget(100);
	{
		core::MessageAssembler x(64, &budget), y(64, &budget);
		x.reset(60);
		CHECK(budget.used() == 60);
		y.reset();
		CHECK(y.append((const uint8_t *)"0123456789", 10) && budget.used() == 70);
		CHECK(!y.append((const uint8_t *)"012345678901234567890123456789x", 31)); // 41 > 30 left
		CHECK(y.overflowed() && y.refusedByBudget() && budget.used() == 60); // its 10 given back
		std::string big(60, 'a');
		CHECK(x.append((const uint8_t *)big.data(), 60) && budget.used() == 60); // within its reservation
		size_t held = 0;
		std::string msg = x.take(&held);
		CHECK(msg.size() == 60 && held == 60 && budget.used() == 60); // the queued message keeps its bytes
		y.reset(50);
		CHECK(y.overflowed() && y.refusedByBudget()); // 50 > 40 left
		budget.give(held); // the queue consumer is done with it
		CHECK(budget.used() == 0);
		y.reset(50);
		CHECK(!y.overflowed() && budget.used() == 50);
		y.take(); // no *charged: given back now
		CHECK(budget.used() == 0);
		x.reset(30);
		CHECK(budget.used() == 30);
	}
	CHECK(budget.used() == 0); // destroyed with a message half-assembled: given back
	{
		core::MessageAssembler z(16, &budget);
		z.reset();
		CHECK(!z.append((const uint8_t *)"0123456789abcdefg", 17)); // over its own cap
		CHECK(z.overflowed() && !z.refusedByBudget() && budget.used() == 0);
		size_t held = 99;
		CHECK(z.take(&held).empty() && held == 0);
	}

	// a NULL/absent command must be detectable before strcmp
	DynamicJsonDocument d(256);
	deserializeJson(d, "{\"page\":1}");
	const char *cmd = d["command"];
	CHECK(cmd == nullptr);
}

static uint32_t seq = 0x12345678;
static uint32_t fakeRandom()
{
	seq = seq * 1664525u + 1013904223u;
	return seq;
}

static void testLimiterAndSessions()
{
	core::LoginLimiter l;
	uint32_t ip = 0x0A00000A, other = 0x0A00000B;
	uint32_t t = 1000;
	for (int i = 0; i < 4; i++)
		CHECK(!l.recordFailure(ip, t + i));
	CHECK(!l.isBlocked(ip, t + 10));
	CHECK(l.recordFailure(ip, t + 20)); // 5th
	CHECK(l.isBlocked(ip, t + 21));
	CHECK(!l.isBlocked(other, t + 21));                    // per-IP
	l.recordSuccess(ip);                                     // success while blocked does not clear
	CHECK(l.isBlocked(ip, t + 22));
	CHECK(!l.isBlocked(ip, t + 20 + core::LoginLimiter::BLOCK_MS)); // expires
	// the wait the sign-in page is told (Retry-After)
	CHECK(l.refusedForMs(ip, t + 20) == core::LoginLimiter::BLOCK_MS);
	CHECK(l.refusedForMs(ip, t + 20 + 60000) == core::LoginLimiter::BLOCK_MS - 60000);
	CHECK(l.refusedForMs(other, t + 21) == 0 && l.refusedForMs(ip, t + 20 + core::LoginLimiter::BLOCK_MS) == 0);
	// failures spread beyond the window don't accumulate
	core::LoginLimiter l2;
	for (int i = 0; i < 10; i++)
		CHECK(!l2.recordFailure(ip, i * (core::LoginLimiter::WINDOW_MS / 4 + 1)));
	// eviction never frees an active block when other slots are available
	core::LoginLimiter l3;
	for (int i = 0; i < 5; i++)
		l3.recordFailure(ip, 100);
	for (uint32_t k = 1; k <= 20; k++)
		l3.recordFailure(0x0B000000 + k, 200 + k);
	CHECK(l3.isBlocked(ip, 300));
	// 64-bit time: no 32-bit millis() boundary changes anything
	core::LoginLimiter l4;
	for (int i = 0; i < 5; i++)
		l4.recordFailure(ip, WRAP32 - 256);
	CHECK(l4.isBlocked(ip, WRAP32 + 16));
	CHECK(!l4.isBlocked(ip, WRAP32 - 256 + core::LoginLimiter::BLOCK_MS));
	// the 32-bit block came back 2^31 ms (24.8 days) after it ended
	CHECK(!l4.isBlocked(ip, WRAP32 - 256 + core::LoginLimiter::BLOCK_MS + DAYS_24_8));
	CHECK(!l4.isBlocked(ip, WRAP32 - 256 + core::LoginLimiter::BLOCK_MS + WRAP32));

	// device-wide budget: an attacker cycling IPs (each under the per-IP
	// limit, and evicting the per-IP blocks) is stopped after 20 failures
	core::LoginLimiter g;
	uint64_t gt = 10000;
	uint32_t next = 0x0C000000;
	for (int i = 0; i < 19; i++)
		CHECK(!g.recordFailure(next++, gt + i));
	CHECK(!g.loginRefused(next, gt + 20) && !g.globallyBlocked(gt + 20));
	CHECK(g.recordFailure(next++, gt + 20)); // 20th, from a fresh IP
	CHECK(g.loginRefused(0x0D000001, gt + 21)); // an IP never seen is refused too
	CHECK(!g.isBlocked(0x0D000001, gt + 21));   // ...but a signed-in socket from it is not
	CHECK(g.globallyBlocked(gt + 20 + 59999) && !g.globallyBlocked(gt + 20 + 60000));
	CHECK(g.refusedForMs(0x0D000001, gt + 30) == 60000 - 10); // device-wide: the global wait
	// it doubles while the guessing goes on
	gt += 100000;
	for (int i = 0; i < 19; i++)
		g.recordFailure(next++, gt);
	CHECK(g.recordFailure(next++, gt) && g.globallyBlocked(gt + 119999) && !g.globallyBlocked(gt + 120000));
	// failures while blocked are not counted towards the next block
	for (int i = 0; i < 50; i++)
		g.recordFailure(next++, gt + 1000);
	CHECK(!g.globallyBlocked(gt + 120000));
	// a successful login starts again at 60 s
	g.recordSuccess(0x0E000001);
	gt += 1000000;
	for (int i = 0; i < 20; i++)
		g.recordFailure(next++, gt);
	CHECK(g.globallyBlocked(gt + 59999) && !g.globallyBlocked(gt + 60000));
	// and so does an hour without failures
	gt += 60000;
	for (int i = 0; i < 20; i++)
		g.recordFailure(next++, gt);
	CHECK(g.globallyBlocked(gt + 60000) && g.globallyBlocked(gt + 119999)); // second block: 120 s
	CHECK(!g.globallyBlocked(gt + 120000));
	gt += 120000 + core::LoginLimiter::GLOBAL_QUIET_MS + 1;
	for (int i = 0; i < 20; i++)
		g.recordFailure(next++, gt);
	CHECK(g.globallyBlocked(gt + 59999) && !g.globallyBlocked(gt + 60000));
	// failures spread out never add up to a device-wide block
	core::LoginLimiter spread;
	for (int i = 0; i < 100; i++)
		CHECK(!spread.recordFailure(0x0F000000 + i, (uint64_t)i * (core::LoginLimiter::WINDOW_MS / 10)));

	core::SessionStore s;
	char tok[core::SessionStore::TOKEN_HEX + 1];
	s.issue(fakeRandom, 0, tok);
	CHECK(strlen(tok) == 32);
	CHECK(s.validate(tok, 1000));
	char bad[33];
	memcpy(bad, tok, 33);
	bad[5] = bad[5] == 'a' ? 'b' : 'a';
	CHECK(!s.validate(bad, 1000));
	CHECK(!s.validate("", 1000));
	CHECK(!s.validate(nullptr, 1000));
	CHECK(!s.validate("short", 1000));
	CHECK(!s.validate(tok, 1000 + core::SessionStore::IDLE_MS + 5)); // idle expiry
	char t2[33];
	s.issue(fakeRandom, 2000, t2);
	CHECK(strcmp(tok, t2) != 0);
	CHECK(s.validate(t2, 2001));
	s.revokeAll();
	CHECK(!s.validate(t2, 2002));
	// an idle session stays expired; with 32-bit time it came back to life
	// 49.7 days later, when now - lastUsed wrapped to a small number
	char t3[33];
	s.issue(fakeRandom, WRAP32 - 100, t3);
	CHECK(s.validate(t3, WRAP32 + 100));
	CHECK(!s.validate(t3, WRAP32 + 100 + core::SessionStore::IDLE_MS + 1));
	CHECK(!s.validate(t3, WRAP32 + 100 + WRAP32));
	// a session ends 24 h after sign-in, however busy (plan 1.9 S2)
	{
		core::SessionStore busy;
		char tb[33];
		busy.issue(fakeRandom, 1000, tb);
		bool allDay = true;
		const uint64_t HOUR = 3600000;
		for (uint64_t h = 1; h < 24; h++)
			allDay = allDay && busy.validate(tb, 1000 + h * HOUR);
		CHECK(allDay);
		CHECK(busy.validate(tb, 1000 + core::SessionStore::MAX_AGE_MS));
		CHECK(!busy.validate(tb, 1000 + core::SessionStore::MAX_AGE_MS + 1));
		CHECK(!busy.alive(tb, 1000 + core::SessionStore::MAX_AGE_MS + 1)); // the socket sweep closes it then
	}
	// alive(): the socket sweep's question, which must not count as a use
	// (plan 1.9.1 B7): 12 h with no message ends it whatever the sweep asked
	{
		core::SessionStore q;
		char tq[33];
		q.issue(fakeRandom, 1000, tq);
		const uint64_t HOUR = 3600000;
		bool sweptAlive = true;
		for (uint64_t m = 1; m < 12 * 60; m += 7)
			sweptAlive = sweptAlive && q.alive(tq, 1000 + m * 60000);
		CHECK(sweptAlive);
		CHECK(!q.alive(tq, 1000 + core::SessionStore::IDLE_MS + 1)); // the sweeps did not keep it alive
		CHECK(!q.alive("0123456789abcdef0123456789abcdef", 2000) && !q.alive(nullptr, 2000) && !q.alive("short", 2000));
		// a message at 6 h (usedWsClient: validate) carries it to 18 h
		core::SessionStore u;
		char tu[33];
		u.issue(fakeRandom, 1000, tu);
		CHECK(u.validate(tu, 1000 + 6 * HOUR));
		CHECK(u.alive(tu, 1000 + 6 * HOUR + core::SessionStore::IDLE_MS) && !u.alive(tu, 1000 + 6 * HOUR + core::SessionStore::IDLE_MS + 1));
	}
}

static void testNoncesAndRevoke()
{
	core::NonceStore n;
	char a[33], b[33];
	n.issue(fakeRandom, 1000, a);
	n.issue(fakeRandom, 1000, b);
	CHECK(strlen(a) == 32 && strcmp(a, b) != 0);
	CHECK(n.consume(a, 2000));
	CHECK(!n.consume(a, 2001)); // replay of a spent nonce refused
	CHECK(!n.consume("00000000000000000000000000000000", 2002)); // never issued
	CHECK(!n.consume(b, 1000 + core::NonceStore::NONCE_TTL_MS + 1)); // stale
	CHECK(!n.consume(nullptr, 0));
	// many issues evict oldest, never overflow
	char c[33];
	for (int i = 0; i < 50; i++)
		n.issue(fakeRandom, 5000 + i, c);
	CHECK(n.consume(c, 5100));
	// a /login flood from one address cannot evict another address's nonce
	{
		core::NonceStore f;
		char mine[33], last[33] = {0}, prev[33] = {0};
		f.issue(fakeRandom, 1000, mine, 0x0101a8c0);
		for (int i = 0; i < 100; i++)
		{
			memcpy(prev, last, sizeof(last));
			f.issue(fakeRandom, 1001 + i, last, 0x6601a8c0);
		}
		CHECK(f.consume(mine, 2000)); // survived the flood
		CHECK(f.consume(last, 2000) && f.consume(prev, 2000)); // the flooder keeps its newest two
		// eight addresses still get a slot each: the cap is per address, not a smaller store
		core::NonceStore g;
		char each[8][33];
		for (int i = 0; i < 8; i++)
			g.issue(fakeRandom, 3000, each[i], 0x0a000001 + i);
		bool all = true;
		for (int i = 0; i < 8; i++)
			all = all && g.consume(each[i], 3001);
		CHECK(all);
		// nine addresses flooding, two challenges each, cannot push out the
		// admin's one (four took all 8 slots before: plan 1.9 S3)
		core::NonceStore h;
		char admin[33], junk[33];
		h.issue(fakeRandom, 4000, admin, 0x0101a8c0);
		for (int round = 0; round < 20; round++)
			for (int a = 0; a < 9; a++)
				h.issue(fakeRandom, 4001 + round * 10 + a, junk, 0x6601a8c0 + a);
		CHECK(h.consume(admin, 4500));
		CHECK(h.held(0x6601a8c0, 4500) <= core::NonceStore::PER_OWNER);
	}
	// the Host check (DNS rebinding)
	{
		const char *ok[] = {"192.168.1.50", "0.0.0.0", "192.168.4.1", "192.168.4.1", "front-door", "front-door.local"};
		const size_t n6 = 6;
		CHECK(core::hostAllowed("192.168.1.50", ok, n6) && core::hostAllowed("192.168.1.50:80", ok, n6));
		CHECK(core::hostAllowed("192.168.4.1", ok, n6) && core::hostAllowed("Front-Door.local", ok, n6) && core::hostAllowed("front-door.local.", ok, n6));
		CHECK(core::hostAllowed("front-door", ok, n6) && core::hostAllowed("front-door:8080", ok, n6));
		CHECK(!core::hostAllowed("evil.example", ok, n6) && !core::hostAllowed("evil.example:80", ok, n6));
		CHECK(!core::hostAllowed("0.0.0.0", ok, n6)); // a hotspot that is off reports 0.0.0.0: never a match
		CHECK(!core::hostAllowed("front-door.local.evil.example", ok, n6) && !core::hostAllowed("192.168.1.5", ok, n6) && !core::hostAllowed("192.168.1.500", ok, n6));
		CHECK(!core::hostAllowed("192.168.1.50:", ok, n6) && !core::hostAllowed("192.168.1.50:x", ok, n6) && !core::hostAllowed("192.168.1.50:123456", ok, n6));
		CHECK(!core::hostAllowed("[::1]:80", ok, n6) && !core::hostAllowed("", ok, n6) && !core::hostAllowed(":80", ok, n6) && !core::hostAllowed(nullptr, ok, n6));
	}

	char v[40];
	const char *h = "username=\"admin\", realm=\"ironframe-rfid\", nonce=\"abc123\", uri=\"/login\", cnonce=\"x\", nc=00000001, qop=auth, response=\"r\"";
	CHECK(core::digestParam(h, "nonce", v, sizeof(v)) && strcmp(v, "abc123") == 0);
	CHECK(core::digestParam(h, "nc", v, sizeof(v)) && strcmp(v, "00000001") == 0);
	CHECK(!core::digestParam(h, "opaque", v, sizeof(v)));
	CHECK(core::digestParam("cnonce=\"zz\", nonce=\"n1\"", "nonce", v, sizeof(v)) && strcmp(v, "n1") == 0); // not fooled by cnonce
	char tiny[4];
	CHECK(!core::digestParam(h, "realm", tiny, sizeof(tiny))); // too long for buffer

	core::SessionStore s;
	char t1[33], t2[33];
	s.issue(fakeRandom, 0, t1);
	s.issue(fakeRandom, 0, t2);
	s.revoke(t1);
	CHECK(!s.validate(t1, 10));
	CHECK(s.validate(t2, 10)); // other sessions unaffected

	CHECK(core::needsPasswordChange("admin"));
	CHECK(core::needsPasswordChange("abc123")); // short legacy password
	CHECK(!core::needsPasswordChange("long-enough-1"));
	CHECK(core::clampRelayCount(9, 4) == 4);
	CHECK(core::clampRelayCount(0, 4) == 1);
	CHECK(core::clampRelayCount(-3, 4) == 1);
	CHECK(core::clampRelayCount(3, 4) == 3);
	CHECK(core::isValidApPassword(""));
	CHECK(!core::isValidApPassword("short"));
	CHECK(core::isValidApPassword("eightchr"));
	// the fallback hotspot is never open
	CHECK(!core::isValidFallbackPassword("") && !core::isValidFallbackPassword(nullptr) && !core::isValidFallbackPassword("short"));
	CHECK(core::isValidFallbackPassword("eightchr") && !core::isValidFallbackPassword(std::string(64, 'x').c_str()));
}

static void testSecrets()
{
	// the card number in MQTT access messages (mqtt "carduid")
	{
		std::string out;
		CHECK(core::mqttAccessUid("04a1b2c3d4", core::MQTT_UID_LAST4, out) && out == "****c3d4");
		CHECK(core::mqttAccessUid("1234567", core::MQTT_UID_LAST4, out) && out == "****4567"); // decimal storage too
		CHECK(core::mqttAccessUid("04a1b2c3d4", core::MQTT_UID_FULL, out) && out == "04a1b2c3d4");
		out = "stale";
		CHECK(!core::mqttAccessUid("04a1b2c3d4", core::MQTT_UID_OFF, out)); // no uid field
		CHECK(!core::mqttAccessUid("keypad", core::MQTT_UID_OFF, out) && !core::mqttAccessUid(" ", core::MQTT_UID_OFF, out));
		CHECK(core::mqttAccessUid("abcd", core::MQTT_UID_LAST4, out) && out == "****"); // never shown whole
		CHECK(core::mqttAccessUid("abcde", core::MQTT_UID_LAST4, out) && out == "****bcde");
		CHECK(core::mqttAccessUid("keypad", core::MQTT_UID_LAST4, out) && out == "keypad"); // a keypad entry stays keypad
		CHECK(core::mqttAccessUid(" ", core::MQTT_UID_LAST4, out) && out == " "); // a button or MQTT open
		CHECK(core::mqttAccessUid(nullptr, core::MQTT_UID_LAST4, out) && out == "");
		// anything but 0, 1 or 2 is the default, last 4
		CHECK(core::mqttAccessUid("04a1b2c3d4", 7, out) && out == "****c3d4");
		CHECK(core::mqttAccessUid("04a1b2c3d4", -1, out) && out == "****c3d4");
		CHECK(core::mqttUidMode(0) == 0 && core::mqttUidMode(2) == 2 && core::mqttUidMode(3) == core::MQTT_UID_LAST4);
	}
	const char *stored = "{\"network\":{\"ssid\":\"home\",\"pswd\":\"wifi-secret\",\"fallbackpswd\":\"hotspot-secret\"},"
						 "\"general\":{\"pswd\":\"admin-secret\"},"
						 "\"mqtt\":{\"pswd\":\"\",\"user\":\"u\"}}";
	DynamicJsonDocument existing(1024);
	CHECK(!deserializeJson(existing, stored));

	DynamicJsonDocument out(1024);
	CHECK(!deserializeJson(out, stored));
	core::maskSecrets(out.as<JsonObject>());
	std::string wire;
	serializeJson(out, wire);
	CHECK(wire.find("wifi-secret") == std::string::npos);
	CHECK(wire.find("admin-secret") == std::string::npos);
	CHECK(wire.find("hotspot-secret") == std::string::npos && out["network"]["fallbackpswd"] == core::SECRET_MASK);
	CHECK(out["network"]["pswd"] == core::SECRET_MASK);
	CHECK(out["mqtt"]["pswd"] == ""); // empty stays empty

	// round trip: browser sends the masked values back unchanged
	DynamicJsonDocument incoming(1024);
	CHECK(!deserializeJson(incoming, wire));
	incoming["network"]["ssid"] = "changed";
	int n = core::mergeSecrets(incoming.as<JsonObject>(), existing.as<JsonObjectConst>());
	CHECK(n == 3);
	CHECK(incoming["network"]["pswd"] == "wifi-secret" && incoming["network"]["fallbackpswd"] == "hotspot-secret");
	CHECK(incoming["general"]["pswd"] == "admin-secret");
	CHECK(incoming["network"]["ssid"] == "changed");

	// a real new value wins over the stored one
	DynamicJsonDocument changed(1024);
	deserializeJson(changed, "{\"general\":{\"pswd\":\"brand-new-pass\"}}");
	CHECK(core::mergeSecrets(changed.as<JsonObject>(), existing.as<JsonObjectConst>()) == 0);
	CHECK(changed["general"]["pswd"] == "brand-new-pass");

	// mask with nothing stored -> key removed, never stored as "********"
	DynamicJsonDocument empty(64);
	DynamicJsonDocument fresh(512);
	deserializeJson(fresh, "{\"mqtt\":{\"pswd\":\"********\"}}");
	core::mergeSecrets(fresh.as<JsonObject>(), empty.as<JsonObjectConst>());
	CHECK(!fresh["mqtt"].containsKey("pswd"));

	// a save that still carries a mask needs the stored values: if they exist
	// but cannot be read (low memory, damaged file) the save must be refused,
	// or the mask is dropped and the hotspot comes back with no password
	DynamicJsonDocument masked(512);
	deserializeJson(masked, "{\"general\":{\"hostnm\":\"x\"},\"network\":{\"pswd\":\"********\"}}");
	CHECK(core::secretsNeedStored(masked.as<JsonObjectConst>()));
	DynamicJsonDocument plain(512);
	deserializeJson(plain, "{\"network\":{\"pswd\":\"new-pass-1\"},\"mqtt\":{\"pswd\":\"\"}}");
	CHECK(!core::secretsNeedStored(plain.as<JsonObjectConst>()));
	CHECK(!core::secretsNeedStored(JsonObjectConst()));

	// how the admin password is stored never leaves the device: getconf
	// (and so a backup) has neither marker; every save puts them back
	DynamicJsonDocument hashed(512);
	deserializeJson(hashed, "{\"general\":{\"pswd\":\"55660a03a22f4e179a972642deb67353\",\"pswdhash\":1,\"pswdchange\":1,\"hostnm\":\"x\"}}");
	core::maskSecrets(hashed.as<JsonObject>());
	CHECK(hashed["general"]["pswd"] == core::SECRET_MASK && !hashed["general"].containsKey("pswdhash") &&
		  !hashed["general"].containsKey("pswdchange") && hashed["general"]["hostnm"] == "x");
}

// The admin password is stored as its Digest HA1 (core/adminpass.h).
// plan 1.9 S1: the step-up proof, the same formula as the page (withStepUp)
// and the simulator: MD5(HA1 ":" token ":" nonce ":" action)
static void testStepUp()
{
	const char *ha1 = "55660a03a22f4e179a972642deb67353"; // admin:ironframe-rfid:Site-Door-2026
	const char *tok = "0123456789abcdef0123456789abcdef";
	const char *nonce = "00112233445566778899aabbccddeeff";
	char p[core::HA1_HEX + 1];
	core::stepUpProof(ha1, tok, nonce, "update", p);
	CHECK(strcmp(p, "7d173370ad0e8fa7e5f4e177d5248b2f") == 0); // hashlib.md5, independently
	CHECK(core::stepUpProofOk(ha1, tok, nonce, "update", p));
	CHECK(!core::stepUpProofOk(ha1, tok, nonce, "destroy", p));                           // another action
	CHECK(!core::stepUpProofOk(ha1, "fedcba9876543210fedcba9876543210", nonce, "update", p)); // another session
	CHECK(!core::stepUpProofOk(ha1, tok, "ffeeddccbbaa99887766554433221100", "update", p));     // another challenge
	CHECK(!core::stepUpProofOk("bba24e9a9880929c02e170e73a7b9dd7", tok, nonce, "update", p));   // another password
	CHECK(!core::stepUpProofOk(ha1, "", nonce, "update", p) && !core::stepUpProofOk(ha1, tok, "", "update", p));
	CHECK(!core::stepUpProofOk(ha1, tok, nonce, "update", "") && !core::stepUpProofOk(ha1, tok, nonce, "update", "not hex"));
	// which saves need it
	CHECK(core::stepUpNeededFor("network.ssid") && core::stepUpNeededFor("network.pswd") && core::stepUpNeededFor("mqtt.host") && core::stepUpNeededFor("mqtt.doorcontrol"));
	CHECK(!core::stepUpNeededFor("general.hostnm") && !core::stepUpNeededFor("ntp.server") && !core::stepUpNeededFor("networkx"));
	// since 1.9.1 the hardware too: pins, relay type, relay time, the PIN rules (review 8 V1)
	CHECK(core::stepUpNeededFor("hardware.rtime") && core::stepUpNeededFor("hardware.rpin") && core::stepUpNeededFor("hardware.relay2.rtype") && core::stepUpNeededFor("hardware.pinrequired"));
	CHECK(!core::stepUpNeededFor("hardwarex") && !core::stepUpNeededFor("general.hardware"));

	// which user saves need it (plan 1.9.1 B1, D1): as checkUserRecord stores them
	auto userRec = [](const char *json) {
		DynamicJsonDocument in(512);
		deserializeJson(in, json);
		auto out = std::make_shared<DynamicJsonDocument>(512);
		CHECK(core::checkUserRecord(in.as<JsonObjectConst>(), out->to<JsonObject>()) == nullptr);
		return out;
	};
	auto plain = userRec("{\"uid\":\"04a1b2c3\",\"user\":\"Ann\",\"pincode\":\"4321\",\"acctype\":1,\"validuntil\":1900000000}");
	JsonObjectConst pr = plain->as<JsonObjectConst>();
	CHECK(!core::userFileNeedsStepUp(false, true, pr, "4321"));  // a name, dates or role on a stored user: the session is enough
	CHECK(core::userFileNeedsStepUp(true, true, pr, "4321"));    // create (the editor's new user)
	CHECK(core::userFileNeedsStepUp(false, false, pr, ""));      // no record stored: a new user, whatever create says
	CHECK(core::userFileNeedsStepUp(false, true, pr, "1234"));   // the PIN changed
	CHECK(core::userFileNeedsStepUp(false, true, pr, ""));       // a PIN set (or the stored one unreadable)
	auto nopin = userRec("{\"uid\":\"04a1b2c3\",\"user\":\"Ann\",\"acctype\":1,\"validuntil\":1900000000}");
	CHECK(core::userFileNeedsStepUp(false, true, nopin->as<JsonObjectConst>(), "4321")); // the PIN removed: the card alone then opens
	CHECK(!core::userFileNeedsStepUp(false, true, nopin->as<JsonObjectConst>(), ""));
	CHECK(!core::userFileNeedsStepUp(false, true, nopin->as<JsonObjectConst>(), nullptr));
	for (const char *key : {"acctype", "acctype2", "acctype3", "acctype4"})
	{
		DynamicJsonDocument in(512), out(512);
		deserializeJson(in, "{\"uid\":\"04a1b2c3\",\"user\":\"Ann\",\"pincode\":\"4321\",\"acctype\":1,\"validuntil\":1900000000}");
		in[key] = 99;
		CHECK(core::checkUserRecord(in.as<JsonObjectConst>(), out.to<JsonObject>()) == nullptr);
		CHECK(core::userFileNeedsStepUp(false, true, out.as<JsonObjectConst>(), "4321")); // admin access on any door
	}
}

static void testAdminPassword()
{
	char hex[core::HA1_HEX + 1];
	// RFC 1321 test suite
	const char *const md5Vectors[][2] = {
		{"", "d41d8cd98f00b204e9800998ecf8427e"},
		{"a", "0cc175b9c0f1b6a831c399e269772661"},
		{"abc", "900150983cd24fb0d6963f7d28e17f72"},
		{"message digest", "f96b697d7cb7938d525a2f31aaf161d0"},
		{"abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"},
		{"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"},
		{"12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"},
	};
	for (const auto &v : md5Vectors)
	{
		core::Md5 md5;
		md5.add(v[0]);
		md5.hex(hex);
		CHECK(strcmp(hex, v[1]) == 0);
	}
	{
		// fed in pieces (as adminHa1 does), and across a 64-byte block
		core::Md5 md5;
		const char *s = "12345678901234567890123456789012345678901234567890123456789012345678901234567890";
		md5.add(s, 33);
		md5.add(s + 33, 47);
		md5.hex(hex);
		CHECK(strcmp(hex, "57edf4a22be3c955ac49da2e2107b67a") == 0);
		md5.add("abc"); // hex() starts it again
		md5.hex(hex);
		CHECK(strcmp(hex, "900150983cd24fb0d6963f7d28e17f72") == 0);
	}
	{
		// RFC 2617's own HA1 example
		core::Md5 md5;
		md5.add("Mufasa:testrealm@host.com:Circle Of Life");
		md5.hex(hex);
		CHECK(strcmp(hex, "939e7578ed9e3c518a452acee763bce9") == 0);
	}
	// HA1 = MD5("admin:ironframe-rfid:<password>"), the login's user and realm
	core::adminHa1("Site-Door-2026", hex);
	CHECK(strcmp(hex, "55660a03a22f4e179a972642deb67353") == 0);
	core::adminHa1("admin", hex);
	CHECK(strcmp(hex, core::FACTORY_ADMIN_HA1) == 0);
	core::Settings fresh;
	CHECK(strcmp(fresh.adminHa1, core::FACTORY_ADMIN_HA1) == 0 && fresh.adminMustChange); // a fresh device
	CHECK(core::isHa1("55660a03a22f4e179a972642deb67353"));
	CHECK(!core::isHa1("55660A03A22F4E179A972642DEB67353")); // the login compares lowercase
	CHECK(!core::isHa1("55660a03a22f4e179a972642deb6735") && !core::isHa1("55660a03a22f4e179a972642deb67353a") && !core::isHa1(nullptr));
	CHECK(!core::isHa1("55660a03a22f4e179a972642deb6735g"));
	CHECK(core::adminPasswordMatches("Site-Door-2026", "55660a03a22f4e179a972642deb67353"));
	CHECK(!core::adminPasswordMatches("Site-Door-2027", "55660a03a22f4e179a972642deb67353"));
	CHECK(!core::adminPasswordMatches("55660a03a22f4e179a972642deb67353", "55660a03a22f4e179a972642deb67353")); // the hash is not the password
	// Change Password with neither password on the wire (review 6); vector
	// computed independently (Python hashlib)
	{
		const char *cur = "55660a03a22f4e179a972642deb67353"; // Site-Door-2026
		const char *tok = "0123456789abcdef0123456789abcdef";
		char out[core::HA1_HEX + 1];
		CHECK(core::openPasswordChange(cur, tok, "d4f0f9d14bdb360bcf81d7f88a553a72", "eaabb086c47a11033ad511bcf835bd63", out));
		CHECK(strcmp(out, "bba24e9a9880929c02e170e73a7b9dd7") == 0); // Site-Door-2027
		// another session's token, a wrong current password, a changed byte: refused
		CHECK(!core::openPasswordChange(cur, "fedcba9876543210fedcba9876543210", "d4f0f9d14bdb360bcf81d7f88a553a72", "eaabb086c47a11033ad511bcf835bd63", out));
		CHECK(!core::openPasswordChange("bba24e9a9880929c02e170e73a7b9dd7", tok, "d4f0f9d14bdb360bcf81d7f88a553a72", "eaabb086c47a11033ad511bcf835bd63", out));
		CHECK(!core::openPasswordChange(cur, tok, "d4f0f9d14bdb360bcf81d7f88a553a70", "eaabb086c47a11033ad511bcf835bd63", out));
		CHECK(!core::openPasswordChange(cur, "", "d4f0f9d14bdb360bcf81d7f88a553a72", "eaabb086c47a11033ad511bcf835bd63", out));
		CHECK(!core::openPasswordChange(cur, tok, "Site-Door-2027", "eaabb086c47a11033ad511bcf835bd63", out)); // the old plain form
	}

	auto stored = [](const char *json) {
		DynamicJsonDocument d(512);
		deserializeJson(d, json);
		return core::storedAdminPassword(d["general"].as<JsonObjectConst>());
	};
	// nothing stored: the factory password, nothing to rewrite
	core::AdminPassword a = stored("{\"general\":{}}");
	CHECK(strcmp(a.ha1, core::FACTORY_ADMIN_HA1) == 0 && a.mustChange && !a.migrated);
	a = stored("{}");
	CHECK(strcmp(a.ha1, core::FACTORY_ADMIN_HA1) == 0 && a.mustChange && !a.migrated);
	// stored in clear (1.4.1 and before): hashed, rewritten once
	a = stored("{\"general\":{\"pswd\":\"Site-Door-2026\"}}");
	CHECK(strcmp(a.ha1, "55660a03a22f4e179a972642deb67353") == 0 && !a.mustChange && a.migrated);
	// the factory password, or a short one from upstream, must still be changed
	a = stored("{\"general\":{\"pswd\":\"admin\"}}");
	CHECK(strcmp(a.ha1, core::FACTORY_ADMIN_HA1) == 0 && a.mustChange && a.migrated);
	a = stored("{\"general\":{\"pswd\":\"abc123\"}}");
	CHECK(a.mustChange && a.migrated);
	a = stored("{\"general\":{\"pswd\":\"\"}}");
	CHECK(a.mustChange && a.migrated);
	// a 1.4.1 password that happens to be 32 hex characters is a password,
	// not a hash: without "pswdhash" it is hashed like any other
	a = stored("{\"general\":{\"pswd\":\"0123456789abcdef0123456789abcdef\"}}");
	CHECK(a.migrated && !a.mustChange && core::adminPasswordMatches("0123456789abcdef0123456789abcdef", a.ha1));
	// "pswdhash" kept but the value set in clear (an older firmware's
	// Change Password after a downgrade): not a hash, so hashed
	a = stored("{\"general\":{\"pswd\":\"Older-Firmware-1\",\"pswdhash\":1}}");
	CHECK(a.migrated && core::adminPasswordMatches("Older-Firmware-1", a.ha1));
	// the stored form
	a = stored("{\"general\":{\"pswd\":\"55660a03a22f4e179a972642deb67353\",\"pswdhash\":1}}");
	CHECK(strcmp(a.ha1, "55660a03a22f4e179a972642deb67353") == 0 && !a.mustChange && !a.migrated);
	a = stored("{\"general\":{\"pswd\":\"a74c19259b8c3e6262ddca95dd114730\",\"pswdhash\":1,\"pswdchange\":1}}");
	CHECK(a.mustChange && !a.migrated);

	// migration is idempotent: what it writes reads back as the same hash
	// and flag, with nothing more to rewrite
	for (const char *plain : {"Site-Door-2026", "admin", "abc123", "0123456789abcdef0123456789abcdef"})
	{
		DynamicJsonDocument d(512);
		d["general"]["pswd"] = plain;
		d["general"]["hostnm"] = "door";
		core::AdminPassword first = core::storedAdminPassword(d["general"].as<JsonObjectConst>());
		CHECK(first.migrated);
		core::putAdminPassword(d["general"], first.ha1, first.mustChange);
		std::string text;
		serializeJson(d, text);
		CHECK(text.find(plain) == std::string::npos); // no password text left
		core::AdminPassword second = core::storedAdminPassword(d["general"].as<JsonObjectConst>());
		CHECK(!second.migrated && strcmp(second.ha1, first.ha1) == 0 && second.mustChange == first.mustChange);
		CHECK(d["general"]["hostnm"] == "door");
		CHECK(d["general"].containsKey("pswdchange") == first.mustChange);
		core::putAdminPassword(d["general"], second.ha1, second.mustChange); // again: no change
		std::string again;
		serializeJson(d, again);
		CHECK(again == text);
	}

	// parseSettings reports a password stored in clear, so the firmware
	// rewrites config.json, and loads the hash and flag
	{
		DynamicJsonDocument d(2048);
		auto withHours = [&d]() {
			JsonArray h = d["general"].createNestedArray("openinghours");
			for (int i = 0; i < 7; i++)
				h.add("111111111111111111111111");
		};
		deserializeJson(d, "{\"hardware\":{\"readertype\":1,\"wgd0pin\":4,\"wgd1pin\":13,\"rpin\":16},\"general\":{\"pswd\":\"Site-Door-2026\"}}");
		withHours();
		core::Settings s;
		core::SettingsLoad l = core::parseSettings(d.as<JsonObjectConst>(), core::policyBoardEsp32(), s);
		CHECK(l.passwordMigrated && strcmp(s.adminHa1, "55660a03a22f4e179a972642deb67353") == 0 && !s.adminMustChange);
		core::putAdminPassword(d["general"], s.adminHa1, s.adminMustChange);
		core::Settings s2;
		core::SettingsLoad l2 = core::parseSettings(d.as<JsonObjectConst>(), core::policyBoardEsp32(), s2);
		CHECK(!l2.passwordMigrated && strcmp(s2.adminHa1, s.adminHa1) == 0 && !s2.adminMustChange);
		deserializeJson(d, "{\"hardware\":{\"readertype\":1,\"wgd0pin\":4,\"wgd1pin\":13,\"rpin\":16},\"general\":{\"pswd\":\"admin\"}}");
		withHours();
		core::Settings s3;
		CHECK(core::parseSettings(d.as<JsonObjectConst>(), core::policyBoardEsp32(), s3).passwordMigrated && s3.adminMustChange);
	}
}

static void testLogPager()
{
	// 600 entries of ~180 bytes: every line comes back exactly once, in order
	std::string log = makeLog(600, 180);
	int pages = 0;
	bool overflow = false;
	std::vector<std::string> got = readAll(log, 50, 12288, &pages, &overflow);
	CHECK(got.size() == 600);
	bool ordered = true;
	for (size_t i = 0; i < got.size(); i++)
	{
		char needle[32];
		snprintf(needle, sizeof(needle), "\"line %zu\"", i);
		if (got[i].find(needle) == std::string::npos)
			ordered = false;
	}
	CHECK(ordered);
	CHECK(pages == 12); // 600 / 50
	printf("pager: 600 lines -> %d round-trips at 50/page (upstream: 60 at 10/page)\n", pages);

	// Budget pressure: a small document with long lines must never drop an
	// entry; the page just ends early and the next request resumes there.
	std::string longLog = makeLog(200, 500);
	int smallPages = 0;
	bool sawOverflow = false;
	std::vector<std::string> got2 = readAll(longLog, 50, 4096, &smallPages, &sawOverflow);
	CHECK(got2.size() == 200);
	CHECK(sawOverflow);       // proves the budget path was exercised
	CHECK(smallPages > 4);    // more than 200/50 because pages were cut short
	std::set<std::string> uniq(got2.begin(), got2.end());
	CHECK(uniq.size() == 200); // no duplicates

	// Upstream's fixed 2 KB page with 10 long lines lost entries; show the
	// same input through the new pager keeps them (positive control for the
	// failure mode).
	{
		DynamicJsonDocument doc(2048);
		JsonArray items = doc.createNestedArray("list");
		for (int i = 0; i < 10; i++)
		{
			std::string l(250, 'a' + i);
			items.add((char *)l.c_str());
		}
		CHECK(items.size() < 10 || doc.overflowed()); // the old way overflowed
	}

	// Two interleaved readers (two tabs / both log views) don't disturb each
	// other because the cursor lives in the request.
	std::string a = makeLog(120, 100), b = makeLog(80, 100);
	size_t pa = 0, pb = 0;
	std::vector<std::string> ra, rb;
	bool doneA = false, doneB = false;
	while (!doneA || !doneB)
	{
		if (!doneA)
		{
			DynamicJsonDocument d(8192);
			JsonArray it = d.createNestedArray("list");
			FakeFile f(a);
			core::LogPage p = core::readLogPage(f, pa, 10, it, d);
			for (JsonVariant v : it)
				ra.push_back(v.as<std::string>());
			pa = p.nextPos;
			doneA = p.eof;
		}
		if (!doneB)
		{
			DynamicJsonDocument d(8192);
			JsonArray it = d.createNestedArray("list");
			FakeFile f(b);
			core::LogPage p = core::readLogPage(f, pb, 7, it, d);
			for (JsonVariant v : it)
				rb.push_back(v.as<std::string>());
			pb = p.nextPos;
			doneB = p.eof;
		}
	}
	CHECK(ra.size() == 120);
	CHECK(rb.size() == 80);

	// blank lines, CRLF, a truncated (power-cut) final line, an over-long line
	std::string messy = "{\"a\":1}\r\n\n\n{\"a\":2}\n" + std::string(2000, 'z') + "\n{\"a\":3";
	std::vector<std::string> got3 = readAll(messy, 50, 8192, nullptr, nullptr);
	CHECK(got3.size() == 4);
	CHECK(got3[0] == "{\"a\":1}");
	CHECK(got3[2].size() == core::LOG_LINE_MAX);
	CHECK(got3[3] == "{\"a\":3");

	// empty file
	std::vector<std::string> got4 = readAll(std::string(), 50, 1024, nullptr, nullptr);
	CHECK(got4.empty());

	// exact multiple of the page size ends with eof on the last full page
	std::string exact = makeLog(100, 80);
	int exactPages = 0;
	CHECK(readAll(exact, 50, 12288, &exactPages, nullptr).size() == 100);
	CHECK(exactPages == 2);

	// seek past the end is an empty, terminal page
	{
		DynamicJsonDocument d(1024);
		JsonArray it = d.createNestedArray("list");
		FakeFile f(exact);
		core::LogPage p = core::readLogPage(f, exact.size() + 10, 50, it, d);
		CHECK(p.eof && p.count == 0);
	}
}

static void testRotation()
{
	FakeFS fs;
	fs.files["/eventlog.json"] = "current";
	fs.files["/eventlog.json.1"] = "older";
	fs.files["/eventlog.json.3"] = "oldest";
	core::rotateLog(fs, "/eventlog.json", 3);
	CHECK(!fs.exists("/eventlog.json"));
	CHECK(fs.files["/eventlog.json.1"] == "current");
	CHECK(fs.files["/eventlog.json.2"] == "older");
	CHECK(fs.files.count("/eventlog.json.3") == 0); // oldest dropped, .2 had nothing to shift
	core::rotateLog(fs, "/eventlog.json", 3);
	CHECK(fs.files["/eventlog.json.2"] == "current");
	CHECK(fs.files["/eventlog.json.3"] == "older");
	core::rotateLog(fs, "/eventlog.json", 3);
	CHECK(fs.files["/eventlog.json.3"] == "current"); // "older" fell off the end
	CHECK(fs.files.size() == 1);
	// every rotated name is still accepted by the filename validator
	CHECK(core::isValidLogFilename("/eventlog.json.3"));
}

// ---- Wiegand ----------------------------------------------------------------

static int parityEven(uint64_t v, int from, int n)
{
	int c = 0;
	for (int i = 0; i < n; i++)
		c += (v >> (from + i)) & 1;
	return c & 1;
}

// Standard 26-bit frame: even parity over the first 12 data bits, odd over the last 12.
static std::vector<int> frame26(uint32_t data24)
{
	uint64_t v = data24 & 0xFFFFFF;
	int pe = parityEven(v, 12, 12);
	int po = 1 - parityEven(v, 0, 12);
	std::vector<int> bits{pe};
	for (int i = 23; i >= 0; i--)
		bits.push_back((v >> i) & 1);
	bits.push_back(po);
	return bits;
}

// 34-bit frame: even parity over the first 16 data bits, odd over the last 16.
static std::vector<int> frame34(uint32_t data32)
{
	uint64_t v = data32;
	int pe = parityEven(v, 16, 16);
	int po = 1 - parityEven(v, 0, 16);
	std::vector<int> bits{pe};
	for (int i = 31; i >= 0; i--)
		bits.push_back((v >> i) & 1);
	bits.push_back(po);
	return bits;
}

static std::vector<int> bitsOf(uint32_t v, int n)
{
	std::vector<int> b;
	for (int i = n - 1; i >= 0; i--)
		b.push_back((v >> i) & 1);
	return b;
}

static bool feed(core::WiegandDecoder &d, const std::vector<int> &bits, uint32_t &t, bool removeParity, core::WiegandResult &out)
{
	for (int b : bits)
	{
		d.onBit(b, t);
		t += 2000; // ~2 ms per bit (microseconds), as readers send them
	}
	CHECK(!d.poll(t + 10000, removeParity, out)); // still inside the frame gap
	t += 30000;
	bool ok = d.poll(t, removeParity, out);
	t += 5000;
	return ok;
}

static void testWiegand()
{
	core::WiegandDecoder d;
	core::WiegandResult r;
	uint32_t t = 1000;

	// 26-bit card, facility 1 card 12345: parity stripped -> 24-bit number
	uint32_t card = (1u << 16) | 12345u;
	CHECK(feed(d, frame26(card), t, true, r));
	CHECK(r.type == 26 && r.code == card);
	// same card without stripping keeps the raw 26 bits
	CHECK(feed(d, frame26(card), t, false, r));
	uint32_t raw26 = 0;
	for (int b : frame26(card))
		raw26 = (raw26 << 1) | (uint32_t)b;
	CHECK(r.type == 26 && r.code == raw26);

	// 34-bit card with a full 32-bit number (Mifare UID)
	uint32_t uid = 0xDEADBEEFu;
	CHECK(feed(d, frame34(uid), t, true, r));
	CHECK(r.type == 34);
	printf("wiegand34: sent %08x decoded %08x\n", uid, r.code);
	CHECK(r.code == uid);

	// keypad: 4-bit keys, * -> ENTER, # -> ESC
	CHECK(feed(d, bitsOf(5, 4), t, true, r) && r.type == 4 && r.code == 5);
	CHECK(feed(d, bitsOf(0x0b, 4), t, true, r) && r.code == 0x0d);
	CHECK(feed(d, bitsOf(0x0a, 4), t, true, r) && r.code == 0x1b);
	// 8-bit keys carry the complement in the high nibble
	CHECK(feed(d, bitsOf(((~7u & 0xf) << 4) | 7u, 8), t, true, r) && r.type == 8 && r.code == 7);
	CHECK(!feed(d, bitsOf(0x77, 8), t, true, r)); // corrupt: no key
	// noise (10 bits) is dropped and the next card still decodes
	CHECK(!feed(d, bitsOf(0x2AA, 10), t, true, r));
	CHECK(feed(d, frame26(card), t, true, r) && r.code == card);
	// both dropped frames are counted (Status page), nothing else is
	{
		core::WiegandCounters c = d.counters();
		CHECK(d.badFrames() == 2 && c.badFrames == 2 && c.glitches == 0 && c.parity == 0 && c.overruns == 0);
	}

	// two readers with interleaved bits stay independent
	core::WiegandDecoder a, b;
	uint32_t cardA = 0x0A1234, cardB = 0x0B5678;
	std::vector<int> fa = frame26(cardA), fb = frame26(cardB);
	uint32_t tt = 50000;
	for (size_t i = 0; i < fa.size(); i++)
	{
		a.onBit(fa[i], tt);
		b.onBit(fb[i], tt + 1);
		tt += 2000;
	}
	tt += 30000;
	core::WiegandResult ra, rb;
	CHECK(a.poll(tt, true, ra) && ra.code == cardA);
	CHECK(b.poll(tt, true, rb) && rb.code == cardB);

	// clock wrap inside a frame
	core::WiegandDecoder w;
	uint32_t tw = 0xFFFFFFF0u;
	CHECK(feed(w, frame26(card), tw, true, r) && r.code == card);

	// parity: one flipped bit anywhere in a 26- or 34-bit frame is dropped,
	// never decoded as a different card
	{
		int dropped26 = 0, dropped34 = 0;
		std::vector<int> f26 = frame26(card), f34 = frame34(uid);
		for (size_t i = 0; i < f26.size(); i++)
		{
			std::vector<int> bad = f26;
			bad[i] ^= 1;
			if (!feed(d, bad, t, true, r))
				dropped26++;
		}
		for (size_t i = 0; i < f34.size(); i++)
		{
			std::vector<int> bad = f34;
			bad[i] ^= 1;
			if (!feed(d, bad, t, true, r))
				dropped34++;
		}
		printf("parity: dropped %d/26 and %d/34 single-bit errors\n", dropped26, dropped34);
		CHECK(dropped26 == 26 && dropped34 == 34);
		CHECK(d.parityErrors() == 60);
		// the decoder still reads good frames afterwards
		CHECK(feed(d, frame26(card), t, true, r) && r.code == card);
		CHECK(feed(d, frame34(uid), t, true, r) && r.code == uid);
		// known vectors: facility 1 card 12345 = 0x013039 (26-bit); all-zero data
		CHECK(feed(d, frame26(0x013039), t, true, r) && r.type == 26 && r.code == 0x013039);
		CHECK(feed(d, frame26(0), t, true, r) && r.code == 0);
		CHECK(feed(d, frame34(0xFFFFFFFFu), t, true, r) && r.code == 0xFFFFFFFFu);
		// with "remove parity bits" off the raw frame is passed through
		// unchecked (readers with a non-standard parity layout keep working)
		std::vector<int> bad = f26;
		bad[5] ^= 1;
		CHECK(feed(d, bad, t, false, r) && r.type == 26);
	}

	// loop() held up (a flash write) while a card and two keys arrive: the
	// interrupt splits them at the gaps, and polling afterwards yields all
	// three in order. Before, they merged into one 34-bit burst of noise.
	{
		core::WiegandDecoder s;
		uint32_t ts = 200000;
		auto send = [&](const std::vector<int> &bits) {
			for (int bit : bits)
			{
				s.onBit(bit, ts);
				ts += 2000;
			}
		};
		send(frame26(card));
		ts += 100000; // 100 ms to the first key
		send(bitsOf(1, 4));
		ts += 150000;
		send(bitsOf(0x0b, 4)); // *
		CHECK(s.queuedFrames() == 2 && s.pendingBits() == 4);
		ts += 1;
		core::WiegandResult x;
		CHECK(s.poll(ts, true, x) && x.type == 26 && x.code == card);
		CHECK(s.poll(ts, true, x) && x.type == 4 && x.code == 1);
		CHECK(!s.poll(ts, true, x)); // the last one is still inside its gap
		CHECK(s.poll(ts + 30000, true, x) && x.type == 4 && x.code == 0x0d);
		CHECK(!s.poll(ts + 30001, true, x));

		// a bad frame in the queue is dropped; the next one still decodes
		std::vector<int> bad = frame26(card);
		bad[3] ^= 1;
		send(bad);
		ts += 50000;
		send(frame26(card));
		ts += 30000;
		CHECK(!s.poll(ts, true, x));
		CHECK(s.poll(ts, true, x) && x.code == card);

		// glitches: every edge doubled 20 us later is ignored
		uint32_t before = s.glitches();
		ts += 50000;
		for (int bit : frame26(card))
		{
			s.onBit(bit, ts);
			s.onBit(bit, ts + 20);
			ts += 2000;
		}
		CHECK(s.glitches() - before == 26);
		CHECK(s.poll(ts + 30000, true, x) && x.code == card);
		ts += 60000;
		// an edge exactly at the filter limit is a bit
		s.onBit(0, ts);
		s.onBit(1, ts + core::WiegandDecoder::GLITCH_US);
		CHECK(s.pendingBits() == 2);
		ts += 100000;
		CHECK(!s.poll(ts, true, x)); // 2 bits: noise, dropped

		// more frames than the queue holds while loop() stands still (32
		// since 1.9.1: plan 1.9.1 C1): the latest 32 are kept, the oldest
		// dropped and counted. 40 keys: 39 closed (7 dropped), 1 in progress.
		CHECK(core::WiegandDecoder::QUEUE == 32);
		for (int i = 0; i < 40; i++)
		{
			send(bitsOf((uint32_t)(i % 10), 4));
			ts += 50000;
		}
		CHECK(s.overruns() == 7 && s.queuedFrames() == 32);
		int keys = 0;
		uint32_t firstKey = 99, lastKey = 99;
		while (s.poll(ts, true, x))
		{
			if (keys == 0)
				firstKey = x.code;
			lastKey = x.code;
			keys++;
		}
		CHECK(keys == 33 && firstKey == 7 && lastKey == 9); // frames 7..39 (key = i % 10)
		// a stall of 6 key presses (a 6-digit PIN) loses nothing now
		for (int i = 0; i < 6; i++)
		{
			send(bitsOf((uint32_t)(i + 1), 4));
			ts += 50000;
		}
		keys = 0;
		while (s.poll(ts, true, x))
			keys++;
		CHECK(keys == 6 && s.overruns() == 7);
	}

	// 24-bit cards: a parity bit each end around 22 data bits. Parity is not
	// checked at this length; "remove parity bits" strips the two ends.
	{
		core::WiegandDecoder e;
		uint32_t te = 300000;
		uint32_t data22 = 0x2ABCDE & 0x3FFFFF;
		uint32_t raw24 = (1u << 23) | (data22 << 1) | 1u;
		CHECK(feed(e, bitsOf(raw24, 24), te, true, r) && r.type == 24 && r.code == data22);
		CHECK(feed(e, bitsOf(raw24, 24), te, false, r) && r.type == 24 && r.code == raw24);
		CHECK(feed(e, bitsOf(0, 24), te, true, r) && r.type == 24 && r.code == 0);
		CHECK(feed(e, bitsOf(0xFFFFFF, 24), te, true, r) && r.code == 0x3FFFFF);
		// a flipped bit is not caught (no parity check at 24 bits): it reads as another number
		CHECK(feed(e, bitsOf(raw24 ^ (1u << 5), 24), te, true, r) && r.code == (data22 ^ (1u << 4)));
		CHECK(e.parityErrors() == 0);

		// 32-bit cards: 30 data bits between the two parity bits
		uint32_t data30 = 0x2EADBEEF & 0x3FFFFFFF;
		uint32_t raw32 = (data30 << 1) | 1u; // first bit (parity) 0
		CHECK(feed(e, bitsOf(raw32, 32), te, true, r) && r.type == 32 && r.code == data30);
		CHECK(feed(e, bitsOf(raw32 | 0x80000000u, 32), te, true, r) && r.code == data30);
		CHECK(feed(e, bitsOf(0xFFFFFFFFu, 32), te, true, r) && r.code == 0x3FFFFFFF);
		// unstripped, the first bit sent is lost (upstream's arithmetic, kept so
		// stored ids do not change): 31 bits come through
		CHECK(feed(e, bitsOf(0xDEADBEEFu, 32), te, false, r) && r.type == 32 && r.code == (0xDEADBEEFu & 0x7FFFFFFF));
		// neither length is mistaken for a key or noise next to the others
		CHECK(feed(e, bitsOf(raw24, 24), te, true, r) && r.type == 24);
		CHECK(feed(e, frame26(card), te, true, r) && r.type == 26 && r.code == card);
		CHECK(feed(e, bitsOf(raw32, 32), te, true, r) && r.type == 32);
		CHECK(feed(e, frame34(uid), te, true, r) && r.type == 34 && r.code == uid);
		CHECK(!feed(e, bitsOf(0x1FFFFFF, 25), te, true, r)); // 25 bits: noise
		std::vector<int> b33 = bitsOf(0xFFFFFFFFu, 32);
		b33.push_back(1);
		CHECK(!feed(e, b33, te, true, r)); // 33 bits: noise
	}

	// the stored user id: decimal, or "hexadecimal" (User ID storage mode)
	// in lower case without leading zeros, as upstream's String(code, HEX)
	CHECK(core::wiegandUid(0x013039, false) == "77881");
	CHECK(core::wiegandUid(0x013039, true) == "13039");
	CHECK(core::wiegandUid(0xDEADBEEFu, true) == "deadbeef");
	CHECK(core::wiegandUid(0xDEADBEEFu, false) == "3735928559");
	CHECK(core::wiegandUid(0xFFFFFFFFu, false) == "4294967295");
	CHECK(core::wiegandUid(0, true) == "0" && core::wiegandUid(0, false) == "0");
	CHECK(core::wiegandUid(0x00ABCD, true) == "abcd");
}

static void testAccess()
{
	core::AccessInput in;
	in.numRelays = 2;
	in.now = 1000;
	in.validUntil = 2000;
	in.acctype[0] = 1;
	in.acctype[1] = 0;

	// reader on door 1 (index 0): opens door 1 only
	in.readerDoor = 0;
	core::AccessDecision d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Granted && d.relayMask == 0x1);
	// same user at the door-2 reader: no permission there
	in.readerDoor = 1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::NotValid && d.relayMask == 0);
	// user with door 2 only, at door 2: opens door 2 only (legacy would refuse)
	in.acctype[0] = 0;
	in.acctype[1] = 1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Granted && d.relayMask == 0x2);
	in.readerDoor = -1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::NotValid); // legacy: door 1 decides
	// legacy: both doors allowed -> both open
	in.acctype[0] = 1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Granted && d.relayMask == 0x3);
	// admin at a door-bound reader opens only that door
	in.acctype[1] = 99;
	in.readerDoor = 1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Admin && d.relayMask == 0x2);
	in.acctype[0] = 99;
	in.readerDoor = -1;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Admin && d.relayMask == 0x3);
	// expiry and opening hours
	in.acctype[0] = 1;
	in.readerDoor = 0;
	in.validUntil = 999;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::Expired);
	in.validUntil = 2000;
	in.validSince = 1500;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::Expired);
	in.validSince = 0;
	in.withinOpeningHours = false;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::NotValid);
	in.withinOpeningHours = true;
	// reader bound to a door that does not exist
	in.readerDoor = 3;
	CHECK(core::decideAccess(in).relayMask == 0);

	// Clock not set (no NTP, no RTC, after a power cut): admins and users
	// with no dates and no opening-hours limit get in; dated users and users
	// subject to opening hours are refused until the time is set.
	const uint32_t NO_EXPIRY = 2145916800; // the editor default, 2038-01-01
	in.readerDoor = 0;
	in.acctype[0] = 1;
	in.validSince = 0;
	in.validUntil = NO_EXPIRY;
	in.now = 120; // seconds since boot
	in.withinOpeningHours = false; // unknown without a clock
	in.hoursRestricted = false;
	in.timeTrusted = false;
	d = core::decideAccess(in);
	CHECK(d.outcome == core::AccessOutcome::Granted && d.relayMask == 0x1);
	in.acctype[0] = 99;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::Admin);
	in.validUntil = 1767225600; // dated (2026-01-01): refused, admin too
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::ClockInvalid);
	in.acctype[0] = 1;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::ClockInvalid);
	in.validUntil = NO_EXPIRY;
	in.validSince = 1735689600; // valid from 2025-01-01: dated
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::ClockInvalid);
	in.validSince = 0;
	in.validUntil = 0; // record with no validuntil field: refused, as before
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::ClockInvalid);
	in.validUntil = NO_EXPIRY;
	in.hoursRestricted = true; // opening hours limit "always" users...
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::ClockInvalid);
	in.acctype[0] = 99; // ...but never admins
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::Admin);
	in.acctype[0] = 0; // disabled stays disabled
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::NotValid);
	// once the time is set the normal rules apply again
	in.acctype[0] = 1;
	in.timeTrusted = true;
	in.now = 1767225600;
	in.withinOpeningHours = true;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::Granted);
	in.withinOpeningHours = false;
	CHECK(core::decideAccess(in).outcome == core::AccessOutcome::NotValid);
	in.withinOpeningHours = true;
	in.hoursRestricted = false;

	// opening-hours row: tm_wday (0 = Sunday) -> row 0 = Monday ... 6 = Sunday
	CHECK(core::openingHoursRow(1) == 0 && core::openingHoursRow(0) == 6 && core::openingHoursRow(6) == 5);
	const char *open7[7] = {"111111111111111111111111", "111111111111111111111111", "111111111111111111111111",
		"111111111111111111111111", "111111111111111111111111", "111111111111111111111111", "111111111111111111111111"};
	CHECK(!core::hoursRestricted(open7));
	const char *shut[7] = {"111111111111111111111111", "111111111111111111111111", "111111111111111111111111",
		"111111111111111111111111", "111111111111111111111111", "111111111111111111111111", "011111111111111111111111"};
	CHECK(core::hoursRestricted(shut));
	shut[6] = nullptr; // a missing day is treated as closed
	CHECK(core::hoursRestricted(shut));
	// the hour test uses local time: Monday 08:00 local is row 0, column 8
	CHECK(core::openAt(open7, 1, 8) && !core::openAt(open7, 1, 24) && !core::openAt(open7, -1, 8));
	const char *mornings[7] = {"000000001111000000000000", "000000000000000000000000", "000000000000000000000000",
		"000000000000000000000000", "000000000000000000000000", "000000000000000000000000", "000000000000000000000000"};
	CHECK(core::openAt(mornings, 1, 8) && core::openAt(mornings, 1, 11) && !core::openAt(mornings, 1, 12));
	CHECK(!core::openAt(mornings, 0, 8)); // Sunday is row 6

	// Values below -1 are invalid reader bindings, never the legacy all-door mode.
	in.readerDoor = -2;
	CHECK(core::decideAccess(in).relayMask == 0);
}

// MQTT access names (plan 1.9.1 C6): every role gives one entry, so the
// access and doorName arrays stay aligned
static void testAccessTypeName()
{
	const int types[] = {0, 1, 99, 7};
	const char *want[] = {"Disabled", "Always", "Admin", "Disabled"};
	for (int i = 0; i < 4; i++)
		CHECK(strcmp(core::accessTypeName(types[i]), want[i]) == 0);
	CHECK(strcmp(core::accessTypeName(-1), "Disabled") == 0 && strcmp(core::accessTypeName(98), "Disabled") == 0);
}

static void testPin()
{
	using core::PinPath;
	// card alone: no PIN asked
	CHECK(core::checkPin(PinPath::Card, "", "1234"));
	// card then PIN: only the stored pincode opens
	CHECK(core::checkPin(PinPath::CardThenPin, "1234", "1234"));
	CHECK(!core::checkPin(PinPath::CardThenPin, "9999", "1234"));
	CHECK(!core::checkPin(PinPath::CardThenPin, "", "1234"));
	// PIN required and no PIN stored: refused (it opened with the card alone)
	CHECK(!core::checkPin(PinPath::CardThenPin, "", ""));
	// PIN only: the record found by the typed digits must carry them as its
	// pincode. A PIN-only user is enrolled with uid = PIN and pincode = PIN.
	CHECK(core::checkPin(PinPath::PinOnly, "4711", "4711"));
	// decimal-UID card record (uid 12345678, PIN 4711): typing its card
	// number on the keypad finds /P/12345678 but must not open
	CHECK(!core::checkPin(PinPath::PinOnly, "12345678", "4711"));
	// a card record with no PIN is never reachable from the keypad
	CHECK(!core::checkPin(PinPath::PinOnly, "12345678", ""));
	CHECK(!core::checkPin(PinPath::PinOnly, "", ""));
	CHECK(!core::checkPin(PinPath::PinOnly, nullptr, nullptr));
}

// The most tries in any 24 hours after the first lockout, over 3 days: the
// guesser who tries the moment each lockout ends, and every steady pace from
// the 2 s reader cool-down to one try per 5 hours. Tries while locked are
// refused unchecked, so they do not count.
template <typename L>
static int worstTriesPerDay()
{
	const uint64_t H = 60ull * 60 * 1000, DAY = 24 * H;
	int worst = 0;
	for (uint64_t pace = 0; pace <= 5 * H; pace = pace < 60000 ? pace + 2000 : pace + 60000)
	{
		L a;
		std::vector<uint64_t> tries;
		uint64_t first = 0;
		for (uint64_t ta = 1000; ta < 3 * DAY;)
		{
			if (a.locked(ta))
			{
				ta += pace == 0 ? a.remainingMs(ta) : pace;
				continue;
			}
			if (first != 0)
				tries.push_back(ta);
			if (a.fail(ta) > 0 && first == 0)
				first = ta;
			ta += pace == 0 ? 2000 : pace;
		}
		for (size_t i = 0; i < tries.size(); i++)
		{
			size_t j = i;
			while (j < tries.size() && tries[j] < tries[i] + DAY)
				j++;
			worst = std::max(worst, (int)(j - i));
		}
	}
	return worst;
}

static void testPinLockout()
{
	core::PinLockout l;
	uint32_t t = 1000;
	for (int i = 0; i < 4; i++)
		CHECK(l.fail(t) == 0);
	CHECK(!l.locked(t) && l.failures() == 4);
	CHECK(l.fail(t) == 30000); // fifth wrong PIN: 30 s
	CHECK(l.locked(t) && l.locked(t + 29999) && !l.locked(t + 30000));
	CHECK(l.remainingMs(t + 10000) == 20000);
	CHECK(l.fail(t + 100) == 0 && l.failures() == 4); // not counted while locked
	// the lockout leaves the bucket one short of full (it used to empty it,
	// so every lockout bought 5 more guesses): one more wrong PIN after it
	// ends locks again, each lockout twice as long, capped at 15 min
	uint32_t expect[] = {60000, 120000, 240000, 480000, 900000, 900000};
	uint32_t len = 30000;
	for (uint32_t ms : expect)
	{
		CHECK(l.fail(t + len - 1) == 0); // still locked
		t += len;
		CHECK(l.fail(t) == ms);
		len = ms;
	}
	// nothing but time clears it (a correct PIN used to, so one known PIN
	// gave endless guesses): once the bucket has drained empty, 4 hours
	// after the last lockout ended, the doubling starts again from FIRST_MS
	// with a full allowance
	const uint64_t H = core::PinLockout::FORGIVE_MS;
	uint64_t ended = (uint64_t)t + 900000;
	CHECK(!l.expire(ended + 4 * H - 1) && l.level() == 900000);
	CHECK(l.expire(ended + 4 * H) && l.level() == 0);
	CHECK(!l.expire(ended + 4 * H + 1)); // reported once
	uint64_t t2 = ended + 4 * H;
	for (int i = 0; i < 4; i++)
		CHECK(l.fail(t2) == 0);
	CHECK(l.fail(t2) == 30000);
	// sustained guessing after a lockout: about one try per 15 min lockout,
	// at most 99 in a day (96 once at 15 min); until 1.4.1 every lockout
	// bought 5 more PINs (about 480 a day) or 10 more cards (about 960)
	int worstPin = worstTriesPerDay<core::PinLockout>();
	int worstCard = worstTriesPerDay<core::CardAlarm>();
	printf("lockouts: at most %d PINs, %d unknown cards a day after the first lockout\n", worstPin, worstCard);
	CHECK(worstPin > 90 && worstPin <= 100 && worstCard > 90 && worstCard <= 100);
	// an owner locked out in the evening who mistypes once the next morning
	// is not locked, and has the full allowance back
	{
		core::PinLockout m;
		for (int i = 0; i < 5; i++)
			m.fail(1000);
		CHECK(m.locked(1000));
		uint64_t morning = 1000 + 10 * H;
		CHECK(m.expire(morning) && m.level() == 0);
		for (int i = 0; i < 4; i++)
			CHECK(m.fail(morning + i * 5000) == 0);
		// but a slip soon after a lockout locks again
		core::PinLockout m2;
		for (int i = 0; i < 5; i++)
			m2.fail(1000);
		CHECK(m2.fail(1000 + 30000 + H / 2) == 60000);
	}
	// leaky bucket: one wrong PIN forgiven per FORGIVE_MS (an hour)
	CHECK(H == 60ull * 60 * 1000 && core::CardAlarm::FORGIVE_MS == 30ull * 60 * 1000);
	core::PinLockout f;
	for (int i = 0; i < 4; i++)
		CHECK(f.fail(1000) == 0);
	CHECK(f.fail(1000 + H) == 0 && f.failures() == 4); // one drained, one added
	CHECK(f.fail(1000 + H + H / 2) == 30000);			// the part-hour carried over: still 4 in it
	core::PinLockout g;
	for (int i = 0; i < 4; i++)
		g.fail(1000);
	CHECK(g.fail(1000 + 4 * H) == 0 && g.failures() == 1); // all four drained
	// pacing at the old safe rate (4 wrong PINs every 10 min, the count used
	// to restart after 10 quiet minutes: about 576 a day) now locks, within
	// the second round
	core::PinLockout p;
	uint64_t tp = 5000, lockedAt = 0;
	for (int round = 0; round < 144 && lockedAt == 0; round++, tp += 10 * 60 * 1000)
		for (int i = 0; i < 4 && lockedAt == 0; i++)
			if (p.fail(tp + i * 3000) > 0)
				lockedAt = tp;
	CHECK(lockedAt == 5000 + 10 * 60 * 1000);
	// ...and so does a slower steady pace, just above one an hour
	core::PinLockout q;
	bool qLocked = false;
	for (uint64_t tq = 0; tq < 30 * 24 * H && !qLocked; tq += H - H / 10)
		qLocked = q.fail(tq) > 0;
	CHECK(qLocked);
	// an honest user never locks: a wrong PIN every hour, for a month...
	core::PinLockout o;
	for (uint64_t to = 0; to < 30 * 24 * H; to += H)
		CHECK(o.fail(to) == 0);
	// ...or three slips in a row, twice a day, for a month
	core::PinLockout o2;
	for (uint64_t to = 0; to < 30 * 24 * H; to += 12 * H)
		for (int i = 0; i < 3; i++)
			CHECK(o2.fail(to + i * 5000) == 0);
	// unknown cards: the old safe rate (9 every 10 min) locks too; one card
	// every 30 min never does
	core::CardAlarm c;
	uint64_t tc = 0;
	bool cLocked = false;
	for (int round = 0; round < 2 && !cLocked; round++, tc += 10 * 60 * 1000)
		for (int i = 0; i < 9 && !cLocked; i++)
			cLocked = c.fail(tc + i * 3000) > 0;
	CHECK(cLocked);
	core::CardAlarm co;
	for (uint64_t to = 0; to < 30 * 24 * H; to += core::CardAlarm::FORGIVE_MS)
		CHECK(co.fail(to) == 0);
	// 64-bit time, across the old 32-bit millis() boundary
	core::PinLockout w;
	uint64_t tw = WRAP32 - 4096;
	for (int i = 0; i < 5; i++)
		w.fail(tw);
	CHECK(w.locked(tw + 20000) && !w.locked(tw + 30000));
	// the 32-bit lockout came back on 2^31 ms (24.8 days) after it ended, and
	// stayed on for 24.8 more: PIN users at that reader could not get in
	CHECK(!w.locked(tw + 30000 + DAYS_24_8));
	CHECK(!w.locked(tw + 30000 + DAYS_24_8 + 1000));
	CHECK(!w.locked(tw + 30000 + WRAP32));
	CHECK(w.fail(tw + 30000 + DAYS_24_8) == 0 && w.failures() == 1); // counted again

	// restart: resume the stored level, locked for all of it, then keep doubling
	core::PinLockout r;
	CHECK(r.level() == 0);
	r.restore(0, 500); // nothing stored
	CHECK(!r.locked(500) && r.level() == 0);
	r.restore(120000, 500);
	CHECK(r.locked(500) && r.locked(120499) && !r.locked(120500) && r.level() == 120000);
	CHECK(r.fail(200000) == 240000); // and the bucket one short of full
	r.restore(99999999, 0); // a damaged stored value is clamped
	CHECK(r.level() == core::PinLockout::MAX_MS);
	r.restore(5, 0);
	CHECK(r.level() == core::PinLockout::FIRST_MS);
	uint64_t quiet = core::PinLockout::FIRST_MS + 4 * H;
	CHECK(!r.expire(quiet - 1) && r.expire(quiet) && r.level() == 0 && !r.locked(quiet));
}

// ---- reader sessions (core/reader.h) ---------------------------------------

struct FakeUsers
{
	std::map<std::string, core::UserRecord> users;
	core::AccessInput clk; // now, timeTrusted, hoursRestricted, withinOpeningHours
	int lookups = 0;
	bool busy = false; // every lookup runs out of memory
	core::Lookup lookup(const char *uid, core::UserRecord &out)
	{
		lookups++;
		if (busy)
			return core::Lookup::Busy;
		auto it = users.find(uid);
		if (it == users.end())
			return core::Lookup::Missing;
		out = it->second;
		return core::Lookup::Found;
	}
	void clock(core::AccessInput &in)
	{
		in.now = clk.now;
		in.timeTrusted = clk.timeTrusted;
		in.hoursRestricted = clk.hoursRestricted;
		in.withinOpeningHours = clk.withinOpeningHours;
	}
	void add(const char *uid, const char *name, const char *pin, int door1 = 1, int door2 = 0)
	{
		core::UserRecord r;
		r.user = name;
		r.pincode = pin;
		r.acctype[0] = door1;
		r.acctype[1] = door2;
		r.validSince = 0;
		r.validUntil = 2145916800; // 2038-01-01, the editor's default
		users[uid] = r;
	}
};

static core::CardRead wiegandCard(const char *uid)
{
	core::CardRead c;
	c.uid = uid;
	c.type = "26";
	return c;
}

// Types digits on the keypad ('*' = ENTER, '#' = ESC), 300 ms apart, and
// returns the first result with a verdict (or the last one).
static core::ReaderResult typeKeys(core::ReaderSession &s, FakeUsers &io, const core::ReaderSettings &cfg, uint64_t &t, const char *keys)
{
	core::ReaderResult last;
	for (const char *c = keys; *c; c++)
	{
		uint32_t k = *c == '*' ? core::KEY_ENTER : (*c == '#' ? core::KEY_ESC : (uint32_t)(*c - '0'));
		last = s.step(io, cfg, t, nullptr, &k);
		t += 300;
		if (last.verdict != core::Verdict::None)
			return last;
	}
	return last;
}

static bool noPin(const core::ReaderResult &r, const char *pin)
{
	return r.shownUid.find(pin) == std::string::npos && r.username.find(pin) == std::string::npos && r.type.find(pin) == std::string::npos;
}

// plan 1.9 D4: wrong PIN-only entries add up across readers; card+PIN keeps
// its reader's own lockout
static void testPinOnlyLockout()
{
	FakeUsers io;
	io.clk.now = 1760000000;
	io.clk.timeTrusted = true;
	io.add("739512", "Carol", "739512"); // PIN-only user
	io.add("23456789", "Bob", "4821");   // card + PIN
	core::PinLockout shared;
	core::ReaderSettings pinOnly;
	pinOnly.pinOnly = true;
	pinOnly.pinRequired = true; // both: digits alone, or a card then its PIN
	pinOnly.pinOnlyLockout = &shared;
	core::ReaderSession r1, r2;
	uint64_t t = 1000;
	// three wrong at reader 1, two at reader 2: the fifth locks PIN-only everywhere
	uint32_t started = 0;
	for (int i = 0; i < 5; i++)
	{
		core::ReaderSession &s = i < 3 ? r1 : r2;
		core::ReaderResult r = typeKeys(s, io, pinOnly, t, "111111*");
		CHECK(r.verdict == core::Verdict::WrongPin && r.keypadEntry);
		started = r.pinOnlyLockoutStarted;
		CHECK((i < 4) == (started == 0));
		t += 3000;
	}
	CHECK(started == core::PinLockout::FIRST_MS && shared.locked(t));
	CHECK(!r1.pinLockout().locked(t) && !r2.pinLockout().locked(t)); // neither reader reached its own five
	// the right PIN-only code is refused at both readers meanwhile
	CHECK(typeKeys(r1, io, pinOnly, t, "739512*").verdict == core::Verdict::KeypadLocked);
	t += 3000;
	CHECK(typeKeys(r2, io, pinOnly, t, "739512*").verdict == core::Verdict::KeypadLocked);
	t += 3000;
	// card + PIN still opens at either reader
	core::CardRead b = wiegandCard("23456789");
	r2.step(io, pinOnly, t, &b, nullptr);
	t += 100;
	CHECK(typeKeys(r2, io, pinOnly, t, "4821*").verdict == core::Verdict::Granted);
	t += 3000;
	// after the lockout the right code opens again
	t += core::PinLockout::FIRST_MS;
	CHECK(typeKeys(r1, io, pinOnly, t, "739512*").verdict == core::Verdict::Granted);
	t += 3000;
	// a wrong card PIN does not count toward the PIN-only lockout
	core::PinLockout fresh;
	pinOnly.pinOnlyLockout = &fresh;
	core::ReaderSession r3; // a reader with no wrong PINs of its own yet
	for (int i = 0; i < 4; i++)
	{
		r3.step(io, pinOnly, t, &b, nullptr);
		t += 100;
		CHECK(typeKeys(r3, io, pinOnly, t, "1111*").verdict == core::Verdict::WrongPin);
		t += 3000;
	}
	CHECK(fresh.failures() == 0);
}

// plan 1.9 D1: the cool-down after unknown cards (READER_UNKNOWN_*)
static void testUnknownCooldown()
{
	FakeUsers io;
	io.clk.now = 1760000000;
	io.clk.timeTrusted = true;
	io.add("12345678", "Alice", "");
	core::ReaderSession s;
	core::ReaderSettings cfg;
	core::CardRead a = wiegandCard("12345678");
	core::CardRead u1 = wiegandCard("90000001"), u2 = wiegandCard("90000002"), u3 = wiegandCard("90000003");
	uint64_t t = 1000;
	// a valid card: the usual 2 s
	CHECK(s.step(io, cfg, t, &a, nullptr).verdict == core::Verdict::Granted);
	CHECK(s.coolingDown(t + core::READER_COOLDOWN_MS - 1) && !s.coolingDown(t + core::READER_COOLDOWN_MS));
	t += 3000;
	// the first unknown card: 5 s, every card ignored meanwhile, valid ones too
	CHECK(s.step(io, cfg, t, &u1, nullptr).verdict == core::Verdict::Unknown);
	CHECK(s.step(io, cfg, t + 4999, &a, nullptr).verdict == core::Verdict::None);
	CHECK(s.step(io, cfg, t + 5000, &a, nullptr).verdict == core::Verdict::Granted); // then a valid card opens
	t += 5000 + core::READER_COOLDOWN_MS;
	// another unknown card within a minute of the last: 10 s
	CHECK(s.step(io, cfg, t, &u2, nullptr).verdict == core::Verdict::Unknown);
	CHECK(s.coolingDown(t + 9999) && !s.coolingDown(t + 10000));
	t += 10000;
	CHECK(s.step(io, cfg, t, &u3, nullptr).verdict == core::Verdict::Unknown); // and the next
	CHECK(s.coolingDown(t + 9999) && !s.coolingDown(t + 10000));
	// a minute with no unknown card: back to 5 s
	t += 61000;
	CHECK(s.step(io, cfg, t, &u1, nullptr).verdict == core::Verdict::Unknown);
	CHECK(s.coolingDown(t + 4999) && !s.coolingDown(t + 5000));
	// a guesser at one card every 10 s: 360 an hour (1,800 at the old 2 s)
	t += 5000;
	int tries = 0;
	for (uint64_t end = t + 3600000; t < end; t += 100)
		if (s.acceptsCard(t))
		{
			std::string uid = "8" + std::to_string(1000000 + tries);
			core::CardRead g = wiegandCard(uid.c_str());
			if (s.step(io, cfg, t, &g, nullptr).verdict == core::Verdict::Unknown)
				tries++;
		}
	CHECK(tries >= 355 && tries <= 362);
}

static void testReader()
{
	FakeUsers io;
	io.clk.now = 1760000000; // 2025
	io.clk.timeTrusted = true;
	io.add("12345678", "Alice", "");     // card, no PIN
	io.add("23456789", "Bob", "4821");   // card with a PIN
	io.add("7395", "Carol", "7395");     // PIN-only user: the uid is the PIN
	io.add("34567890", "Dave", "", 0, 1); // door 2 only
	io.add("99999999", "Root", "", 99, 99);
	uint64_t t = 1000;

	// a card, no PIN asked for
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		core::CardRead c = wiegandCard("12345678");
		core::ReaderResult r = s.step(io, cfg, t, &c, nullptr);
		CHECK(r.verdict == core::Verdict::Granted && r.relayMask == 1 && r.shownUid == "12345678" && r.username == "Alice" && r.type == "26");
		CHECK(!r.keypadEntry && s.idle() && s.coolingDown(t + 1999) && !s.coolingDown(t + 2000));
		CHECK(s.step(io, cfg, t + 100, &c, nullptr).verdict == core::Verdict::None); // cooling down
		t += 3000;
		core::CardRead u = wiegandCard("11112222");
		r = s.step(io, cfg, t, &u, nullptr);
		CHECK(r.verdict == core::Verdict::Unknown && r.shownUid == "11112222" && !r.denied() && r.relayMask == 0);
		// an unknown card: 5 s before the next card is read (plan 1.9 D1)
		CHECK(s.coolingDown(t + core::READER_UNKNOWN_COOLDOWN_MS - 1) && !s.coolingDown(t + core::READER_UNKNOWN_COOLDOWN_MS));
		t += 11000;
		// the reader-2 binding: only its own door, and only if the user may use it
		cfg.door = 1;
		cfg.numRelays = 2;
		core::CardRead d = wiegandCard("34567890");
		r = s.step(io, cfg, t, &d, nullptr);
		CHECK(r.verdict == core::Verdict::Granted && r.relayMask == 2);
		t += 3000;
		r = s.step(io, cfg, t, &c, nullptr); // Alice: door 1 only
		CHECK(r.verdict == core::Verdict::NotValid && r.relayMask == 0 && r.denied());
		t += 3000;
		core::CardRead a = wiegandCard("99999999");
		r = s.step(io, cfg, t, &a, nullptr);
		CHECK(r.verdict == core::Verdict::Admin && r.relayMask == 2 && r.granted());
		t += 3000;
	}

	// frames lost mid-PIN (plan 1.9.1 C1): cancel() ends the entry with no
	// decision and no lockout count; with nothing in progress it does nothing
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		cfg.pinRequired = true;
		uint64_t c = 900000;
		CHECK(s.cancel(c).verdict == core::Verdict::None && s.idle()); // nothing in progress
		core::CardRead b = wiegandCard("23456789");
		CHECK(s.step(io, cfg, c, &b, nullptr).pinPrompt);
		uint64_t tk = c + 100;
		typeKeys(s, io, cfg, tk, "48");
		core::ReaderResult r = s.cancel(c + 200);
		CHECK(r.verdict == core::Verdict::Cancelled && !r.granted() && !r.denied() && r.shownUid == "23456789");
		CHECK(s.idle() && !s.waitingForPin() && s.coolingDown(c + 200) && s.pinLockout().failures() == 0);
		// keypad-only digits being typed: cancelled too, still no lockout count
		cfg.pinRequired = false;
		cfg.pinOnly = true;
		c += 5000;
		tk = c;
		typeKeys(s, io, cfg, tk, "739");
		CHECK(s.waitingForPin());
		r = s.cancel(c + 100);
		CHECK(r.verdict == core::Verdict::Cancelled && r.keypadEntry && s.pinLockout().failures() == 0 && s.idle());
	}

	// a card whose number is a keypad-only user's uid (= its PIN) is not that
	// user (review 8 V2, plan 1.9.1 B2/D3): Unknown, counted by the
	// unknown-card alarm, and the keypad still opens with the same digits
	{
		FakeUsers kio;
		kio.clk.now = 1760000000;
		kio.clk.timeTrusted = true;
		kio.add("123456", "Keypad Kim", "123456"); // keypad-only: /P/123456, PIN 123456
		uint64_t k = 5000;
		core::ReaderSession s;
		core::ReaderSettings cfg;
		cfg.pinOnly = true; // a keypad is fitted: digits are looked up as a uid
		core::CardRead c = wiegandCard("123456");
		core::ReaderResult r = s.step(kio, cfg, k, &c, nullptr);
		CHECK(r.verdict == core::Verdict::Unknown && r.relayMask == 0 && !r.granted() && r.username.empty() && s.cardAlarm().failures() == 1);
		k += 11000;
		r = typeKeys(s, kio, cfg, k, "123456*");
		CHECK(r.verdict == core::Verdict::Granted && r.username == "Keypad Kim" && r.relayMask == 1 && r.keypadEntry);
		k += 3000;
		// PIN required: the same card is Unknown at once (no PIN prompt, not NoPin),
		// and typing the PIN after it cannot turn it into that user
		cfg.pinRequired = true;
		r = s.step(kio, cfg, k, &c, nullptr);
		CHECK(r.verdict == core::Verdict::Unknown && !r.pinPrompt && !s.waitingForPin() && s.cardAlarm().failures() == 2);
		k += 11000;
		// a card user with a PIN of its own is still asked for it (positive control)
		kio.add("23456789", "Bob", "4821");
		core::CardRead b = wiegandCard("23456789");
		r = s.step(kio, cfg, k, &b, nullptr);
		CHECK(r.pinPrompt && s.waitingForPin());
		k += 100;
		r = typeKeys(s, kio, cfg, k, "4821*");
		CHECK(r.verdict == core::Verdict::Granted && r.username == "Bob");
	}

	// 24.8 days and 49.7 days of uptime: the reader still decides (with
	// 32-bit millis() and a cool-down of 0 it went deaf at 2^31 ms)
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		core::CardRead c = wiegandCard("12345678");
		for (uint64_t at : {DAYS_24_8 + 5, WRAP32 + 5, WRAP32 + DAYS_24_8 + 5})
			CHECK(s.step(io, cfg, at, &c, nullptr).verdict == core::Verdict::Granted);
	}

	// card then PIN
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		cfg.pinRequired = true;
		core::CardRead b = wiegandCard("23456789");
		core::ReaderResult r = s.step(io, cfg, t, &b, nullptr);
		CHECK(r.pinPrompt && r.verdict == core::Verdict::None && s.waitingForPin() && !s.idle());
		core::CardRead other = wiegandCard("12345678");
		CHECK(s.step(io, cfg, t + 10, &other, nullptr).verdict == core::Verdict::None); // a second card is ignored meanwhile
		t += 100;
		r = typeKeys(s, io, cfg, t, "4821*");
		CHECK(r.verdict == core::Verdict::Granted && r.username == "Bob" && r.shownUid == "23456789" && noPin(r, "4821"));
		CHECK(!s.waitingForPin() && s.coolingDown(t));
		t += 3000;
		// a card enrolled without a PIN is not asked for one, and is refused:
		// PIN required means required (it opened with the card alone)
		core::CardRead a = wiegandCard("12345678");
		r = s.step(io, cfg, t, &a, nullptr);
		CHECK(!r.pinPrompt && r.verdict == core::Verdict::NoPin && r.denied() && r.relayMask == 0);
		CHECK(r.username == "Alice" && r.shownUid == "12345678" && !r.keypadEntry && s.pinLockout().failures() == 0); // not a wrong PIN
		CHECK(r.acctype == core::ACC_GRANTED); // her role in the log, not "Disabled" (H26.2)
		t += 3000;
		core::CardRead root = wiegandCard("99999999");
		r = s.step(io, cfg, t, &root, nullptr);
		CHECK(r.verdict == core::Verdict::NoPin && r.acctype == core::ACC_ADMIN && r.username == "Root"); // admins too
		t += 3000;
		// an unknown card is decided at once
		core::CardRead u = wiegandCard("55556666");
		CHECK(s.step(io, cfg, t, &u, nullptr).verdict == core::Verdict::Unknown);
		t += 11000;
		// wrong PIN
		s.step(io, cfg, t, &b, nullptr);
		t += 100;
		r = typeKeys(s, io, cfg, t, "1111*");
		CHECK(r.verdict == core::Verdict::WrongPin && r.shownUid == "23456789" && !r.keypadEntry && noPin(r, "1111") && r.relayMask == 0);
		CHECK(r.username == "Bob" && r.acctype == core::ACC_GRANTED); // was no name and "Disabled" (H26.2)
		CHECK(s.pinLockout().failures() == 1);
		t += 3000;
		// ESC cancels; no verdict that logs anything
		s.step(io, cfg, t, &b, nullptr);
		t += 100;
		r = typeKeys(s, io, cfg, t, "48#");
		CHECK(r.verdict == core::Verdict::Cancelled && !r.granted() && !r.denied());
		t += 3000;
		// the keypad timeout ends a PIN entry without a verdict
		s.step(io, cfg, t, &b, nullptr);
		t += 100;
		typeKeys(s, io, cfg, t, "48");
		CHECK(s.waitingForPin());
		CHECK(!s.step(io, cfg, t + core::READER_KEY_TIMEOUT_MS - 400, nullptr, nullptr).timedOut);
		r = s.step(io, cfg, t + core::READER_KEY_TIMEOUT_MS, nullptr, nullptr);
		CHECK(r.timedOut && r.verdict == core::Verdict::None && !s.waitingForPin() && s.idle());
		t += core::READER_KEY_TIMEOUT_MS + 3000;
		// a non-digit key, or more than 16 digits: a wrong PIN
		s.step(io, cfg, t, &b, nullptr);
		uint32_t odd = 0x0C;
		r = s.step(io, cfg, t + 100, nullptr, &odd);
		CHECK(r.verdict == core::Verdict::WrongPin && r.username == "Bob" && r.acctype == core::ACC_GRANTED);
		t += 3000;
		s.step(io, cfg, t, &b, nullptr);
		t += 100;
		r = typeKeys(s, io, cfg, t, "12345678901234567");
		CHECK(r.verdict == core::Verdict::WrongPin && noPin(r, "1234567890"));
		t += 3000;
		// a card waiting for its PIN times out with the keypad timeout
		r = s.step(io, cfg, t, &b, nullptr);
		CHECK(r.pinPrompt && s.waitingForPin() && !s.acceptsCard(t + 1));
		r = s.step(io, cfg, t + core::READER_KEY_TIMEOUT_MS + 1, nullptr, nullptr);
		CHECK(r.timedOut);
		t += core::READER_KEY_TIMEOUT_MS + 3000;
		// after a decision a card is read again only after the cool-down
		cfg.pinRequired = false;
		r = s.step(io, cfg, t, &a, nullptr);
		CHECK(r.verdict == core::Verdict::Granted && !s.acceptsCard(t + 1999) && s.acceptsCard(t + 2000));
		cfg.pinRequired = true;
		t += 3000;
	}

	// PIN only
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		cfg.pinOnly = true;
		core::ReaderResult r = typeKeys(s, io, cfg, t, "7395*");
		CHECK(r.verdict == core::Verdict::Granted && r.username == "Carol" && r.keypadEntry);
		CHECK(r.shownUid == "keypad" && noPin(r, "7395")); // the uid IS the PIN: never shown
		t += 3000;
		// an enrolled card number typed in is not a PIN
		r = typeKeys(s, io, cfg, t, "12345678*");
		CHECK(r.verdict == core::Verdict::WrongPin && r.shownUid == "keypad" && noPin(r, "12345678") && r.username.empty());
		CHECK(r.acctype == core::ACC_UNKNOWN); // nobody is named: "Unknown", not "Disabled"
		t += 3000;
		// digits matching nobody: a wrong PIN, not an unknown card
		r = typeKeys(s, io, cfg, t, "0000*");
		CHECK(r.verdict == core::Verdict::WrongPin && r.shownUid == "keypad" && noPin(r, "0000"));
		t += 3000;
		// a card still works with PIN-only on
		core::CardRead a = wiegandCard("12345678");
		CHECK(s.step(io, cfg, t, &a, nullptr).verdict == core::Verdict::Granted);
		t += 3000;
		s.pinLockout() = core::PinLockout();
		// four wrong PINs then a right one, repeated, used to reset the count
		// every time (endless guessing for anyone who knows one PIN); the
		// wrong ones now add up and the fifth locks the keypads
		bool lockedOut = false;
		for (int round = 0; round < 2 && !lockedOut; round++)
		{
			for (int i = 0; i < 4 && !lockedOut; i++)
			{
				r = typeKeys(s, io, cfg, t, "1000*");
				lockedOut = r.lockoutStarted > 0;
				t += 3000;
			}
			if (!lockedOut)
			{
				r = typeKeys(s, io, cfg, t, "7395*");
				CHECK(r.verdict == core::Verdict::Granted);
				t += 3000;
			}
		}
		CHECK(lockedOut);
		t += core::PinLockout::FIRST_MS;
		s.pinLockout() = core::PinLockout();
		// five wrong PINs lock every keypad; the right one is then refused
		uint32_t started = 0;
		for (int i = 0; i < 5; i++)
		{
			r = typeKeys(s, io, cfg, t, "1000*");
			started = r.lockoutStarted;
			t += 3000;
		}
		CHECK(started == core::PinLockout::FIRST_MS);
		r = typeKeys(s, io, cfg, t, "7395*");
		CHECK(r.verdict == core::Verdict::KeypadLocked && r.shownUid == "keypad" && noPin(r, "7395"));
		t += core::PinLockout::FIRST_MS;
		r = typeKeys(s, io, cfg, t, "7395*");
		CHECK(r.verdict == core::Verdict::Granted && s.pinLockout().level() == core::PinLockout::FIRST_MS); // kept: only time clears it
		t += 3000;
		// the lockout is this reader's: card+PIN here is locked too, but
		// another reader (the inside one people leave by) is not; up to
		// 1.4.0 one lockout covered every keypad
		for (int i = 0; i < 5; i++)
		{
			typeKeys(s, io, cfg, t, "1000*");
			t += 3000;
		}
		CHECK(s.pinLockout().locked(t));
		core::ReaderSettings pinCfg;
		pinCfg.pinRequired = true;
		core::CardRead b = wiegandCard("23456789");
		s.step(io, pinCfg, t, &b, nullptr);
		t += 100;
		r = typeKeys(s, io, pinCfg, t, "4821*");
		CHECK(r.verdict == core::Verdict::KeypadLocked && r.shownUid == "23456789" && noPin(r, "4821"));
		CHECK(r.username == "Bob" && r.acctype == core::ACC_GRANTED);
		core::ReaderSession other;
		other.step(io, pinCfg, t, &b, nullptr);
		t += 100;
		r = typeKeys(other, io, pinCfg, t, "4821*");
		CHECK(r.verdict == core::Verdict::Granted && !other.pinLockout().locked(t));
		t += core::PinLockout::FIRST_MS * 4;
	}

	// both PIN required and PIN only: a card asks for its PIN, digits alone work
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		cfg.pinRequired = true;
		cfg.pinOnly = true;
		core::ReaderResult r = typeKeys(s, io, cfg, t, "7395*");
		CHECK(r.verdict == core::Verdict::Granted && r.shownUid == "keypad");
		t += 3000;
		core::CardRead b = wiegandCard("23456789");
		CHECK(s.step(io, cfg, t, &b, nullptr).pinPrompt);
		t += 100;
		r = typeKeys(s, io, cfg, t, "4821*");
		CHECK(r.verdict == core::Verdict::Granted && r.shownUid == "23456789");
		t += 3000;
	}

	// keys with neither PIN mode on are ignored
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		core::ReaderResult r = typeKeys(s, io, cfg, t, "7395*");
		CHECK(r.verdict == core::Verdict::None && s.idle());
	}

	// the clock: dated users wait for it, an expired user is refused
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		io.add("44445555", "Eve", "");
		io.users["44445555"].validUntil = 1700000000; // 2023
		core::CardRead e = wiegandCard("44445555");
		CHECK(s.step(io, cfg, t, &e, nullptr).verdict == core::Verdict::Expired);
		t += 3000;
		io.clk.timeTrusted = false;
		CHECK(s.step(io, cfg, t, &e, nullptr).verdict == core::Verdict::ClockInvalid);
		t += 3000;
		core::CardRead a = wiegandCard("12345678");
		CHECK(s.step(io, cfg, t, &a, nullptr).verdict == core::Verdict::Granted); // undated: no clock needed
		t += 3000;
		io.clk.timeTrusted = true;
	}

	// unknown cards raise an alarm at a reader and refuse nothing else
	// (2026-10-16: valid cards always pass; up to 1.4.2 ten unknown
	// cards made the reader refuse every card, so a few cheap tags kept
	// a door shut to its users)
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		core::CardRead a = wiegandCard("12345678");
		core::ReaderResult r;
		for (int i = 0; i < 9; i++)
		{
			std::string uid = "1000000" + std::to_string(i);
			core::CardRead u = wiegandCard(uid.c_str());
			r = s.step(io, cfg, t, &u, nullptr);
			CHECK(r.verdict == core::Verdict::Unknown && r.cardAlarmStarted == 0);
			t += 11000;
		}
		// a valid card does not reset the count, and does not count
		CHECK(s.step(io, cfg, t, &a, nullptr).verdict == core::Verdict::Granted && s.cardAlarm().failures() == 9);
		t += 3000;
		core::CardRead u = wiegandCard("10000099");
		r = s.step(io, cfg, t, &u, nullptr);
		CHECK(r.verdict == core::Verdict::Unknown && r.cardAlarmStarted == core::CardAlarm::FIRST_MS);
		t += 11000;
		// the alarm refuses nobody: a valid card still opens
		r = s.step(io, cfg, t, &a, nullptr);
		CHECK(r.verdict == core::Verdict::Granted && r.relayMask != 0 && r.username == "Alice");
		t += 3000;
		// more unknown cards while it is quiet: refused as unknown, no new alarm
		r = s.step(io, cfg, t, &u, nullptr);
		CHECK(r.verdict == core::Verdict::Unknown && r.cardAlarmStarted == 0);
		t += 11000;
		// with PIN required a valid card still gets its PIN prompt
		cfg.pinRequired = true;
		core::CardRead b = wiegandCard("23456789");
		r = s.step(io, cfg, t, &b, nullptr);
		CHECK(r.pinPrompt && s.waitingForPin());
		CHECK(s.step(io, cfg, t + core::READER_KEY_TIMEOUT_MS, nullptr, nullptr).timedOut);
		t += core::READER_KEY_TIMEOUT_MS;
		cfg.pinRequired = false;
		t += 3000;
		// once quiet, one more unknown card soon after alarms again, quiet for twice as long
		t += core::CardAlarm::FIRST_MS;
		core::CardRead v = wiegandCard("20000000");
		uint32_t started = s.step(io, cfg, t, &v, nullptr).cardAlarmStarted;
		t += 11000;
		CHECK(started == 2 * core::CardAlarm::FIRST_MS);
		// unknown cards no more often than one is forgiven never alarm
		core::ReaderSession slow;
		for (int i = 0; i < 12; i++)
		{
			std::string uid = "3000000" + std::to_string(i);
			core::CardRead v = wiegandCard(uid.c_str());
			CHECK(slow.step(io, cfg, t, &v, nullptr).cardAlarmStarted == 0);
			t += core::CardAlarm::FORGIVE_MS;
		}
	}
	// a lookup that runs out of memory: refused as Busy, try again; not
	// Unknown (it counted toward the unknown-card lockout) and not a wrong PIN
	{
		core::ReaderSession s;
		core::ReaderSettings cfg;
		io.busy = true;
		for (int i = 0; i < 2 * core::CardAlarm::MAX_FAILS; i++)
		{
			core::CardRead a = wiegandCard("12345678");
			core::ReaderResult r = s.step(io, cfg, t, &a, nullptr);
			CHECK(r.verdict == core::Verdict::Busy && r.denied() && r.relayMask == 0 && r.shownUid == "12345678" && r.cardAlarmStarted == 0);
			t += 3000;
		}
		CHECK(s.cardAlarm().failures() == 0 && !s.cardAlarm().locked(t));
		// PIN only: digits not checked are not a wrong PIN, and stay hidden
		cfg.pinOnly = true;
		for (int i = 0; i < 2 * core::PinLockout::MAX_FAILS; i++)
		{
			core::ReaderResult r = typeKeys(s, io, cfg, t, "7395*");
			CHECK(r.verdict == core::Verdict::Busy && r.keypadEntry && r.shownUid == "keypad" && noPin(r, "7395") && r.lockoutStarted == 0);
			t += 3000;
		}
		CHECK(s.pinLockout().failures() == 0);
		cfg.pinOnly = false;
		// PIN required: refused at the card, no PIN prompt
		cfg.pinRequired = true;
		core::CardRead b = wiegandCard("23456789");
		core::ReaderResult r = s.step(io, cfg, t, &b, nullptr);
		CHECK(!r.pinPrompt && r.verdict == core::Verdict::Busy && !s.waitingForPin());
		t += 3000;
		// memory back: the same card works at once
		io.busy = false;
		cfg.pinRequired = false;
		core::CardRead a = wiegandCard("12345678");
		CHECK(s.step(io, cfg, t, &a, nullptr).verdict == core::Verdict::Granted);
		t += 3000;
	}
	printf("reader: %d user lookups\n", io.lookups);
}

struct FakeRelayIo
{
	std::map<int, int> level; // pin -> level
	std::vector<std::string> ops;
	int read(int pin) { return level.count(pin) ? level[pin] : 0; }
	void write(int pin, int v)
	{
		level[pin] = v;
		ops.push_back("write " + std::to_string(pin) + "=" + std::to_string(v));
	}
	void pulse(int relay, unsigned long ms)
	{
		ops.push_back("pulse " + std::to_string(relay) + " " + std::to_string(ms));
	}
	void report(int relay, bool unlocked)
	{
		ops.push_back("report " + std::to_string(relay) + (unlocked ? " UNLOCKED" : " LOCKED"));
	}
};

static void testDoorMonitor()
{
	// the contact closes to GND when the door is shut (pull-up on the pin):
	// LOW is shut, HIGH is open, and so is a cut wire. Upstream had LOW as
	// open, so a shut door raised the tamper alarm and a forced one read shut.
	CHECK(!core::contactOpen(0));
	CHECK(core::contactOpen(1));
	// started closed, then a normal entry: lock released, door opens and closes
	core::DoorMonitor d;
	core::DoorUpdate u = d.update(false, false, 1000, 0);
	CHECK(u.doorChanged && !u.doorOpen && u.logs == 0 && !u.tamperChanged); // the state is published at start
	CHECK(d.update(false, false, 1100, 0).logs == 0);
	u = d.update(true, true, 2000, 0);
	CHECK(u.logs == 1 && strcmp(u.log[0].desc, "Door Open") == 0 && u.doorChanged && u.doorOpen && !u.tamperChanged);
	u = d.update(false, false, 5000, 0);
	CHECK(u.logs == 1 && strcmp(u.log[0].desc, "Door Closed") == 0 && u.doorChanged && !u.doorOpen);
	// forced: opened while locked; closing clears the tamper state
	u = d.update(true, false, 6000, 0);
	CHECK(u.logs == 2 && strcmp(u.log[1].desc, "Door was tampered!") == 0 && strcmp(u.log[1].src, "tamper") == 0);
	CHECK(u.tamperChanged && u.tamper && d.tamper());
	u = d.update(false, false, 7000, 0);
	CHECK(u.tamperChanged && !u.tamper && !d.tamper());
	// left open: the alarm fires once, after the limit
	d.update(true, true, 10000, 30);
	CHECK(d.update(true, false, 10000 + 29999, 30).logs == 0); // the lock closing again is no alarm
	u = d.update(true, false, 10000 + 30000, 30);
	CHECK(u.logs == 1 && strstr(u.log[0].desc, "max open time") != nullptr && u.tamper);
	CHECK(d.update(true, false, 10000 + 90000, 30).logs == 0); // once
	CHECK(d.update(false, false, 200000, 30).tamperChanged);
	// no limit configured: never
	d.update(true, true, 300000, 0);
	CHECK(d.update(true, false, 300000 + 86400000ull, 0).logs == 0);
	// open when the controller starts, lock not released: tamper at once
	core::DoorMonitor s;
	u = s.update(true, false, 50, 60);
	CHECK(u.doorChanged && u.doorOpen && u.tamperChanged && u.tamper && strstr(u.log[0].desc, "when controller started") != nullptr);
	// ...but a door with its lock released (or no relay) is just open
	core::DoorMonitor r;
	u = r.update(true, true, 50, 60);
	CHECK(u.doorOpen && !u.tamperChanged && u.logs == 0);
	CHECK(r.update(true, true, 50 + 60000, 60).tamper); // and it can still be left open
	// 64-bit time: past the old 32-bit boundary
	core::DoorMonitor w;
	w.update(false, false, WRAP32 - 10, 5);
	w.update(true, true, WRAP32 - 5, 5);
	CHECK(w.update(true, false, WRAP32 + 4000, 5).logs == 0 && w.update(true, false, WRAP32 + 4995, 5).logs == 1);
	// grace after the relock: a door pulled open just as the pulse ended is
	// an entry, not a forced door
	core::DoorMonitor g;
	g.update(false, false, 1000, 60);
	g.update(false, true, 2000, 60);  // released
	g.update(false, true, 5000, 60);  // still released at 5000
	g.update(false, false, 5010, 60); // relocked
	u = g.update(true, false, 5000 + core::DOOR_RELOCK_GRACE_MS - 1, 60);
	CHECK(u.logs == 1 && strcmp(u.log[0].desc, "Door Open") == 0 && !u.tamperChanged && !g.tamper());
	CHECK(g.update(true, false, 5000 + 60000 - 2, 60).logs == 0); // the left-open timer runs from the opening
	CHECK(g.update(true, false, 5000 + core::DOOR_RELOCK_GRACE_MS - 1 + 60000, 60).tamper);
	g.update(false, false, 80000, 60);
	// ...but not after the grace
	u = g.update(true, false, 5000 + 80000, 60);
	CHECK(u.tamperChanged && u.tamper && strcmp(u.log[1].desc, "Door was tampered!") == 0);
	// no grace at boot: a lock never released gives none
	core::DoorMonitor b;
	b.update(false, false, 100, 0);
	CHECK(b.update(true, false, 200, 0).tamper);
}

static void testDoorbell()
{
	// button to GND with the pull-up: LOW is ringing. Upstream had HIGH, so an
	// idle button rang from boot.
	CHECK(core::doorbellPressed(0) && !core::doorbellPressed(1));
	core::DoorbellMonitor b;
	CHECK(b.update(core::doorbellPressed(1)) == 0 && !b.ringing()); // idle at boot: silent
	CHECK(b.update(core::doorbellPressed(0)) == 1 && b.ringing());  // pressed: rings once
	CHECK(b.update(true) == 0);                                     // held: no repeat
	CHECK(b.update(false) == -1 && !b.ringing());                   // released
	CHECK(b.update(false) == 0);
}

static void testExitButton()
{
	const uint64_t D = core::ExitButton::DEBOUNCE_US;
	// polled only (no interrupt): a press is reported once, after 30 ms held
	core::ExitButton b;
	b.begin(false, 0);
	CHECK(!b.poll(false, 1000));
	CHECK(!b.poll(true, 2000));
	CHECK(!b.poll(true, 2000 + D - 1));
	CHECK(b.poll(true, 2000 + D));
	CHECK(!b.poll(true, 2000 + 5 * D)); // held: once
	CHECK(!b.poll(false, 2000 + 6 * D)); // the release is not a second press
	// bounce: LOW spells shorter than 30 ms are not presses, polled or not
	b.edge(true, 100000);
	b.edge(false, 100000 + 2000);
	b.edge(true, 100000 + 3000);
	b.edge(false, 100000 + D + 2999);
	CHECK(!b.poll(false, 200000));
	// the point of the interrupt: loop() busy for the whole press (2 s
	// stall), only the edges seen; the press opens at the next poll
	b.edge(true, 1000000);
	b.edge(false, 1000000 + 500); // contact bounce on the way down
	b.edge(true, 1000000 + 900);
	b.edge(false, 1000000 + 200000); // let go 200 ms later, loop() still busy
	b.edge(true, 1000000 + 201000);	 // release bounce
	b.edge(false, 1000000 + 202000);
	CHECK(b.poll(false, 3000000));
	CHECK(!b.poll(false, 3000001)); // once
	// a press loop() saw (reported while held) is not reported again at the release
	b.poll(true, 4000000);
	CHECK(b.poll(true, 4000000 + D));
	b.edge(false, 4000000 + 300000);
	CHECK(!b.poll(false, 4000000 + 400000));
	// held down when set up (stuck button, wiring fault): not a press until
	// it is let go and pressed again, as with Bounce2
	core::ExitButton s;
	s.begin(true, 0);
	CHECK(!s.poll(true, 10 * D));
	s.edge(false, 20 * D);
	CHECK(!s.poll(false, 21 * D));
	s.edge(true, 30 * D);
	CHECK(s.poll(true, 31 * D));
}

// plan 1.9.1 B3: every software restart waits for idle, at most 30 s
static void testRestartGate()
{
	core::RestartGate g;
	CHECK(!g.wanted() && !g.due(1000, true)); // nothing asked: never
	g.ask(1000);
	CHECK(g.wanted() && g.askedAt() == 1000);
	CHECK(!g.due(1000, false) && !g.due(1000 + core::RestartGate::GRACE_MS - 1, false)); // busy: waits
	CHECK(g.due(1000 + core::RestartGate::GRACE_MS, false));                            // forced at 30 s
	CHECK(g.due(1001, true));                                                            // idle wins at once
	g.ask(20000);
	CHECK(g.askedAt() == 1000); // a second ask does not restart the wait
	CHECK(core::RestartGate::GRACE_MS == 30000);
	// 64-bit uptime: past the 32-bit wrap still right
	core::RestartGate w;
	w.ask(WRAP32 - 10);
	CHECK(!w.due(WRAP32 + 100, false) && w.due(WRAP32 - 10 + core::RestartGate::GRACE_MS, false));
}

static void testRelayBoot()
{
	// the levels stored at a settings save come from the NEW settings: a
	// Relay Type change used to be stored only after the restart, so that
	// boot drove the old locked level, now the unlocked one
	{
		core::Settings next;
		next.numRelays = 2;
		next.relayPin[0] = 16;
		next.relayPin[1] = 17;
		next.relayUnlock[0] = 0; // active low (rtype 0, rhold 0): locked is HIGH
		uint8_t packed[core::RELAY_BOOT_MAX * 2];
		size_t n = core::packRelayBoot(core::relayBankOf(next), packed);
		CHECK(n == 4 && packed[0] == 16 && packed[1] == 1 && packed[2] == 17 && packed[3] == 0);
	}
	int pin[4] = {16, 17, 255, 4}, type[4] = {1, 0, 1, 1}, lock[4] = {0, 1, 0, 0};
	unsigned long hold[4] = {400, 400, 400, 400};
	core::RelayBankView bank{pin, type, lock, hold, 4};
	uint8_t packed[core::RELAY_BOOT_MAX * 2];
	size_t len = core::packRelayBoot(bank, packed);
	CHECK(len == 6); // relay 3 has no pin
	core::RelayBootEntry e[core::RELAY_BOOT_MAX];
	size_t n = core::unpackRelayBoot(packed, len, core::pinSetEsp32(), e);
	CHECK(n == 3);
	CHECK(e[0].pin == 16 && e[0].idle == 0); // active high: locked = LOW
	CHECK(e[1].pin == 17 && e[1].idle == 1); // active low: locked = HIGH
	CHECK(e[2].pin == 4 && e[2].idle == 0);
	core::RelayBankView two{pin, type, lock, hold, 2};
	CHECK(core::packRelayBoot(two, packed) == 4); // only the configured relays
	// damaged or foreign data never drives a pin the chip cannot use
	uint8_t flashPin[] = {6, 0, 16, 0};
	CHECK(core::unpackRelayBoot(flashPin, 4, core::pinSetEsp32(), e) == 1 && e[0].pin == 16);
	uint8_t badLevel[] = {16, 7};
	CHECK(core::unpackRelayBoot(badLevel, 2, core::pinSetEsp32(), e) == 0);
	uint8_t odd[] = {16, 0, 17};
	CHECK(core::unpackRelayBoot(odd, 3, core::pinSetEsp32(), e) == 0);
	uint8_t inputOnly[] = {34, 0};
	CHECK(core::unpackRelayBoot(inputOnly, 2, core::pinSetEsp32(), e) == 0);
	CHECK(core::unpackRelayBoot(packed, 0, core::pinSetEsp32(), e) == 0);
}

// The exit buttons are attached at boot from NVS, so they open their doors
// even when config.json is damaged or refused.
static void testExitBoot()
{
	core::Settings s;
	s.numRelays = 3;
	s.relayPin[0] = 16;
	s.relayUnlock[0] = 0;
	s.lockType[0] = 0;
	s.activateTime[0] = 3000;
	s.exitPin[0] = 13;
	s.relayPin[1] = 17; // no exit button: not stored
	s.relayPin[2] = 18;
	s.lockType[2] = 1;
	s.activateTime[2] = 30000;
	s.exitPin[2] = 14;
	s.exitPin[3] = 4; // beyond numRelays: not stored
	uint8_t packed[core::RELAY_BOOT_MAX * core::EXIT_BOOT_ENTRY];
	size_t len = core::packExitBoot(core::relayBankOf(s), s.exitPin, packed);
	CHECK(len == 2 * core::EXIT_BOOT_ENTRY);
	core::ExitBootEntry e[core::RELAY_BOOT_MAX];
	CHECK(core::unpackExitBoot(packed, len, core::pinSetEsp32(), e) == 2);
	CHECK(e[0].door == 0 && e[0].exitPin == 13 && e[0].relayPin == 16 && e[0].activeLevel == 0 && e[0].lockType == 0 && e[0].holdMs == 3000);
	CHECK(e[1].door == 2 && e[1].exitPin == 14 && e[1].relayPin == 18 && e[1].activeLevel == 1 && e[1].lockType == 1 && e[1].holdMs == 30000);
	// an exit button with no relay has nothing to open
	core::Settings noRelay;
	noRelay.exitPin[0] = 13;
	CHECK(core::packExitBoot(core::relayBankOf(noRelay), noRelay.exitPin, packed) == 0);
	// damaged or foreign data is dropped entry by entry
	uint8_t good[] = {0, 13, 16, 1, 0, 0x90, 0x01}; // 400 ms
	CHECK(core::unpackExitBoot(good, 7, core::pinSetEsp32(), e) == 1 && e[0].holdMs == 400);
	uint8_t flash[] = {0, 6, 16, 1, 0, 0x90, 0x01, 1, 13, 7, 1, 0, 0x90, 0x01, 2, 14, 17, 1, 0, 0x90, 0x01};
	CHECK(core::unpackExitBoot(flash, sizeof(flash), core::pinSetEsp32(), e) == 1 && e[0].door == 2);
	uint8_t badLevel[] = {0, 13, 16, 2, 0, 0x90, 0x01};
	CHECK(core::unpackExitBoot(badLevel, 7, core::pinSetEsp32(), e) == 0);
	uint8_t badLock[] = {0, 13, 16, 1, 5, 0x90, 0x01};
	CHECK(core::unpackExitBoot(badLock, 7, core::pinSetEsp32(), e) == 0);
	uint8_t badHold[] = {0, 13, 16, 1, 0, 0x10, 0x00, 1, 14, 17, 1, 0, 0xff, 0xff};
	CHECK(core::unpackExitBoot(badHold, 14, core::pinSetEsp32(), e) == 0);
	uint8_t badDoor[] = {4, 13, 16, 1, 0, 0x90, 0x01};
	CHECK(core::unpackExitBoot(badDoor, 7, core::pinSetEsp32(), e) == 0);
	uint8_t samePin[] = {0, 16, 16, 1, 0, 0x90, 0x01};
	CHECK(core::unpackExitBoot(samePin, 7, core::pinSetEsp32(), e) == 0);
	uint8_t twice[] = {0, 13, 16, 1, 0, 0x90, 0x01, 0, 14, 17, 1, 0, 0x90, 0x01};
	CHECK(core::unpackExitBoot(twice, 14, core::pinSetEsp32(), e) == 1 && e[0].exitPin == 13);
	CHECK(core::unpackExitBoot(good, 6, core::pinSetEsp32(), e) == 0); // truncated
	CHECK(core::unpackExitBoot(good, 0, core::pinSetEsp32(), e) == 0);
}

static void testRelays()
{
	// a Config nobody has loaded yet drives no relay: every pin is 255
	static core::Settings fresh; // static: zero-filled storage, so a missing default reads 0
	CHECK(fresh.relayPin[0] == 255 && fresh.relayPin[1] == 255 && fresh.relayPin[2] == 255 && fresh.relayPin[3] == 255);

	int pin[4] = {255, 255, 255, 255}, type[4] = {1, 1, 1, 1}, lock[4] = {0, 0, 0, 0};
	unsigned long hold[4] = {3000, 3000, 3000, 3000};
	core::RelayBankView bank{pin, type, lock, hold, 2};
	core::RelayTimer timers[4];
	bool req[4] = {false, false, false, false};
	FakeRelayIo io;

	// Test (or a card) on unconfigured relays: no GPIO touched, request dropped
	CHECK(!core::relayHasPin(bank, 0) && !core::relayHasPin(bank, 1) && !core::relayHasPin(bank, 2));
	req[0] = req[1] = true;
	core::relayLoop(io, bank, req, timers, 1000);
	CHECK(io.ops.empty() && !req[0] && !req[1]);

	// relay 1 momentary on GPIO16, active high, 3000 ms
	pin[0] = 16;
	CHECK(core::relayHasPin(bank, 0) && !core::relayHasPin(bank, 4) && !core::relayHasPin(bank, -1));
	req[0] = true;
	core::relayLoop(io, bank, req, timers, 1000);
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 UNLOCKED" && io.ops[1] == "pulse 0 3000");
	io.ops.clear();
	core::relayLoop(io, bank, req, timers, 3999);
	CHECK(io.ops.empty());
	core::relayLoop(io, bank, req, timers, 4000);
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 LOCKED" && io.ops[1] == "write 16=0");
	io.ops.clear();
	core::relayLoop(io, bank, req, timers, 9000);
	CHECK(io.ops.empty()); // released once

	// relay 2 continuous, active low on GPIO17: each request toggles it
	pin[1] = 17;
	type[1] = 0;
	lock[1] = 1;
	io.level[17] = 1; // idle (off) for active low
	req[1] = true;
	core::relayLoop(io, bank, req, timers, 10000);
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 1 UNLOCKED" && io.ops[1] == "write 17=0");
	io.ops.clear();
	req[1] = true;
	core::relayLoop(io, bank, req, timers, 11000);
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 1 LOCKED" && io.ops[1] == "write 17=1");
	// a remote open (MQTT open/opendoor) and an exit button request only
	// locked relays: the held-open continuous relay would be toggled shut
	CHECK(core::relayLockedAt(bank, 1, 1) && !core::relayLockedAt(bank, 1, 0)); // active low
	CHECK(core::relayLockedAt(bank, 0, 0) && !core::relayLockedAt(bank, 0, 1)); // active high
	CHECK(!core::relayLockedAt(bank, 2, 0));                                    // outside the bank
	io.ops.clear();
	req[1] = true;
	core::relayLoop(io, bank, req, timers, 11500); // opened
	req[1] = core::relayLockedAt(bank, 1, io.read(17));
	core::relayLoop(io, bank, req, timers, 11600); // opendoor again: not requested
	CHECK(io.ops.size() == 2 && io.read(17) == 0); // still open
	io.write(17, 1); // relocked (MQTT close)
	// exit button, as door.esp: pressed twice, the second press (door held
	// open) leaves it open; up to 1.4.0 it toggled the door locked
	io.ops.clear();
	for (int press = 0; press < 2; press++)
	{
		if (core::relayLockedAt(bank, 1, io.read(17)))
			req[1] = true;
		core::relayLoop(io, bank, req, timers, 11700 + press);
	}
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 1 UNLOCKED" && io.read(17) == 0);
	io.write(17, 1);
	// a granted card, as rfid.esp: two cards, the second (door held open)
	// leaves it open; up to 1.7.0 it toggled the door locked (review 6 V3)
	io.ops.clear();
	for (int card = 0; card < 2; card++)
	{
		if (core::cardMayRequest(bank, 1, io.read(17)))
			req[1] = true;
		core::relayLoop(io, bank, req, timers, 11800 + card);
	}
	CHECK(io.ops.size() == 2 && io.ops[0] == "report 1 UNLOCKED" && io.read(17) == 0);
	CHECK(core::cardMayRequest(bank, 0, 0) && core::cardMayRequest(bank, 0, 1)); // momentary: whatever its level
	CHECK(!core::cardMayRequest(bank, 2, 0));                                    // outside the bank
	io.write(17, 1);
	// relays beyond numrelays are never touched
	pin[2] = 18;
	req[2] = true;
	io.ops.clear();
	core::relayLoop(io, bank, req, timers, 12000);
	CHECK(io.ops.empty() && req[2]); // outside the bank: left alone
}

// test/vectors/config-policy.json, also run against the simulator by run.mjs
static void setPath(JsonObject root, const std::string &path, JsonVariantConst value)
{
	JsonObject obj = root;
	size_t start = 0;
	for (;;)
	{
		size_t dot = path.find('.', start);
		std::string key = path.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
		if (dot == std::string::npos)
		{
			if (value.isNull())
				obj.remove(key);
			else
				obj[key].set(value);
			return;
		}
		JsonObject next = obj[key];
		if (next.isNull())
			next = obj.createNestedObject(key);
		obj = next;
		start = dot + 1;
	}
}

static std::string jsonAt(JsonVariantConst v, const std::string &path)
{
	size_t start = 0;
	while (!v.isNull())
	{
		size_t dot = path.find('.', start);
		v = v[path.substr(start, dot == std::string::npos ? std::string::npos : dot - start)];
		if (dot == std::string::npos)
			break;
		start = dot + 1;
	}
	std::string out;
	serializeJson(v, out);
	return out;
}

static void testConfigPolicyVectors()
{
	FILE *f = fopen("test/vectors/config-policy.json", "rb");
	CHECK(f != nullptr);
	if (!f)
		return;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	DynamicJsonDocument vec(65536);
	CHECK(!deserializeJson(vec, text));
	std::string base;
	serializeJson(vec["base"], base);
	int cases = 0;
	for (JsonObject c : vec["cases"].as<JsonArray>())
	{
		cases++;
		DynamicJsonDocument cfg(8192);
		deserializeJson(cfg, base);
		for (JsonPair kv : c["set"].as<JsonObject>())
			setPath(cfg.as<JsonObject>(), kv.key().c_str(), kv.value());
		std::string chip = c["chip"].as<std::string>();
		core::PolicyBoard board = chip == "esp32" ? core::policyBoardEsp32() : core::policyBoardEsp32s3();
		core::PolicyText text;
		// the vector's password in force, stored as the device stores it
		const char *password = c["password"] | "";
		char ha1[core::HA1_HEX + 1];
		core::adminHa1(password, ha1);
		bool mustChange = c.containsKey("mustchange") ? c["mustchange"].as<bool>() : core::needsPasswordChange(password);
		core::PolicyResult r = core::applyConfigPolicy(cfg.as<JsonObject>(), board, ha1, mustChange, text);
		const char *want = c["problem"];
		bool same = (want == nullptr && r.problem == nullptr) || (want && r.problem && strcmp(want, r.problem) == 0);
		if (!same)
			fprintf(stderr, "policy vector \"%s\": got %s\n", c["name"].as<const char *>(), r.problem ? r.problem : "accepted");
		CHECK(same);
		if (same && want == nullptr)
		{
			// whatever the policy saves must load
			core::Settings loaded;
			core::SettingsLoad load = core::parseSettings(cfg.as<JsonObjectConst>(), board, loaded);
			if (load.problem)
				fprintf(stderr, "policy vector \"%s\": saved but refused at load: %s\n", c["name"].as<const char *>(), load.problem);
			CHECK(load.problem == nullptr && loaded.present);
			for (JsonPair kv : c["expect"].as<JsonObject>())
			{
				std::string key = kv.key().c_str(), wantText, got;
				serializeJson(kv.value(), wantText);
				got = key == "warn" ? (r.ignoredPassword ? "true" : "false") : jsonAt(cfg.as<JsonVariantConst>(), key);
				if (got != wantText)
					fprintf(stderr, "policy vector \"%s\": %s = %s, want %s\n", c["name"].as<const char *>(), key.c_str(), got.c_str(), wantText.c_str());
				CHECK(got == wantText);
			}
		}
	}
	printf("config policy: %d shared vectors\n", cases);
	CHECK(cases >= 30);
}

// test/vectors/update-image-head.json: the /update head check, word for word
// as the simulator's (plan 1.9.1 E4)
static void testImageHeadVectors()
{
	FILE *f = fopen("test/vectors/update-image-head.json", "rb");
	CHECK(f != nullptr);
	if (!f)
		return;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	DynamicJsonDocument vec(16384);
	CHECK(!deserializeJson(vec, text));
	int cases = 0;
	for (JsonObject c : vec["cases"].as<JsonArray>())
	{
		cases++;
		std::vector<uint8_t> d((size_t)(c["len"] | 0), 0);
		for (JsonPair kv : c["set"].as<JsonObject>())
			d[(size_t)atoi(kv.key().c_str())] = (uint8_t)(kv.value().as<int>());
		uint16_t chip = strcmp(c["chip"] | "", "esp32") == 0 ? core::IMAGE_CHIP_ESP32 : core::IMAGE_CHIP_ESP32S3;
		const char *got = core::checkUpdateImageHead(d.data(), d.size(), chip);
		const char *want = c["want"].isNull() ? nullptr : (const char *)c["want"];
		bool same = (got == nullptr && want == nullptr) || (got != nullptr && want != nullptr && strcmp(got, want) == 0);
		if (!same)
			fprintf(stderr, "image head vector \"%s\": got %s\n", (const char *)(c["name"] | "?"), got ? got : "null");
		CHECK(same);
	}
	CHECK(cases >= 10);
}

// test/vectors/mqtt-updateconf.json: what MQTT remote admin cannot change
static void testRemoteAdminVectors()
{
	FILE *f = fopen("test/vectors/mqtt-updateconf.json", "rb");
	CHECK(f != nullptr);
	if (!f)
		return;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	DynamicJsonDocument vec(65536);
	CHECK(!deserializeJson(vec, text));
	std::string storedText;
	serializeJson(vec["stored"], storedText);
	DynamicJsonDocument stored(8192);
	CHECK(!deserializeJson(stored, storedText));
	int cases = 0;
	for (JsonObject c : vec["cases"].as<JsonArray>())
	{
		cases++;
		const char *name = c["name"];
		DynamicJsonDocument cfg(8192);
		deserializeJson(cfg, storedText);
		for (JsonPair kv : c["set"].as<JsonObject>())
			setPath(cfg.as<JsonObject>(), kv.key().c_str(), kv.value());
		std::vector<std::string> ignored;
		core::keepRemoteAdminKept(cfg.as<JsonObject>(), stored.as<JsonObjectConst>(), ignored);
		CHECK(!cfg.overflowed());
		std::set<std::string> got(ignored.begin(), ignored.end()), want;
		for (const char *k : c["ignored"].as<JsonArrayConst>())
			want.insert(k);
		if (got != want || got.size() != ignored.size())
		{
			std::string g;
			for (const std::string &k : ignored)
				g += k + " ";
			fprintf(stderr, "updateconf vector \"%s\": ignored %s\n", name, g.c_str());
		}
		CHECK(got == want && got.size() == ignored.size()); // no key named twice
		for (JsonPair kv : c["expect"].as<JsonObject>())
		{
			std::string wantText, value = jsonAt(cfg.as<JsonVariantConst>(), kv.key().c_str());
			serializeJson(kv.value(), wantText);
			if (value != wantText)
				fprintf(stderr, "updateconf vector \"%s\": %s = %s, want %s\n", name, kv.key().c_str(), value.c_str(), wantText.c_str());
			CHECK(value == wantText);
		}
		// every protected key holds exactly its stored value afterwards
		for (const char *path : core::REMOTE_ADMIN_KEPT)
		{
			bool same = jsonAt(cfg.as<JsonVariantConst>(), path) == jsonAt(stored.as<JsonVariantConst>(), path);
			if (!same)
				fprintf(stderr, "updateconf vector \"%s\": %s not the stored value\n", name, path);
			CHECK(same);
		}
		// and the result is settings the device accepts
		core::PolicyText ptext;
		core::PolicyResult r = core::applyConfigPolicy(cfg.as<JsonObject>(), core::policyBoardEsp32(), stored["general"]["pswd"], false, ptext);
		if (r.problem)
			fprintf(stderr, "updateconf vector \"%s\": refused by the policy: %s\n", name, r.problem);
		CHECK(r.problem == nullptr);
		// merging again changes nothing and names nothing
		std::string once;
		serializeJson(cfg, once);
		std::vector<std::string> again;
		core::keepRemoteAdminKept(cfg.as<JsonObject>(), stored.as<JsonObjectConst>(), again);
		std::string twice;
		serializeJson(cfg, twice);
		CHECK(again.empty() && once == twice);
	}
	printf("mqtt updateconf: %d vectors\n", cases);
	CHECK(cases >= 20);

	// nothing stored: every protected key is dropped (so updateconf refuses
	// without the stored settings rather than calling this)
	DynamicJsonDocument cfg(8192);
	deserializeJson(cfg, storedText);
	std::vector<std::string> ignored;
	core::keepRemoteAdminKept(cfg.as<JsonObject>(), JsonObjectConst(), ignored);
	CHECK(!cfg.containsKey("network") && !cfg["mqtt"].containsKey("host") && cfg["mqtt"]["syncrate"] == 180 && !ignored.empty());

	// adduser over MQTT: no admin cards (access 99) on any door
	DynamicJsonDocument rec(512);
	deserializeJson(rec, "{\"uid\":\"04a1b2c3\",\"acctype\":1,\"acctype2\":0,\"acctype3\":0,\"acctype4\":0}");
	CHECK(!core::isAdminRecord(rec.as<JsonObjectConst>()));
	for (const char *key : {"acctype", "acctype2", "acctype3", "acctype4"})
	{
		DynamicJsonDocument admin(512);
		deserializeJson(admin, "{\"uid\":\"04a1b2c3\",\"acctype\":1}");
		admin[key] = 99;
		CHECK(core::isAdminRecord(admin.as<JsonObjectConst>()));
	}
	// as checkUserRecord stores it, from text too
	DynamicJsonDocument in(512), out(512);
	deserializeJson(in, "{\"uid\":\"04A1B2C3\",\"user\":\"x\",\"acctype\":\"99\",\"validuntil\":1900000000}");
	CHECK(core::checkUserRecord(in.as<JsonObjectConst>(), out.to<JsonObject>()) == nullptr && core::isAdminRecord(out.as<JsonObjectConst>()));
}

// test/vectors/user-records.json, also run against the simulator by run.mjs
static void testUserRecordVectors()
{
	FILE *f = fopen("test/vectors/user-records.json", "rb");
	CHECK(f != nullptr);
	if (!f)
		return;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	DynamicJsonDocument vec(32768);
	CHECK(!deserializeJson(vec, text));
	int cases = 0;
	for (JsonObject c : vec["cases"].as<JsonArray>())
	{
		cases++;
		DynamicJsonDocument in(2048), out(1024);
		in.set(vec["base"]);
		for (JsonPair kv : c["set"].as<JsonObject>())
		{
			if (kv.value().isNull())
				in.remove(kv.key().c_str());
			else
				in[kv.key().c_str()] = kv.value();
		}
		const char *got = core::checkUserRecord(in.as<JsonObjectConst>(), out.to<JsonObject>());
		const char *want = c["problem"];
		bool same = (want == nullptr && got == nullptr) || (want && got && strcmp(want, got) == 0);
		if (!same)
			fprintf(stderr, "user vector \"%s\": got %s\n", c["name"].as<const char *>(), got ? got : "accepted");
		CHECK(same);
		if (same && want == nullptr)
		{
			std::string stored, wantStored;
			serializeJson(out, stored);
			serializeJson(c["stored"], wantStored);
			if (stored != wantStored)
				fprintf(stderr, "user vector \"%s\": stored %s, want %s\n", c["name"].as<const char *>(), stored.c_str(), wantStored.c_str());
			CHECK(stored == wantStored);
		}
	}
	printf("user records: %d shared vectors\n", cases);
	CHECK(cases >= 25);
}

static core::SettingsLoad loadJson(const char *json, core::Settings &out, core::PolicyBoard board = core::policyBoardEsp32())
{
	DynamicJsonDocument doc(8192);
	CHECK(!deserializeJson(doc, json));
	return core::parseSettings(doc.as<JsonObjectConst>(), board, out);
}

// "When the relay is on, the door is" (hardware.rhold): every combination of
// relay type and rhold gives the level that unlocks (relayUnlock), and the
// relay loop, the NVS boot copies and the lock-state read all use it.
static void testRelayHold()
{
	std::string hours = "\"openinghours\":[";
	for (int d = 0; d < 7; d++)
		hours += std::string(d ? "," : "") + "\"111111111111111111111111\"";
	hours += "]";
	auto json = [&](const std::string &relay1) {
		return "{\"network\":{\"wmode\":0},\"hardware\":{\"readertype\":1,\"wgd0pin\":34,\"wgd1pin\":35,\"numrelays\":2,\"rpin\":16,\"openlockpin\":13," + relay1 +
			   ",\"relay2\":{\"rpin\":17,\"rtype\":1,\"ltype\":0,\"rtime\":3000,\"openlockpin\":4}},\"general\":{" + hours + "}}";
	};
	static core::Settings s;
	for (int rtype = 0; rtype < 2; rtype++)
		for (int rhold = 0; rhold < 2; rhold++)
		{
			std::string relay1 = "\"rtype\":" + std::to_string(rtype) + ",\"rhold\":" + std::to_string(rhold) + ",\"ltype\":0,\"rtime\":3000";
			core::SettingsLoad l = loadJson(json(relay1).c_str(), s);
			CHECK(l.problem == nullptr && l.warnings.empty());
			int unlock = rtype ^ rhold, locked = 1 - unlock;
			CHECK(s.relayHold[0] == rhold && s.relayUnlock[0] == unlock);
			// relay 2 stored without rhold: relay on = unlocked, as before 1.7
			CHECK(s.relayHold[1] == 0 && s.relayUnlock[1] == 1);
			core::RelayBankView b = core::relayBankOf(s);
			CHECK(b.activeLevel[0] == unlock);
			// the boot copy stores the locked level (no format change)
			uint8_t packed[core::RELAY_BOOT_MAX * core::EXIT_BOOT_ENTRY];
			size_t n = core::packRelayBoot(b, packed);
			CHECK(n == 4 && packed[0] == 16 && packed[1] == locked && packed[2] == 17 && packed[3] == 0);
			n = core::packExitBoot(b, s.exitPin, packed);
			core::ExitBootEntry e[core::RELAY_BOOT_MAX];
			CHECK(core::unpackExitBoot(packed, n, core::pinSetEsp32(), e) == 2 && e[0].activeLevel == unlock && e[1].activeLevel == 1);
			// the lock state (door.esp tamper, mqtt.esp relayLockedNow)
			CHECK(core::relayLockedAt(b, 0, locked) && !core::relayLockedAt(b, 0, unlock));
			// a card: unlocks for the unlock time, then back to the locked level
			core::RelayTimer timers[MAX_NUM_RELAYS];
			bool req[MAX_NUM_RELAYS] = {true, false, false, false};
			FakeRelayIo io;
			io.level[16] = locked;
			core::relayLoop(io, b, req, timers, 1000);
			CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 UNLOCKED" && io.ops[1] == "pulse 0 3000");
			io.ops.clear();
			core::relayLoop(io, b, req, timers, 4000);
			CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 LOCKED" && io.ops[1] == "write 16=" + std::to_string(locked));
		}
	// the maglock on NO on the VOANZO board (active high): HIGH while locked,
	// the relay on; a continuous lock toggles to LOW (released) and back
	CHECK(loadJson(json("\"rtype\":1,\"rhold\":\"1\",\"ltype\":1,\"rtime\":3000").c_str(), s).problem == nullptr);
	CHECK(s.relayHold[0] == 1 && s.relayUnlock[0] == 0);
	{
		core::RelayBankView b = core::relayBankOf(s);
		core::RelayTimer timers[MAX_NUM_RELAYS];
		bool req[MAX_NUM_RELAYS] = {true, false, false, false};
		FakeRelayIo io;
		io.level[16] = 1; // locked: relay on
		core::relayLoop(io, b, req, timers, 1000);
		CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 UNLOCKED" && io.ops[1] == "write 16=0");
		io.ops.clear();
		req[0] = true;
		core::relayLoop(io, b, req, timers, 2000);
		CHECK(io.ops.size() == 2 && io.ops[0] == "report 0 LOCKED" && io.ops[1] == "write 16=1");
	}
	// out of range (hand-edited): unlocked when on, with a warning
	core::SettingsLoad l = loadJson(json("\"rtype\":1,\"rhold\":2,\"ltype\":0,\"rtime\":3000").c_str(), s);
	CHECK(l.problem == nullptr && l.warnings.size() == 1 && l.warnings[0].find("rhold out of range") != std::string::npos);
	CHECK(s.relayHold[0] == 0 && s.relayUnlock[0] == 1);
	// a fresh Settings: unlocked when on
	static core::Settings fresh;
	fresh = core::Settings();
	CHECK(fresh.relayHold[0] == 0 && fresh.relayUnlock[0] == 1 && fresh.relayUnlock[3] == 1);
}

// The RTC's registers (core/rtc.h): BCD, both chips' layouts, the "lost the
// time" flags, UTC epoch both ways.
static void testRtc()
{
	CHECK(core::bcdToBin(0x59) == 59 && core::binToBcd(59) == 0x59 && core::bcdToBin(0x00) == 0 && core::binToBcd(7) == 0x07);
	CHECK(core::rtcTypeFrom(1) == core::RTC_DS3231 && core::rtcTypeFrom(2) == core::RTC_DS1307 && core::rtcTypeFrom(3) == core::RTC_NONE && core::rtcTypeFrom(-1) == core::RTC_NONE);
	// 2026-10-16 19:40:05 UTC, a Friday (weekday 6 counting Sunday as 1)
	core::RtcTime t = core::rtcFromEpoch(1792179605UL);
	CHECK(t.year == 2026 && t.month == 10 && t.day == 16 && t.hour == 19 && t.minute == 40 && t.second == 5);
	CHECK(core::rtcToEpoch(t) == 1792179605UL && core::rtcTimeValid(t));
	uint8_t r[7];
	core::rtcEncode(t, r);
	CHECK(r[0] == 0x05 && r[1] == 0x40 && r[2] == 0x19 && r[3] == 6 && r[4] == 0x16 && r[5] == 0x10 && r[6] == 0x26);
	core::RtcTime back = core::rtcDecode(r);
	CHECK(core::rtcToEpoch(back) == 1792179605UL);
	// round trips: the first trusted second, a leap day, the last second of 2099, 2100 (century bit)
	for (uint32_t e : {1451606400UL, 1709251199UL, 4102444799UL, 4107542400UL})
	{
		core::RtcTime x = core::rtcFromEpoch(e);
		core::rtcEncode(x, r);
		CHECK(core::rtcToEpoch(core::rtcDecode(r)) == e);
	}
	core::rtcEncode(core::rtcFromEpoch(1709251199UL), r); // 2024-02-29 23:59:59
	CHECK(r[4] == 0x29 && r[5] == 0x02 && r[3] == 5);
	core::rtcEncode(core::rtcFromEpoch(4107542400UL), r); // 2100-03-01
	CHECK(r[5] == (0x03 | core::DS3231_CENTURY) && r[6] == 0x00);
	CHECK(!core::rtcTimeValid(core::rtcFromEpoch(4107542400UL))); // past 2099: not trusted
	// 12-hour mode (set by another program): 07:30:00 PM
	uint8_t pm[7] = {0x00, 0x30, 0x40 | 0x20 | 0x07, 6, 0x16, 0x10, 0x26};
	CHECK(core::rtcDecode(pm).hour == 19);
	uint8_t midnight[7] = {0x00, 0x00, 0x40 | 0x12, 6, 0x16, 0x10, 0x26}; // 12 AM
	CHECK(core::rtcDecode(midnight).hour == 0);
	uint8_t noon[7] = {0x00, 0x00, 0x40 | 0x20 | 0x12, 6, 0x16, 0x10, 0x26}; // 12 PM
	CHECK(core::rtcDecode(noon).hour == 12);
	// the DS1307's clock-halt bit is not part of the seconds, and means the time was lost
	uint8_t halted[7] = {0x80 | 0x25, 0x40, 0x19, 6, 0x16, 0x10, 0x26};
	CHECK(core::rtcDecode(halted).second == 25 && core::rtcStopped(core::RTC_DS1307, halted, 0));
	CHECK(!core::rtcStopped(core::RTC_DS1307, r, 0x80)); // the DS3231 status register means nothing to a DS1307
	// the DS3231's oscillator-stop flag
	CHECK(core::rtcStopped(core::RTC_DS3231, r, core::DS3231_STATUS_OSF) && !core::rtcStopped(core::RTC_DS3231, halted, 0x00));
	// a chip that lost its battery restarts at 2000-01-01: not valid
	uint8_t reset[7] = {0x00, 0x00, 0x00, 1, 0x01, 0x01, 0x00};
	CHECK(!core::rtcTimeValid(core::rtcDecode(reset)));
	uint8_t badDay[7] = {0x00, 0x00, 0x00, 1, 0x31, 0x02, 0x26}; // 31 February
	CHECK(!core::rtcTimeValid(core::rtcDecode(badDay)));
	uint8_t badHour[7] = {0x00, 0x00, 0x25, 1, 0x01, 0x02, 0x26}; // 25:00
	CHECK(!core::rtcTimeValid(core::rtcDecode(badHour)));

	// the settings: ntp.rtc, read at start; pins default to GPIO21/22
	std::string hours = "\"openinghours\":[";
	for (int d = 0; d < 7; d++)
		hours += std::string(d ? "," : "") + "\"111111111111111111111111\"";
	hours += "]";
	auto json = [&](const std::string &rtc) {
		return "{\"network\":{\"wmode\":0},\"hardware\":{\"readertype\":1,\"wgd0pin\":34,\"wgd1pin\":35,\"rpin\":16},\"general\":{" + hours + "},\"ntp\":{\"server\":\"pool.ntp.org\"" + rtc + "}}";
	};
	static core::Settings s;
	CHECK(loadJson(json("").c_str(), s).problem == nullptr && s.rtcType == core::RTC_NONE);
	core::SettingsLoad l = loadJson(json(",\"rtc\":{\"type\":1,\"sdapin\":21,\"sclpin\":22}").c_str(), s);
	CHECK(l.problem == nullptr && l.warnings.empty() && s.rtcType == core::RTC_DS3231 && s.rtcSda == 21 && s.rtcScl == 22);
	CHECK(loadJson(json(",\"rtc\":{\"type\":2,\"sdapin\":18,\"sclpin\":19}").c_str(), s).problem == nullptr && s.rtcType == core::RTC_DS1307 && s.rtcSda == 18 && s.rtcScl == 19);
	CHECK(loadJson(json(",\"rtc\":{\"type\":1}").c_str(), s).problem == nullptr && s.rtcSda == 21 && s.rtcScl == 22);
	// an RTC pin on the relay's: refused at load like any other clash
	l = loadJson(json(",\"rtc\":{\"type\":1,\"sdapin\":16,\"sclpin\":22}").c_str(), s);
	CHECK(l.problem != nullptr && !l.warnings.empty() && l.warnings[0] == "GPIO 16 is used twice: Relay 1 and RTC SDA");
	// pins of an RTC that is off are not checked
	CHECK(loadJson(json(",\"rtc\":{\"type\":0,\"sdapin\":16,\"sclpin\":16}").c_str(), s).problem == nullptr && s.rtcType == core::RTC_NONE);
	// out of range: no RTC, a warning
	l = loadJson(json(",\"rtc\":{\"type\":7}").c_str(), s);
	CHECK(l.problem == nullptr && s.rtcType == core::RTC_NONE && l.warnings.size() == 1 && l.warnings[0].find("RTC type") == 0);
	l = loadJson(json(",\"rtc\":{\"type\":1,\"sdapin\":255,\"sclpin\":22}").c_str(), s);
	CHECK(l.problem == nullptr && s.rtcType == core::RTC_NONE && l.warnings.size() == 1);
}

static void testSettings()
{
	static const char *HOURS = "\"openinghours\":[\"111111111111111111111111\",\"111111111111111111111111\",\"111111111111111111111111\",\"111111111111111111111111\",\"111111111111111111111111\",\"111111111111111111111111\",\"000000000000111111111111\"]";
	core::Settings c;
	// the VOANZO two-door preset, as the UI saves it
	std::string voanzo = std::string("{\"network\":{\"wmode\":1,\"ssid\":\"IRONFRAME-RFID\",\"pswd\":\"\",\"apip\":\"192.168.4.1\",\"apsubnet\":\"255.255.255.0\",\"fallbackmode\":\"1\",\"offtime\":0},"
		"\"hardware\":{\"readertype\":1,\"wgd0pin\":34,\"wgd1pin\":35,\"rpin\":16,\"rtime\":5000,\"rtype\":1,\"ltype\":0,\"numrelays\":2,\"doorname\":\"Front\","
		"\"relay2\":{\"rpin\":\"17\",\"rtime\":3000,\"rtype\":1,\"ltype\":0,\"doorname\":\"Back\",\"doorstatpin\":21,\"openlockpin\":22},\"requirepincodeafterrfid\":true,\"allowpincodeonly\":1,"
		"\"useridstoragemode\":\"decimal\",\"reader1\":{\"door\":0,\"ledpin\":25,\"beeperpin\":26,\"feedbackactivehigh\":1},"
		"\"reader2\":{\"enabled\":1,\"wgd0pin\":32,\"wgd1pin\":33,\"door\":1,\"ledpin\":27,\"beeperpin\":14,\"feedbackactivehigh\":0},\"wifipin\":23},"
		"\"general\":{\"pswd\":\"Site-Door-2026\",\"hostnm\":\"\",\"restart\":2592000,\"logging\":0,") + HOURS + "},"
		"\"ntp\":{\"server\":\"\",\"interval\":30,\"timezone\":1}}";
	core::SettingsLoad l = loadJson(voanzo.c_str(), c);
	CHECK(l.problem == nullptr && l.warnings.empty() && c.present);
	// WiFi Timeout (network.offtime, until 1.7) becomes idle-off: 0 = unticked, 15 min
	CHECK(l.wifiTimeoutMigrated && l.migratedOfftime == 0 && !c.wifiIdleOff && c.wifiIdleMinutes == 15);
	{
		auto net = [&](const char *to) {
			std::string s = voanzo;
			s.replace(s.find("\"offtime\":0"), strlen("\"offtime\":0"), to);
			return s;
		};
		core::Settings d;
		core::SettingsLoad dl = loadJson(net("\"offtime\":600").c_str(), d);
		CHECK(dl.problem == nullptr && dl.warnings.empty() && dl.wifiTimeoutMigrated && dl.migratedOfftime == 600 && d.wifiIdleOff && d.wifiIdleMinutes == 10);
		dl = loadJson(net("\"offtime\":90").c_str(), d);
		CHECK(dl.wifiTimeoutMigrated && d.wifiIdleOff && d.wifiIdleMinutes == 2); // rounded up: never sooner than before
		// the rewrite (config.esp): the new keys load the same and are not migrated again
		DynamicJsonDocument doc(8192);
		CHECK(!deserializeJson(doc, net("\"offtime\":600")));
		core::Settings m, r;
		CHECK(core::parseSettings(doc.as<JsonObjectConst>(), core::policyBoardEsp32(), m).wifiTimeoutMigrated);
		core::putWifiIdle(doc["network"].as<JsonObject>(), m);
		CHECK(!doc["network"].containsKey("offtime") && doc["network"]["idleoff"] == 1 && doc["network"]["idlemins"] == 10);
		core::SettingsLoad rl = core::parseSettings(doc.as<JsonObjectConst>(), core::policyBoardEsp32(), r);
		CHECK(rl.problem == nullptr && !rl.wifiTimeoutMigrated && r.wifiIdleOff && r.wifiIdleMinutes == 10);
		// a file with the new keys: they win over a leftover offtime
		dl = loadJson(net("\"offtime\":600,\"idleoff\":0,\"idlemins\":30").c_str(), d);
		CHECK(!dl.wifiTimeoutMigrated && !d.wifiIdleOff && d.wifiIdleMinutes == 30);
		dl = loadJson(net("\"idleoff\":1,\"idlemins\":\"45\"").c_str(), d);
		CHECK(dl.warnings.empty() && !dl.wifiTimeoutMigrated && d.wifiIdleOff && d.wifiIdleMinutes == 45);
		// neither key (a hand-written file): unticked, 15 min, nothing to rewrite
		dl = loadJson(net("\"hide\":0").c_str(), d);
		CHECK(dl.problem == nullptr && !dl.wifiTimeoutMigrated && !d.wifiIdleOff && d.wifiIdleMinutes == 15);
		// out of range (hand-edited): 15 with a warning, not a refusal
		dl = loadJson(net("\"idleoff\":1,\"idlemins\":0").c_str(), d);
		CHECK(dl.problem == nullptr && dl.warnings.size() == 1 && d.wifiIdleOff && d.wifiIdleMinutes == 15);
	}
	CHECK(c.readertype == READER_WIEGAND && c.readers[0].d0 == 34 && c.readers[0].d1 == 35 && c.readers[0].door == 0);
	CHECK(c.readers[0].ledPin == 25 && c.readers[0].beeperPin == 26 && c.readers[0].feedbackActiveHigh);
	CHECK(c.readers[1].d0 == 32 && c.readers[1].d1 == 33 && c.readers[1].door == 1 && !c.readers[1].feedbackActiveHigh);
	CHECK(!c.readers[0].enabled && !c.readers[1].enabled); // the firmware sets these once the readers run
	CHECK(c.readers[0].direction == core::READER_DIR_NONE && c.readers[1].direction == core::READER_DIR_NONE); // not set: no direction

	// one door with a reader each side: both readers open door 1, one In, one Out
	{
		std::string inout = voanzo;
		inout.replace(inout.find("\"reader1\":{\"door\":0,"), strlen("\"reader1\":{\"door\":0,"), "\"reader1\":{\"door\":0,\"direction\":1,");
		inout.replace(inout.find("\"door\":1,\"ledpin\":27"), strlen("\"door\":1,\"ledpin\":27"), "\"door\":0,\"direction\":2,\"ledpin\":27");
		core::Settings d;
		core::SettingsLoad dl = loadJson(inout.c_str(), d);
		CHECK(dl.problem == nullptr && dl.warnings.empty());
		CHECK(d.readers[0].door == 0 && d.readers[1].door == 0);
		CHECK(d.readers[0].direction == core::READER_DIR_IN && d.readers[1].direction == core::READER_DIR_OUT);
		CHECK(strcmp(core::readerDirName(d.readers[0].direction), "in") == 0 && strcmp(core::readerDirName(d.readers[1].direction), "out") == 0);
		CHECK(core::readerDirName(core::READER_DIR_NONE) == nullptr);
		// an unknown value is no direction, not a refusal
		std::string bad = inout;
		bad.replace(bad.find("\"direction\":2"), strlen("\"direction\":2"), "\"direction\":7");
		core::Settings b;
		CHECK(loadJson(bad.c_str(), b).problem == nullptr && b.readers[1].direction == core::READER_DIR_NONE && b.readers[0].direction == core::READER_DIR_IN);
	}
	// a reader set to a door that does not exist: unbound (-2) with a
	// warning naming it (plan 1.9.1 C3), not silently "Disabled"
	{
		std::string far = voanzo;
		far.replace(far.find("\"door\":1,\"ledpin\":27"), strlen("\"door\":1,\"ledpin\":27"), "\"door\":3,\"ledpin\":27");
		core::Settings d;
		core::SettingsLoad dl = loadJson(far.c_str(), d);
		CHECK(dl.problem == nullptr && d.readers[1].door == -2 && d.readers[0].door == 0);
		CHECK(dl.warnings.size() == 1 && dl.warnings[0].find("Reader 2 is set to door 4, which does not exist (2 doors)") == 0);
	}
	// reader 1 without a door: door 1 with two doors; a stored -1 is kept; one door: -1
	{
		std::string nodoor = voanzo;
		nodoor.replace(nodoor.find("\"reader1\":{\"door\":0,"), strlen("\"reader1\":{\"door\":0,"), "\"reader1\":{");
		core::Settings d;
		CHECK(loadJson(nodoor.c_str(), d).problem == nullptr && d.readers[0].door == 0);
		std::string noreader = voanzo;
		noreader.replace(noreader.find("\"reader1\":{\"door\":0,\"ledpin\":25,\"beeperpin\":26,\"feedbackactivehigh\":1},"), strlen("\"reader1\":{\"door\":0,\"ledpin\":25,\"beeperpin\":26,\"feedbackactivehigh\":1},"), "");
		core::Settings e;
		CHECK(loadJson(noreader.c_str(), e).problem == nullptr && e.readers[0].door == 0);
		std::string every = voanzo;
		every.replace(every.find("\"reader1\":{\"door\":0,"), strlen("\"reader1\":{\"door\":0,"), "\"reader1\":{\"door\":-1,");
		core::Settings f;
		CHECK(loadJson(every.c_str(), f).problem == nullptr && f.readers[0].door == -1);
		std::string one = nodoor;
		one.replace(one.find("\"numrelays\":2"), strlen("\"numrelays\":2"), "\"numrelays\":1");
		one.replace(one.find("\"enabled\":1,\"wgd0pin\":32"), strlen("\"enabled\":1,\"wgd0pin\":32"), "\"enabled\":0,\"wgd0pin\":32");
		core::Settings g;
		CHECK(loadJson(one.c_str(), g).problem == nullptr);
		CHECK(g.numRelays == 1 && g.readers[0].door == -1);
	}
	CHECK(c.pinCodeRequested && c.pinCodeOnly && !c.wiegandReadHex && c.removeParityBits);
	CHECK(c.numRelays == 2 && c.relayPin[0] == 16 && c.relayPin[1] == 17); // relay 2 pin saved as a string
	CHECK(c.activateTime[0] == 5000 && c.activateTime[1] == 3000);
	CHECK(strcmp(c.doorName[0], "Front") == 0 && strcmp(c.doorName[1], "Back") == 0);
	CHECK(c.accessPointMode && strcmp(c.ssid, "IRONFRAME-RFID") == 0 && c.wifiPassword[0] == '\0' && c.fallbackMode);
	CHECK(c.accessPointIp.b[0] == 192 && c.accessPointIp.b[3] == 1 && c.accessPointSubnetIp.b[0] == 255);
	CHECK(c.wifipin == 23 && c.doorPin[0] == 255 && c.exitPin[0] == 255);
	CHECK(c.doorPin[1] == 21 && c.exitPin[1] == 22); // door 2's own contact and exit button
	CHECK(strcmp(c.adminHa1, "55660a03a22f4e179a972642deb67353") == 0 && !c.adminMustChange); // stored in clear: its hash
	CHECK(strcmp(c.deviceHostname, "ironframe-rfid") == 0); // empty: the default name
	CHECK(c.autoRestartIntervalSeconds == 2592000 && !c.loggingEnabled);
	CHECK(strcmp(c.openingHours[6], "000000000000111111111111") == 0);
	CHECK(strcmp(c.ntpServer, "pool.ntp.org") == 0 && c.ntpInterval == 30);
	// ntp.interval is used (it was stored only): minutes to ms, 15 s at least, 7 days at most, 0 = SDK default
	CHECK(core::ntpSyncIntervalMs(c.ntpInterval) == 1800000UL);
	CHECK(core::ntpSyncIntervalMs(0) == 0 && core::ntpSyncIntervalMs(-5) == 0);
	CHECK(core::ntpSyncIntervalMs(1) == 60000UL && core::ntpSyncIntervalMs(10080) == 604800000UL && core::ntpSyncIntervalMs(99999) == 604800000UL);
	CHECK(strcmp(c.tzInfo, "UTC-1.00") == 0); // upstream's numeric offset, POSIX sign
	CHECK(!c.mqttEnabled);

	// the same file with a refusal in it: nothing is half-loaded
	core::Settings r;
	std::string apEmpty = voanzo;
	apEmpty.replace(apEmpty.find("\"ssid\":\"IRONFRAME-RFID\""), strlen("\"ssid\":\"IRONFRAME-RFID\""), "\"ssid\":\"\"");
	CHECK(loadJson(apEmpty.c_str(), r).problem != nullptr && !r.present);
	std::string flashPin = voanzo;
	flashPin.replace(flashPin.find("\"rpin\":16"), strlen("\"rpin\":16"), "\"rpin\":6");
	l = loadJson(flashPin.c_str(), r);
	CHECK(l.problem != nullptr && strstr(l.problem, "GPIO") != nullptr && !l.warnings.empty());
	std::string sixDays = voanzo;
	sixDays.replace(sixDays.find(",\"000000000000111111111111\""), strlen(",\"000000000000111111111111\""), "");
	CHECK(loadJson(sixDays.c_str(), r).problem != nullptr);
	std::string twicePin = voanzo;
	twicePin.replace(twicePin.find("\"wifipin\":23"), strlen("\"wifipin\":23"), "\"wifipin\":16");
	CHECK(loadJson(twicePin.c_str(), r).problem != nullptr);

	// relay and lock types outside 0/1 (hand-edited, or saved before the
	// policy checked them): loaded with a warning as active high / momentary
	{
		std::string badTypes = voanzo;
		badTypes.replace(badTypes.find("\"rtype\":1,\"ltype\":0,\"numrelays\""), strlen("\"rtype\":1,\"ltype\":0,\"numrelays\""), "\"rtype\":2,\"ltype\":0,\"numrelays\"");
		badTypes.replace(badTypes.find("\"rtype\":1,\"ltype\":0,\"doorname\":\"Back\""), strlen("\"rtype\":1,\"ltype\":0,\"doorname\":\"Back\""), "\"rtype\":0,\"ltype\":7,\"doorname\":\"Back\"");
		core::Settings t;
		core::SettingsLoad tl = loadJson(badTypes.c_str(), t);
		CHECK(tl.problem == nullptr && tl.warnings.size() == 2);
		CHECK(t.relayUnlock[0] == 1 && t.lockType[0] == LOCKTYPE_MOMENTARY);
		CHECK(t.relayUnlock[1] == 0 && t.lockType[1] == LOCKTYPE_MOMENTARY);
		CHECK(tl.warnings.size() == 2 && tl.warnings[0].find("Relay type") == 0 && tl.warnings[1].find("Lock type") == 0);
	}

	// legacy and odd values
	std::string legacy = std::string("{\"network\":{\"wmode\":0,\"ssid\":\"site-wifi\",\"pswd\":\"secret-wifi\",\"dhcp\":0,\"ip\":\"10.0.0.9\",\"subnet\":\"255.255.255.0\",\"gateway\":\"10.0.0.1\",\"dns\":\"10.0.0.1\",\"bssid\":\"aa:bb:cc:01:02:03\"},"
		"\"hardware\":{\"readertype\":0,\"sspin\":21,\"rpin\":16,\"rtime\":-5,\"numrelays\":9},"
		"\"general\":{\"hostnm\":\"a-very-long-host-name-that-is-longer-than-thirty-two\",") + HOURS + "},"
		"\"ntp\":{\"timezone\":-5,\"tzinfo\":\"CET-1CEST,M3.5.0,M10.5.0/3\"},"
		"\"mqtt\":{\"enabled\":1,\"host\":\"192.168.1.60\",\"port\":\"1884\",\"user\":\"door\",\"pswd\":\"mqtt-secret\",\"topic\":\"ironframe\",\"syncrate\":60,\"mqttha\":1,\"remoteadmin\":0}}";
	l = loadJson(legacy.c_str(), c);
	CHECK(l.problem == nullptr && l.warnings.size() == 2); // the clamped relay time, the reader type
	CHECK(c.activateTime[0] == 100 && c.numRelays == 4); // clamped
	// an MFRC522 (gone since 2026-10-16) loads with reader 1 off and a warning, never a refusal
	CHECK(c.readertype == READER_NONE && std::any_of(l.warnings.begin(), l.warnings.end(), [](const std::string &w) { return w.find("Reader 1 type 0 is no longer supported") == 0; }));
	CHECK(!c.dhcpEnabled && c.ipAddress.b[0] == 10 && c.ipAddress.b[3] == 9 && c.gatewayIp.b[3] == 1);
	CHECK(c.bssid[0] == 0xaa && c.bssid[5] == 0x03);
	CHECK(strcmp(c.adminHa1, core::FACTORY_ADMIN_HA1) == 0 && c.adminMustChange && !l.passwordMigrated); // no password stored yet
	CHECK(strlen(c.deviceHostname) == 32); // display text is cut, not refused
	CHECK(strcmp(c.tzInfo, "CET-1CEST,M3.5.0,M10.5.0/3") == 0); // tzinfo wins over the old offset
	CHECK(c.mqttEnabled && strcmp(c.mqttHost, "192.168.1.60") == 0 && c.mqttPort == 1884 && strcmp(c.mqttPass, "mqtt-secret") == 0);
	CHECK(c.mqttInterval == 60 && c.mqttHA && !c.mqttRemoteAdmin && !c.mqttEvents);
	CHECK(!c.mqttDoorControl); // missing: MQTT door commands are off
	{
		std::string on = legacy;
		on.replace(on.find("\"remoteadmin\":0"), strlen("\"remoteadmin\":0"), "\"remoteadmin\":0,\"doorcontrol\":1");
		core::Settings d;
		CHECK(loadJson(on.c_str(), d).problem == nullptr && d.mqttDoorControl);
		on.replace(on.find("\"doorcontrol\":1"), strlen("\"doorcontrol\":1"), "\"doorcontrol\":7");
		CHECK(loadJson(on.c_str(), d).problem == nullptr && !d.mqttDoorControl); // only 1 turns it on
	}
	CHECK(c.mqttCardUid == core::MQTT_UID_LAST4); // missing (before 1.4.2): last 4
	for (int v : {0, 1, 2})
	{
		std::string set = legacy;
		set.replace(set.find("\"remoteadmin\":0"), strlen("\"remoteadmin\":0"), "\"remoteadmin\":0,\"carduid\":" + std::to_string(v));
		core::Settings d;
		CHECK(loadJson(set.c_str(), d).problem == nullptr && d.mqttCardUid == v);
	}
	CHECK(c.loggingEnabled); // missing: on
	CHECK(c.relayPin[1] == 255 && c.relayPin[2] == 255); // the relays after the first were never named
	// the old SPI reader's default chip select (GPIO5, a strapping pin) refused these
	// settings on the ESP32, so the board failed secure; with the reader gone it loads
	std::string defaultSs = legacy;
	defaultSs.replace(defaultSs.find("\"sspin\":21,"), strlen("\"sspin\":21,"), "");
	CHECK(loadJson(defaultSs.c_str(), r).problem == nullptr && r.readertype == READER_NONE);
	// the other old types: PN532 and RDM6300 alone are off; Wiegand + RDM6300 keeps its Wiegand reader
	for (int t : {2, 3, 4, 6})
	{
		std::string old = voanzo;
		old.replace(old.find("\"readertype\":1"), strlen("\"readertype\":1"), "\"readertype\":" + std::to_string(t));
		core::Settings o;
		core::SettingsLoad ol = loadJson(old.c_str(), o);
		CHECK(ol.problem == nullptr && o.readertype == READER_NONE && o.readers[0].d0 == 255 && ol.warnings.size() == 1);
	}
	{
		std::string old = voanzo;
		old.replace(old.find("\"readertype\":1"), strlen("\"readertype\":1"), "\"readertype\":5");
		core::Settings o;
		core::SettingsLoad ol = loadJson(old.c_str(), o);
		CHECK(ol.problem == nullptr && o.readertype == READER_WIEGAND && o.readers[0].d0 == 34 && o.readers[0].d1 == 35 && ol.warnings.size() == 1);
	}
	// an MQTT host too long for its buffer is dropped with a warning
	std::string longHost = legacy;
	longHost.replace(longHost.find("192.168.1.60"), strlen("192.168.1.60"), std::string(200, 'h'));
	l = loadJson(longHost.c_str(), c);
	CHECK(l.problem == nullptr && l.warnings.size() == 3 && c.mqttHost[0] == '\0'); // + the old reader type

	// IP and text helpers
	core::Ip4 ip;
	CHECK(ip.parse("192.168.4.1") && ip.b[2] == 4);
	CHECK(!ip.parse("192.168.4") && !ip.parse("192.168.4.256") && !ip.parse("1.2.3.4x") && !ip.parse(nullptr));
	char small[4];
	CHECK(core::setText(small, "abc") && strcmp(small, "abc") == 0);
	CHECK(!core::setText(small, "abcd") && small[0] == '\0');
	core::setTextCut(small, "abcdef");
	CHECK(strcmp(small, "abc") == 0);
}

static void testRelayTime()
{
	CHECK(core::isValidRelayTime(100) && core::isValidRelayTime(3000) && core::isValidRelayTime(30000));
	CHECK(!core::isValidRelayTime(99) && !core::isValidRelayTime(30001) && !core::isValidRelayTime(-400) && !core::isValidRelayTime(0));
	CHECK(core::clampRelayTime(-400) == 100 && core::clampRelayTime(0) == 100 && core::clampRelayTime(5000) == 5000);
	CHECK(core::clampRelayTime(2147483647) == 30000);
	// what the firmware stored before: a negative rtime as unsigned long
	unsigned long upstream = (unsigned long)(long)-400;
	CHECK(upstream > 30000UL); // never relocked within any sane time
	CHECK((unsigned long)core::clampRelayTime(-400) == 100UL);
}

static void testUserFiles()
{
	char b[40];
	CHECK(core::classifyUserFile("04a1b2c3", b, sizeof(b)) == core::UserFileKind::Record && strcmp(b, "04a1b2c3") == 0);
	CHECK(core::classifyUserFile("04a1b2c3.bak", b, sizeof(b)) == core::UserFileKind::Backup && strcmp(b, "04a1b2c3") == 0);
	CHECK(core::classifyUserFile("12345678.tmp", b, sizeof(b)) == core::UserFileKind::Temp && strcmp(b, "12345678") == 0);
	CHECK(core::classifyUserFile(".bak", b, sizeof(b)) == core::UserFileKind::Other);
	CHECK(core::classifyUserFile("a.b.bak", b, sizeof(b)) == core::UserFileKind::Other);
	CHECK(core::classifyUserFile("x.json", b, sizeof(b)) == core::UserFileKind::Other);
	CHECK(core::classifyUserFile("", b, sizeof(b)) == core::UserFileKind::Other);
	CHECK(core::classifyUserFile(nullptr, b, sizeof(b)) == core::UserFileKind::Other);
	char small[4];
	CHECK(core::classifyUserFile("12345.bak", small, sizeof(small)) == core::UserFileKind::Other);
	CHECK(core::classifyUserFile("1234.bak", small, sizeof(small)) == core::UserFileKind::Other); // no room for the NUL
	CHECK(core::classifyUserFile("123.bak", small, sizeof(small)) == core::UserFileKind::Backup && strcmp(small, "123") == 0);

	// delete: a write interrupted earlier left 04a1.bak beside the record.
	// Removing only the record (upstream) leaves the .bak, which
	// readJsonFileRecover then restores: the deleted user is back.
	FakeFS fs;
	fs.files["/P/04a1"] = "{}";
	fs.files["/P/04a1.bak"] = "{}";
	fs.files["/P/04a1.tmp"] = "{";
	fs.files["/P/0bb2"] = "{}";
	CHECK(core::removeUserFiles(fs, "04a1"));
	CHECK(!fs.exists("/P/04a1") && !fs.exists("/P/04a1.bak") && !fs.exists("/P/04a1.tmp"));
	CHECK(fs.exists("/P/0bb2")); // other users untouched
	CHECK(!core::removeUserFiles(fs, "../config.json") && !core::removeUserFiles(fs, nullptr));
	// a removal that fails is reported: the caller must not answer "deleted"
	fs.files["/P/0cc3"] = "{}";
	fs.files["/P/0cc3.bak"] = "{}";
	fs.stuck.insert("/P/0cc3.bak");
	CHECK(!core::removeUserFiles(fs, "0cc3"));
	CHECK(fs.exists("/P/0cc3")); // the .bak stayed, so the record stays: present, not resurrected later
	fs.stuck = {"/P/0cc3"};
	CHECK(!core::removeUserFiles(fs, "0cc3") && !fs.exists("/P/0cc3.bak") && fs.exists("/P/0cc3"));
	fs.stuck.clear();
	CHECK(core::removeUserFiles(fs, "0cc3") && !fs.exists("/P/0cc3"));
	CHECK(core::removeUserFiles(fs, "0dd4")); // nothing there: nothing left

	// MQTT getuserlist: never the PIN, and a PIN-only user's uid (the PIN)
	// is not sent either (review 4 #3: the whole file went out)
	auto pub = [](const char *uid, const char *stored) {
		StaticJsonDocument<512> in, out;
		deserializeJson(in, stored);
		core::publicUserRecord(uid, in.as<JsonObjectConst>(), out.to<JsonObject>());
		std::string s;
		serializeJson(out, s);
		return s;
	};
	std::string card = pub("04a1b2c3", "{\"command\":\"userfile\",\"doorip\":\"10.0.0.5\",\"uid\":\"04a1b2c3\",\"user\":\"Alice\",\"pincode\":\"4821\",\"acctype\":1,\"acctype2\":0,\"validsince\":0,\"validuntil\":2145916800}");
	CHECK(card.find("4821") == std::string::npos && card.find("pincode") == std::string::npos && card.find("doorip") == std::string::npos);
	CHECK(card.find("\"uid\":\"04a1b2c3\"") != std::string::npos && card.find("\"user\":\"Alice\"") != std::string::npos && card.find("\"haspin\":true") != std::string::npos);
	CHECK(card.find("\"acctype\":1") != std::string::npos && card.find("\"validuntil\":2145916800") != std::string::npos && card.find("\"command\":\"userfile\"") == 1);
	std::string keypad = pub("7395", "{\"uid\":\"7395\",\"user\":\"Carol\",\"pincode\":\"7395\",\"acctype\":1}");
	CHECK(keypad.find("7395") == std::string::npos && keypad.find("\"uid\":\"keypad\"") != std::string::npos && keypad.find("\"keypad\":true") != std::string::npos);
	std::string nopin = pub("12345678", "{\"user\":\"Bob\",\"acctype\":1}");
	CHECK(nopin.find("\"haspin\":false") != std::string::npos && nopin.find("keypad") == std::string::npos);
}

static void testFeedbackPinsJson()
{
	core::FeedbackPattern p;
	CHECK(!p.active(0));
	p.start(core::BEEP_DENIED.count, core::BEEP_DENIED.onMs, core::BEEP_DENIED.offMs, 1000);
	int edges = 0;
	bool prev = false;
	for (uint32_t t = 1000; t < 2000; t++)
	{
		bool a = p.active(t);
		if (a && !prev)
			edges++;
		prev = a;
	}
	CHECK(edges == 3);
	CHECK(!p.running(1000 + 600));
	CHECK(p.active(1050) && !p.active(1150) && p.active(1250));
	core::FeedbackPattern w;
	w.start(1, 120, 0, WRAP32 - 64); // across the old 32-bit boundary
	CHECK(w.active(WRAP32 - 16) && w.active(WRAP32 + 10) && !w.active(WRAP32 + 200));
	CHECK(!w.active(WRAP32 - 64 + WRAP32) && !w.active(WRAP32 - 64 + WRAP32 + 50)); // no blip 49.7 days later

	core::PinSet e = core::pinSetEsp32();
	CHECK(core::pinAllowed(e, 16, true) && core::pinAllowed(e, 17, true) && core::pinAllowed(e, 25, false));
	for (int bad : {0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 24, 28, 40})
		CHECK(!core::pinAllowed(e, bad, false));
	CHECK(core::pinAllowed(e, 34, false) && !core::pinAllowed(e, 34, true)); // input-only
	CHECK(core::pinAllowed(e, 35, false) && !core::pinAllowed(e, 35, true));
	CHECK(!core::pinAllowed(e, 36, false) && !core::pinAllowed(e, 39, false)); // ESP32 errata
	core::PinSet s3 = core::pinSetEsp32s3();
	CHECK(core::pinAllowed(s3, 21, true) && !core::pinAllowed(s3, 19, false) && !core::pinAllowed(s3, 30, false) && !core::pinAllowed(s3, 34, false));
	CHECK(core::isValidOpeningHoursDay("111111111111111111111111"));
	CHECK(core::isValidOpeningHoursDay("000000000000000000000000"));
	CHECK(!core::isValidOpeningHoursDay(nullptr));
	CHECK(!core::isValidOpeningHoursDay("11111111111111111111111"));
	CHECK(!core::isValidOpeningHoursDay("11111111111111111111111x"));

	DynamicJsonDocument j(256);
	deserializeJson(j, "{\"a\":16,\"b\":\"17\",\"c\":\"x\",\"d\":\"\",\"e\":\"-1\",\"f\":true}");
	CHECK(core::jsonInt(j["a"], 255) == 16);
	CHECK(core::jsonInt(j["b"], 255) == 17); // upstream UI wrote relay pins as strings
	CHECK(core::jsonInt(j["c"], 255) == 255);
	CHECK(core::jsonInt(j["d"], 255) == 255);
	CHECK(core::jsonInt(j["e"], 255) == -1);
	CHECK(core::jsonInt(j["f"], 255) == 1);
	CHECK(core::jsonInt(j["missing"], 7) == 7);
}

static void testFirmwareConfirm()
{
	// a new image is confirmed after 60 s once the UI has been reached; with
	// nobody opening the UI it used to stay unconfirmed, so the next power
	// cut silently put the old firmware back. Now an hour of running confirms
	// it anyway.
	CHECK(!core::firmwareConfirmDue(59999, true));
	CHECK(core::firmwareConfirmDue(60000, true));
	CHECK(!core::firmwareConfirmDue(60000, false));
	CHECK(!core::firmwareConfirmDue(core::FIRMWARE_CONFIRM_UNATTENDED_MS - 1, false));
	CHECK(core::firmwareConfirmDue(core::FIRMWARE_CONFIRM_UNATTENDED_MS, false));
	CHECK(core::FIRMWARE_CONFIRM_UNATTENDED_MS > 20000); // the rollback-test image hangs at 20 s
}

// The first 36 bytes of real images (bin/*.bin of this build).
static void testUpdateImageHead()
{
	const uint8_t wroom[36] = {0xe9, 0x05, 0x02, 0x20, 0x64, 0x2f, 0x08, 0x40, 0xee, 0, 0, 0, 0x00, 0x00, 0, 0,
							   0x00, 0xff, 0xff, 0, 0, 0, 0, 0x01, 0x20, 0x00, 0x40, 0x3f, 0x2c, 0x9f, 0x04, 0x00, 0x32, 0x54, 0xcd, 0xab};
	const uint8_t s3[36] = {0xe9, 0x05, 0x02, 0x3f, 0xa0, 0x73, 0x37, 0x40, 0xee, 0, 0, 0, 0x09, 0x00, 0, 0,
							0x00, 0xff, 0xff, 0, 0, 0, 0, 0x01, 0x20, 0x00, 0x0d, 0x3c, 0x04, 0xa0, 0x04, 0x00, 0x32, 0x54, 0xcd, 0xab};
	// esp32s3-full.bin: the bootloader first (0xE9, chip 9, no app description)
	const uint8_t s3full[36] = {0xe9, 0x03, 0x02, 0x3f, 0xd0, 0x98, 0x3c, 0x40, 0xee, 0, 0, 0, 0x09, 0x00, 0, 0,
								0x00, 0xff, 0xff, 0, 0, 0, 0, 0x01, 0x08, 0x38, 0xce, 0x3f, 0xbc, 0x04, 0, 0, 0xff, 0xff, 0xff, 0xff};
	uint8_t wroomFull[36]; // esp32wroom-full.bin: 0xFF up to the bootloader at 0x1000
	memset(wroomFull, 0xff, sizeof(wroomFull));
	CHECK(core::checkUpdateImageHead(wroom, 36, core::IMAGE_CHIP_ESP32) == nullptr);
	CHECK(core::checkUpdateImageHead(s3, 36, core::IMAGE_CHIP_ESP32S3) == nullptr);
	CHECK(strstr(core::checkUpdateImageHead(s3, 36, core::IMAGE_CHIP_ESP32), "another chip"));
	CHECK(strstr(core::checkUpdateImageHead(wroom, 36, core::IMAGE_CHIP_ESP32S3), "another chip"));
	CHECK(strstr(core::checkUpdateImageHead(s3full, 36, core::IMAGE_CHIP_ESP32S3), "bootloader"));
	CHECK(strstr(core::checkUpdateImageHead(wroomFull, 36, core::IMAGE_CHIP_ESP32), "0xE9"));
	CHECK(strstr(core::checkUpdateImageHead(wroom, 35, core::IMAGE_CHIP_ESP32), "too short"));
}

static void testWifiEnable()
{
	// hotspot running: an admin card must not restart it (it did, every swipe)
	CHECK(!core::shouldEnableWifi(false, true, false));
	// Wi-Fi switched off by idle-off: the card brings it back, either mode
	CHECK(core::shouldEnableWifi(true, true, false));
	CHECK(core::shouldEnableWifi(true, false, false));
	// station mode not connected: the card and the 5-minute connect backstop
	// still re-run the connect; connected, nothing to do
	CHECK(core::shouldEnableWifi(false, false, false));
	CHECK(!core::shouldEnableWifi(false, false, true));

}

static void testWifiLinkState()
{
	const uint64_t LOST = 5 * 60000;
	// lost for 5 minutes while watched: once
	{
		core::LinkLostWatch w;
		CHECK(!w.tick(1000, true, true, LOST));        // connected
		CHECK(!w.tick(2000, true, false, LOST));       // lost from here
		CHECK(!w.tick(2000 + LOST - 1, true, false, LOST));
		CHECK(w.tick(2000 + LOST, true, false, LOST)); // the fallback hotspot opens
		CHECK(!w.tick(2000 + LOST + 1, true, false, LOST)); // once: a new count starts
	}
	// back for a moment, or not watched (fallback off, connecting, hotspot up): start over
	{
		core::LinkLostWatch w;
		CHECK(!w.tick(0, true, false, LOST));
		CHECK(!w.tick(4 * 60000, true, true, LOST));
		CHECK(!w.tick(4 * 60000 + 1, true, false, LOST));
		CHECK(!w.tick(4 * 60000 + LOST, true, false, LOST));
		CHECK(w.tick(4 * 60000 + 1 + LOST, true, false, LOST));
		core::LinkLostWatch u;
		CHECK(!u.tick(0, true, false, LOST));
		CHECK(!u.tick(3 * 60000, false, false, LOST));
		CHECK(!u.tick(6 * 60000, true, false, LOST)); // counted from here
		CHECK(!u.tick(6 * 60000 + LOST - 1, true, false, LOST) && u.tick(6 * 60000 + LOST, true, false, LOST));
	}
	// past 49.7 days of uptime
	{
		core::LinkLostWatch w;
		CHECK(!w.tick(WRAP32 * 2, true, false, LOST) && w.tick(WRAP32 * 2 + LOST, true, false, LOST));
	}
	// the fallback hotspot's retries of the configured network: every 2 min,
	// a turn skipped while someone is on the hotspot
	const uint64_t EVERY = 120000;
	uint64_t next = 120000;
	CHECK(!core::fallbackRetryDue(119999, next, false, EVERY) && next == 120000);
	CHECK(core::fallbackRetryDue(120000, next, false, EVERY) && next == 240000);
	CHECK(!core::fallbackRetryDue(240000, next, true, EVERY) && next == 360000); // skipped, not delayed
	CHECK(!core::fallbackRetryDue(300000, next, false, EVERY));
	CHECK(core::fallbackRetryDue(360001, next, false, EVERY) && next == 480001);
}

static void testWsAlive()
{
	using core::WsAlive;
	const uint64_t S = 1000;
	// heard recently: nothing to do
	CHECK(core::wsAlive(100 * S, 100 * S, 0) == WsAlive::Fine);
	CHECK(core::wsAlive(129 * S, 100 * S, 0) == WsAlive::Fine);
	// quiet 30 s: ping, then not again for 30 s
	CHECK(core::wsAlive(130 * S, 100 * S, 0) == WsAlive::Ping);
	CHECK(core::wsAlive(131 * S, 100 * S, 130 * S) == WsAlive::Fine);
	CHECK(core::wsAlive(159 * S, 100 * S, 130 * S) == WsAlive::Fine);
	CHECK(core::wsAlive(160 * S, 100 * S, 130 * S) == WsAlive::Ping);
	// a pong after the ping: heard again, quiet counts from there
	CHECK(core::wsAlive(161 * S, 160 * S + 50, 160 * S) == WsAlive::Fine);
	CHECK(core::wsAlive(190 * S + 50, 160 * S + 50, 160 * S) == WsAlive::Ping);
	// nothing heard for 90 s (three pings unanswered): close
	CHECK(core::wsAlive(189 * S, 100 * S, 160 * S) == WsAlive::Fine);
	CHECK(core::wsAlive(190 * S, 100 * S, 160 * S) == WsAlive::Close);
	CHECK(core::wsAlive(190 * S, 100 * S, 0) == WsAlive::Close); // never pinged: still closed
	// a ping from before it was last heard does not hold back the next one
	CHECK(core::wsAlive(140 * S, 105 * S, 101 * S) == WsAlive::Ping);
	// heard "after now" (stamped by the other task meanwhile): fine
	CHECK(core::wsAlive(100 * S, 100 * S + 1, 0) == WsAlive::Fine);
	// a socket that keeps answering is never closed, however long it lives
	{
		uint64_t heard = 0, pinged = 0;
		bool closed = false;
		for (uint64_t t = 0; t <= 12ULL * 3600 * S; t += S)
		{
			WsAlive a = core::wsAlive(t, heard, pinged);
			if (a == WsAlive::Close) closed = true;
			if (a == WsAlive::Ping) { pinged = t; heard = t + 40; } // the browser's pong, 40 ms later
		}
		CHECK(!closed);
	}
}

static void testStorageSpace()
{
	const size_t K = 1024;
	// a new user stops at 64 KB free, above the 48 KB the logs keep for themselves
	CHECK(core::newUserFits(64 * K));
	CHECK(!core::newUserFits(64 * K - 1));
	CHECK(!core::newUserFits(0));
	CHECK(core::USER_MIN_FREE_BYTES > 48 * K);
	// a write needs the 16 KB floor plus twice its size (temporary copy, backup)
	CHECK(core::atomicWriteFits(16 * K + 2000, 1000));
	CHECK(!core::atomicWriteFits(16 * K + 1999, 1000));
	CHECK(!core::atomicWriteFits(16 * K - 1, 0));
	CHECK(!core::atomicWriteFits(0, 0));
	CHECK(core::atomicWriteFits(900 * K, 8192));
	// the user limit
	CHECK(!core::userLimitReached(199));
	CHECK(core::userLimitReached(200));
	CHECK(core::userLimitReached(5000));
	// 200 users (measured about 1.15 KB each on the bench) and both logs at
	// their largest (64 KB, plus three rotated copies) still leave the floor
	const size_t store = 896 * K, users200 = 200 * 1180, logsMax = 2 * (1 + 3) * 64 * K;
	CHECK(core::newUserFits(store - users200 - logsMax));
	// the free-space estimate: none until measured, then writes are subtracted
	{
		core::FreeSpace f;
		CHECK(!f.fresh(0));
		f.measured(1000, 100 * K);
		CHECK(f.fresh(1000) && f.fresh(1000 + core::FreeSpace::MAX_AGE_MS - 1));
		CHECK(!f.fresh(1000 + core::FreeSpace::MAX_AGE_MS));
		CHECK(!f.fresh(999)); // a clock that went back: measure again
		f.spent(10 * K);
		CHECK(f.estimate() == 90 * K);
		f.spent(200 * K);
		CHECK(f.estimate() == 0); // never wraps
		f.measured(50000, 80 * K);
		CHECK(f.estimate() == 80 * K); // a new measure forgets what was spent
	}
}

static void testWifiIdleOff()
{
	const uint64_t MIN = 60000;
	// due after the minutes with nobody connected, counted from the first pass
	{
		core::IdleOff t;
		CHECK(!t.tick(5000, true, 15, false));
		CHECK(!t.tick(5000 + 15 * MIN - 1, true, 15, false));
		CHECK(t.tick(5000 + 15 * MIN, true, 15, false));
	}
	// someone connected (a phone on the hotspot, a page open) starts it again
	{
		core::IdleOff t;
		CHECK(!t.tick(0, true, 15, false));
		CHECK(!t.tick(14 * MIN, true, 15, true));
		CHECK(!t.tick(28 * MIN, true, 15, false)); // 14 min since they left
		CHECK(!t.tick(28 * MIN + 1, true, 15, true)); // back again, briefly
		CHECK(!t.tick(43 * MIN, true, 15, false));
		CHECK(t.tick(43 * MIN + 1, true, 15, false));
	}
	// unticked: never due; ticked (a live save), a full period from then
	{
		core::IdleOff t;
		for (uint64_t m = 0; m <= 600; m += 5)
			CHECK(!t.tick(m * MIN, false, 15, false));
		CHECK(!t.tick(614 * MIN, true, 15, false));
		CHECK(t.tick(615 * MIN, true, 15, false));
	}
	// Wi-Fi off (it went off, or never came up): the count waits; a wake by
	// admin card hours later gets a full period
	{
		core::IdleOff t;
		CHECK(!t.tick(0, true, 2, false));
		CHECK(t.tick(2 * MIN, true, 2, false)); // off now
		CHECK(!t.tick(2 * MIN + 10, false, 2, false));
		CHECK(!t.tick(500 * MIN, false, 2, false)); // the admin card
		CHECK(!t.tick(501 * MIN, true, 2, false));
		CHECK(t.tick(502 * MIN, true, 2, false));
	}
	// minutes out of range never turn it off; past 49.7 days of uptime (32-bit millis) still on time
	{
		core::IdleOff t, u;
		CHECK(!t.tick(0, true, 0, false) && !t.tick(WRAP32 * 9, true, 0, false));
		CHECK(!u.tick(0, true, 1441, false) && !u.tick(WRAP32 * 9, true, 1441, false));
		core::IdleOff d;
		CHECK(!d.tick(WRAP32 * 3, true, 1440, false));
		CHECK(!d.tick(WRAP32 * 3 + 1440 * MIN - 1, true, 1440, false));
		CHECK(d.tick(WRAP32 * 3 + 1440 * MIN, true, 1440, false));
	}
	CHECK(!core::isValidIdleMinutes(0) && core::isValidIdleMinutes(1) && core::isValidIdleMinutes(1440) && !core::isValidIdleMinutes(1441) && !core::isValidIdleMinutes(-1));
	// WiFi Timeout seconds as minutes: rounded up, at most a day, 0 = off
	CHECK(core::idleMinutesFromOfftime(0) == 0 && core::idleMinutesFromOfftime(1) == 1 && core::idleMinutesFromOfftime(60) == 1);
	CHECK(core::idleMinutesFromOfftime(61) == 2 && core::idleMinutesFromOfftime(180) == 3 && core::idleMinutesFromOfftime(600) == 10);
	CHECK(core::idleMinutesFromOfftime(86400) == 1440 && core::idleMinutesFromOfftime(86401) == 1440);
	CHECK(core::idleMinutesFromOfftime(4294967295u) == 1440 && core::idleMinutesFromOfftime(4294967290u) == 1440); // seconds + 59 wraps 32 bits to 0 or 1 min

	// the setup hotspot (a board with no settings): a WPA2 password, never
	// open, and closed after a fixed 15 min whatever the tick box says
	CHECK(core::isValidFallbackPassword(core::SETUP_HOTSPOT_PASSWORD) && strcmp(core::SETUP_HOTSPOT_PASSWORD, "ironframe-setup") == 0);
	core::IdleRule r = core::idleRule(true, false, 600);
	CHECK(r.enabled && r.minutes == 15);
	r = core::idleRule(true, true, 2);
	CHECK(r.enabled && r.minutes == 15);
	r = core::idleRule(false, false, 2);
	CHECK(!r.enabled);
	r = core::idleRule(false, true, 2);
	CHECK(r.enabled && r.minutes == 2);
	{
		core::IdleRule s = core::idleRule(true, false, 0);
		core::IdleOff t;
		CHECK(!t.tick(1000, s.enabled, s.minutes, false)); // boot
		CHECK(!t.tick(1000 + 10 * MIN, s.enabled, s.minutes, true)); // a phone joins
		CHECK(!t.tick(1000 + 20 * MIN, s.enabled, s.minutes, true)); // still there; it leaves after this pass
		CHECK(!t.tick(1000 + 35 * MIN - 1, s.enabled, s.minutes, false));
		CHECK(t.tick(1000 + 35 * MIN, s.enabled, s.minutes, false)); // 15 min untouched: closed
	}
}

static void testMemGuard()
{
	const uint64_t HOUR = 3600000;
	// the scheduled restart: due after the interval, taken when idle, an
	// hour late at most (it used to restart whatever a door was doing)
	CHECK(!core::autoRestartNow(1000, 0, true));      // off
	CHECK(!core::autoRestartNow(86400, 86400, true)); // not yet due
	CHECK(core::autoRestartNow(86401, 86400, true));
	CHECK(!core::autoRestartNow(86401, 86400, false)); // a door busy: waits
	CHECK(!core::autoRestartNow(86400 + 3600, 86400, false));
	CHECK(core::autoRestartNow(86400 + 3601, 86400, false)); // an hour late: goes ahead
	// three card reads refused for memory in a row: a restart, once idle
	{
		core::MemGuard g;
		g.noteBusy();
		g.noteBusy();
		CHECK(g.wanted(2 * HOUR) == nullptr);
		g.noteBusy();
		CHECK(g.wanted(2 * HOUR) != nullptr && strstr(g.wanted(2 * HOUR), "card reads"));
		CHECK(g.restartReason(2 * HOUR, false) == nullptr); // a reader mid-card, a door open, an upload: wait
		CHECK(g.restartReason(2 * HOUR, true) != nullptr);
		// a lookup that read its record: memory came back, no restart
		g.noteLookupOk();
		CHECK(g.restartReason(2 * HOUR, true) == nullptr);
		g.noteBusy();
		g.noteBusy();
		g.noteLookupOk();
		g.noteBusy();
		CHECK(g.restartReason(2 * HOUR, true) == nullptr); // not in a row
	}
	// the largest block low for 10 samples in a row (a minute apart)
	{
		core::MemGuard g;
		for (int i = 0; i < 9; i++)
			g.sample(core::MemGuard::LOW_BLOCK_BYTES - 1);
		CHECK(g.restartReason(2 * HOUR, true) == nullptr);
		g.sample(core::MemGuard::LOW_BLOCK_BYTES); // recovered: starts again
		for (int i = 0; i < 9; i++)
			g.sample(4000);
		CHECK(g.restartReason(2 * HOUR, true) == nullptr);
		g.sample(4000);
		const char *why = g.restartReason(2 * HOUR, true);
		CHECK(why != nullptr && strstr(why, "largest free block"));
		CHECK(g.restartReason(2 * HOUR, false) == nullptr);
		for (int i = 0; i < 100; i++)
			g.sample(100); // stays wanted, no overflow
		CHECK(g.restartReason(2 * HOUR, true) != nullptr);
		g.sample(50000);
		CHECK(g.restartReason(2 * HOUR, true) == nullptr);
	}
	// wanted but never idle: restarts anyway after an hour (plan 1.9.1 C2;
	// one Continuous door held open blocked it for ever, review 8 V5)
	{
		core::MemGuard g;
		for (int i = 0; i < 3; i++)
			g.noteBusy();
		const uint64_t T = 2 * HOUR, MIN = 60000;
		bool waited = true;
		for (uint64_t m = 0; m <= 59; m++)
			waited = waited && g.restartReason(T + m * MIN, false) == nullptr;
		CHECK(waited && !g.overdue(T + 59 * MIN));
		CHECK(g.restartReason(T + 61 * MIN, false) != nullptr && g.overdue(T + 61 * MIN));
		CHECK(g.restartReason(T + core::MemGuard::GRACE_MS, false) != nullptr); // exactly the hour
		CHECK(core::MemGuard::GRACE_MS == HOUR);
		// memory came back meanwhile: the grace starts again from the next want
		g.noteLookupOk();
		CHECK(g.restartReason(T + 62 * MIN, false) == nullptr && !g.overdue(T + 62 * MIN));
		for (int i = 0; i < 3; i++)
			g.noteBusy();
		CHECK(g.restartReason(T + 63 * MIN, false) == nullptr);
		CHECK(g.restartReason(T + 63 * MIN + HOUR - 1, false) == nullptr && g.restartReason(T + 63 * MIN + HOUR, false) != nullptr);
		// idle still wins at once
		core::MemGuard h;
		for (int i = 0; i < 3; i++)
			h.noteBusy();
		CHECK(h.restartReason(T, false) == nullptr && h.restartReason(T + 1, true) != nullptr);
	}
	// never in the first hour after a start: at most one memory restart an hour
	{
		core::MemGuard g;
		for (int i = 0; i < 3; i++)
			g.noteBusy();
		CHECK(g.restartReason(0, true) == nullptr && g.restartReason(HOUR - 1, true) == nullptr);
		CHECK(g.restartReason(HOUR, true) != nullptr);
	}
}

// A fake /P for removeAllUserFiles: names in order, what was listed and removed.
struct FakeUserDir
{
	std::vector<std::string> files;
	std::set<std::string> stuck; // remove() fails for these
	std::vector<std::string> removed;
	size_t maxListed = 0;
	int lists = 0;
	size_t list(bool backups, char (*out)[core::USER_FILE_PATH_MAX], size_t max)
	{
		lists++;
		size_t n = 0;
		for (const std::string &f : files)
		{
			bool bak = f.size() > 4 && f.compare(f.size() - 4, 4, ".bak") == 0;
			if (bak == backups && n < max)
				snprintf(out[n++], core::USER_FILE_PATH_MAX, "%s", f.c_str());
		}
		maxListed = std::max(maxListed, n);
		return n;
	}
	bool remove(const char *path)
	{
		if (stuck.count(path))
			return false;
		auto it = std::find(files.begin(), files.end(), std::string(path));
		if (it != files.end())
			files.erase(it);
		removed.push_back(path);
		return true;
	}
};

// A user folder for UserIndex::buildStep: names in order, records by uid;
// "bad" cannot be read.
struct FakeIndexDir
{
	std::vector<std::string> names;
	size_t at = 0;
	bool nextUid(std::string &uid)
	{
		while (at < names.size())
		{
			uid = names[at++];
			if (core::isValidUid(uid.c_str()))
				return true;
		}
		return false;
	}
	bool read(const char *uid, JsonDocument &doc)
	{
		if (std::string(uid) == "bad")
			return false;
		doc["user"] = std::string("User ") + uid;
		doc["pincode"] = std::string(uid) == "b2" ? "4821" : "";
		doc["acctype"] = 1;
		doc["acctype2"] = std::string(uid) == "c3" ? 99 : 0;
		doc["validsince"] = 0;
		doc["validuntil"] = 2145916800UL;
		return true;
	}
};

static void testUserIndex()
{
	// put keeps uid order, replaces, erase removes; clear is not ready
	{
		core::UserIndex ix;
		DynamicJsonDocument d(256);
		d["user"] = "Zed";
		d["acctype"] = 1;
		ix.put("zz", d.as<JsonObjectConst>());
		d["user"] = "Amy";
		d["pincode"] = "1234";
		d["acctype3"] = 99;
		d["validsince"] = 1760000000UL;
		ix.put("aa", d.as<JsonObjectConst>());
		ix.put("Bad uid!", d.as<JsonObjectConst>()); // refused: not a uid
		CHECK(ix.size() == 2 && ix.at(0).uid == "aa" && ix.at(1).uid == "zz");
		CHECK(ix.at(0).name == "Amy" && ix.at(0).pin == "1234" && ix.at(0).acctype[2] == 99 && ix.at(0).validSince == 1760000000UL);
		CHECK(ix.at(1).pin.empty() && ix.at(1).acctype[0] == 1 && ix.at(1).validUntil == 0);
		d["user"] = "Amy B";
		ix.put("aa", d.as<JsonObjectConst>());
		CHECK(ix.size() == 2 && ix.at(0).name == "Amy B");
		ix.erase("aa");
		ix.erase("nobody");
		CHECK(ix.size() == 1 && ix.at(0).uid == "zz" && !ix.contains("aa") && ix.contains("zz"));
		CHECK(!ix.ready());
		ix.setReady();
		CHECK(ix.ready());
		ix.clear();
		CHECK(ix.size() == 0 && !ix.ready());
	}
	// a legacy record with the role and dates as strings (hand-edited, or an
	// old tool): listed as the reader reads it (plan 1.9.1 C4, review 8 V15)
	{
		core::UserIndex ix;
		DynamicJsonDocument d(256);
		deserializeJson(d, "{\"user\":\"Old\",\"acctype\":\"1\",\"acctype2\":\"99\",\"validsince\":\"1700000000\",\"validuntil\":\"4102444800\"}");
		ix.put("0a0b0c0d", d.as<JsonObjectConst>());
		CHECK(ix.at(0).acctype[0] == 1 && ix.at(0).acctype[1] == 99 && ix.at(0).validSince == 1700000000UL && ix.at(0).validUntil == 4102444800UL);
		CHECK(core::recordRole(d["acctype"]) == 1 && core::recordEpoch(d["validuntil"]) == 4102444800UL);
		deserializeJson(d, "{\"acctype\":\"x\",\"validuntil\":\"soon\",\"validsince\":-5}");
		CHECK(core::recordRole(d["acctype"]) == 0 && core::recordEpoch(d["validuntil"]) == 0 && core::recordEpoch(d["validsince"]) == 0 && core::recordEpoch(d["missing"]) == 0);
	}
	// a build: one user per step, .bak/.tmp and unreadable files left out,
	// ready at the end
	{
		FakeIndexDir dir;
		dir.names = {"c3", "a1", "a1.bak", "bad", "b2", "x.tmp"};
		core::UserIndex ix;
		DynamicJsonDocument doc(512);
		int steps = 0;
		while (ix.buildStep(dir, doc))
		{
			CHECK(!ix.ready());
			steps++;
		}
		CHECK(steps == 4 && ix.ready() && ix.size() == 3);
		CHECK(ix.at(0).uid == "a1" && ix.at(1).uid == "b2" && ix.at(2).uid == "c3");
		CHECK(ix.at(1).pin == "4821" && ix.at(2).acctype[1] == 99 && ix.at(0).name == "User a1");
	}
	// a user saved while the build runs is kept, and read again later without a duplicate
	{
		FakeIndexDir dir;
		dir.names = {"a1", "b2"};
		core::UserIndex ix;
		DynamicJsonDocument doc(512);
		DynamicJsonDocument d(256);
		d["user"] = "Saved meanwhile";
		ix.put("b2", d.as<JsonObjectConst>());
		while (ix.buildStep(dir, doc))
			;
		CHECK(ix.size() == 2 && ix.at(1).uid == "b2" && ix.at(1).name == "User b2"); // the file is the record
		// the cursor: in order, and past the end
		CHECK(ix.after("")->uid == "a1" && ix.after("a1")->uid == "b2" && ix.after("a5")->uid == "b2" && ix.after("b2") == nullptr);
		// back to a record: the PIN only when asked for
		DynamicJsonDocument r(1024); // 8 members: 256 bytes is too small on a 64-bit host
		core::UserIndex::toRecord(ix.at(1), r.to<JsonObject>(), false);
		CHECK(r["user"] == "User b2" && r["acctype"] == 1 && !r.containsKey("pincode") && r["validuntil"] == 2145916800UL);
		core::UserIndex::toRecord(ix.at(1), r.to<JsonObject>(), true);
		CHECK(r["pincode"] == "4821");
	}
}

static void testRemoveAllUserFiles()
{
	// 300 users, some mid-write (.bak, .tmp): all gone, never more than one
	// batch of names held, every .bak before any record
	FakeUserDir d;
	for (int i = 0; i < 300; i++)
	{
		d.files.push_back("/P/user" + std::to_string(i));
		if (i % 37 == 0)
			d.files.push_back("/P/user" + std::to_string(i) + ".bak");
		if (i % 53 == 0)
			d.files.push_back("/P/user" + std::to_string(i) + ".tmp");
	}
	size_t total = d.files.size();
	CHECK(core::removeAllUserFiles(d));
	CHECK(d.files.empty() && d.removed.size() == total);
	CHECK(d.maxListed <= core::USER_DELETE_BATCH);
	size_t lastBak = 0, firstOther = d.removed.size();
	for (size_t i = 0; i < d.removed.size(); i++)
	{
		bool bak = d.removed[i].size() > 4 && d.removed[i].compare(d.removed[i].size() - 4, 4, ".bak") == 0;
		if (bak)
			lastBak = i;
		else if (firstOther == d.removed.size())
			firstOther = i;
	}
	CHECK(lastBak < firstOther);
	// a file that will not go: false, the rest still removed, and it ends
	FakeUserDir s;
	for (int i = 0; i < 40; i++)
		s.files.push_back("/P/u" + std::to_string(i));
	s.stuck.insert("/P/u7");
	CHECK(!core::removeAllUserFiles(s));
	CHECK(s.files.size() == 1 && s.files[0] == "/P/u7" && s.lists < 20);
	// nothing there: true
	FakeUserDir e;
	CHECK(core::removeAllUserFiles(e) && e.removed.empty());
}

static void testRelayTimers()
{
	// two doors, 400 ms and 3000 ms holds, each with its own timer
	core::RelayTimer door1, door2;
	CHECK(!door1.expired(0, 400)); // never started
	door2.start(1000);
	door1.start(2000); // door 1 opens while door 2 is held
	CHECK(!door2.expired(2000, 3000)); // door 1 opening must not release door 2
	CHECK(!door2.expired(3999, 3000));
	CHECK(door1.expired(2400, 400));
	CHECK(!door1.expired(2500, 400)); // fires once
	CHECK(door2.expired(4000, 3000));  // door 2 keeps its own 3 s
	door1.start(5000);
	door1.stop();
	CHECK(!door1.running() && !door1.expired(9000, 100));
	// upstream shared one start time: re-opening door 1 re-timed door 2
	door2.start(10000);
	door1.start(12000);
	CHECK(door2.expired(13000, 3000));
	// 64-bit time, across the old 32-bit millis() boundary
	core::RelayTimer w;
	w.start(WRAP32 - 256);
	CHECK(!w.expired(WRAP32 + 16, 400));  // 272 ms after start
	CHECK(w.expired(WRAP32 + 144, 400)); // 400 ms after start
	CHECK(!w.running());
}

// The relock deadline behind the esp_timer that relocks a momentary relay
// (relayPulse / relayRelockCallback in main.cpp). Microseconds.
static void testRelockDeadline()
{
	core::RelockDeadline d;
	CHECK(!d.pending() && !d.due(5000000)); // nothing pending: a stray callback relocks nothing
	d.arm(1000000, 3000);                   // opened at 1 s for 3 s
	CHECK(d.pending());
	CHECK(!d.due(3998999));                 // more than 1 ms early: not yet
	CHECK(d.due(3999000));                  // 1 ms early counts (timer granularity)
	CHECK(!d.pending() && !d.due(4000000)); // once only
	// opened again during the hold: the first pulse's callback, run late,
	// must not relock the door the second pulse holds open
	d.arm(10000000, 3000);
	d.arm(12000000, 3000); // second press at 12 s: relock at 15 s
	CHECK(!d.due(13000000));
	CHECK(d.pending());
	CHECK(d.due(15000000));
	// cancelled (MQTT close locks the relay itself): the callback does nothing
	d.arm(20000000, 400);
	d.cancel();
	CHECK(!d.pending() && !d.due(20400000));
	// the longest hold the settings allow
	const int64_t longest = core::clampRelayTime(2147483647);
	d.arm(1000000, (unsigned long)longest);
	CHECK(!d.due(1000000 + longest * 1000 - 1001));
	CHECK(d.due(1000000 + longest * 1000));
	// after 24.8 days of uptime (64-bit, no 32-bit wrap); a callback run a
	// minute late (busy timer task) still relocks
	const int64_t days = (int64_t)DAYS_24_8 * 1000;
	d.arm(days, 3000);
	CHECK(!d.due(days + 2998999));
	CHECK(d.due(days + 60000000));
}

// readJsonFileRecover's policy (core/jsonrecover.h) with ArduinoJson's real
// errors: out of memory, or a document too small, is not corruption.
static void testJsonRecover()
{
	const std::string good = "{\"general\":{\"hostnm\":\"door-new\",\"pad\":\"" + std::string(300, 'x') + "\"}}";
	const std::string older = "{\"general\":{\"hostnm\":\"door-old\"}}";
	auto run = [&](FakeFS &fs, size_t docBytes, bool keepBackup, core::JsonRead *first, std::string *host) {
		DynamicJsonDocument doc(docBytes);
		auto read = [&](const char *name) {
			if (!fs.exists(name))
				return core::JsonRead::Missing;
			doc.clear();
			DeserializationError e = deserializeJson(doc, fs.files[name]);
			if (e == DeserializationError::NoMemory)
				return core::JsonRead::NoMemory;
			return e ? core::JsonRead::Corrupt : core::JsonRead::Ok;
		};
		core::JsonRecover r = core::readJsonRecover(fs, "/config.json", "/config.json.bak", keepBackup, read, first);
		if (host)
			*host = doc["general"]["hostnm"] | "";
		return r;
	};
	core::JsonRead first;
	std::string host;
	{
		FakeFS fs; // the reviewer's case: memory short, config.json fine
		fs.files["/config.json"] = good;
		fs.files["/config.json.bak"] = older;
		CHECK(run(fs, 64, true, &first, nullptr) == core::JsonRecover::NoMemory);
		CHECK(fs.files["/config.json"] == good && fs.files["/config.json.bak"] == older); // nothing promoted
		CHECK(run(fs, 2048, true, &first, &host) == core::JsonRecover::Read && host == "door-new");
		CHECK(fs.exists("/config.json.bak")); // config.json keeps its .bak
	}
	{
		FakeFS fs; // corrupt: the .bak takes its place
		fs.files["/config.json"] = "{\"general\":{\"hostn";
		fs.files["/config.json.bak"] = older;
		CHECK(run(fs, 2048, true, &first, &host) == core::JsonRecover::Recovered && first == core::JsonRead::Corrupt && host == "door-old");
		CHECK(fs.files["/config.json"] == older && !fs.exists("/config.json.bak"));
	}
	{
		FakeFS fs; // corrupt, and no memory for the .bak: leave both
		fs.files["/config.json"] = "{";
		fs.files["/config.json.bak"] = good;
		CHECK(run(fs, 64, true, &first, nullptr) == core::JsonRecover::NoMemory);
		CHECK(fs.files["/config.json"] == "{" && fs.files["/config.json.bak"] == good);
	}
	{
		FakeFS fs; // missing
		fs.files["/config.json.bak"] = older;
		CHECK(run(fs, 2048, true, &first, &host) == core::JsonRecover::Recovered && first == core::JsonRead::Missing && host == "door-old");
		FakeFS none;
		CHECK(run(none, 2048, true, &first, nullptr) == core::JsonRecover::Failed && none.files.empty());
		FakeFS both;
		both.files["/config.json"] = "x";
		both.files["/config.json.bak"] = "y";
		CHECK(run(both, 2048, true, &first, nullptr) == core::JsonRecover::Failed && both.files.size() == 2);
	}
	{
		FakeFS fs; // a user record's leftover .bak goes once the record reads
		fs.files["/config.json"] = older;
		fs.files["/config.json.bak"] = older;
		CHECK(run(fs, 2048, false, &first, nullptr) == core::JsonRecover::Read && !fs.exists("/config.json.bak"));
	}
	// BOOT-hold recovery: the settings go, the users and logs stay (it
	// formatted the whole filesystem until 1.4.1)
	{
		FakeFS fs;
		for (const char *n : {"/config.json", "/config.json.bak", "/config.json.tmp", "/P/12345678", "/P/23456789.bak", "/eventlog.json", "/latestlog.json"})
			fs.files[n] = "{}";
		CHECK(core::eraseSettingsFiles(fs));
		CHECK(fs.files.size() == 4 && fs.exists("/P/12345678") && fs.exists("/P/23456789.bak") && fs.exists("/eventlog.json") && fs.exists("/latestlog.json"));
		CHECK(core::eraseSettingsFiles(fs) && fs.files.size() == 4); // nothing left to erase is fine
		// a settings file that will not go: refused (the firmware then formats)
		struct StuckFS : FakeFS
		{
			bool remove(const char *p) { return std::string(p) != "/config.json.bak" && FakeFS::remove(p); }
		} stuck;
		stuck.files["/config.json"] = stuck.files["/config.json.bak"] = stuck.files["/P/12345678"] = "{}";
		CHECK(!core::eraseSettingsFiles(stuck) && !stuck.exists("/config.json") && stuck.exists("/P/12345678"));
	}
	// NVS on a reset: a factory reset (web page) also removes the relay and
	// exit-button boot copies; BOOT-hold recovery keeps them (2026-10-15)
	{
		struct FakeNvs
		{
			std::set<std::string> keys;
			bool isKey(const char *k) const { return keys.count(k) != 0; }
			bool remove(const char *k) { return keys.erase(k) != 0; }
		};
		const std::set<std::string> all = {"commissioned", "adminha1", "adminpw", "pinlock", "pinlock1", "pinlock2", "cardlock1", "cardlock2",
										   "relayboot", "exitboot", "rolledback", "recovered", "resetpending"};
		FakeNvs factory{all}, recovery{all};
		core::clearResetNvsKeys(factory, core::ResetKind::Factory);
		core::clearResetNvsKeys(recovery, core::ResetKind::Recovery);
		// the relays' locked levels survive a factory reset: undriven, a relay pin floats (J11)
		CHECK((factory.keys == std::set<std::string>{"relayboot", "rolledback", "recovered", "resetpending"}));
		CHECK((recovery.keys == std::set<std::string>{"relayboot", "exitboot", "rolledback", "recovered", "resetpending"}));
		FakeNvs empty;
		core::clearResetNvsKeys(empty, core::ResetKind::Factory); // nothing there is fine
		CHECK(empty.keys.empty());
	}
}

static void testMqttGate()
{
	using G = core::MqttGate;
	const char *ip = "192.168.1.50";
	const char *admin[] = {"getuserlist", "deletusers", "deletuid", "adduser", "deletlog", "getconf", "updateconf"};
	const char *doors[] = {"open", "opendoor", "close"};
	// not this device: nothing else is looked at
	CHECK(core::mqttGate(nullptr, ip, "open", true, true, false) == G::NotForThisDevice);
	CHECK(core::mqttGate("192.168.1.5", ip, "open", true, true, false) == G::NotForThisDevice); // a prefix of another
	CHECK(core::mqttGate("192.168.1.500", ip, "open", true, true, false) == G::NotForThisDevice);
	CHECK(core::mqttGate(ip, nullptr, "open", true, true, false) == G::NotForThisDevice);
	CHECK(core::mqttGate(ip, ip, nullptr, true, true, false) == G::NoCommand);
	for (const char *c : admin)
	{
		CHECK(core::mqttRequiresRemoteAdmin(c) && !core::mqttIsDoorCommand(c));
		CHECK(core::mqttGate(ip, ip, c, false, true, false) == G::AdminDisabled);
		CHECK(core::mqttGate(ip, ip, c, true, false, true) == G::Run); // door control and staleness are not theirs
	}
	for (const char *c : doors)
	{
		CHECK(core::mqttIsDoorCommand(c) && !core::mqttRequiresRemoteAdmin(c));
		CHECK(core::mqttGate(ip, ip, c, true, false, false) == G::DoorControlDisabled);
		CHECK(core::mqttGate(ip, ip, c, false, false, true) == G::DoorControlDisabled); // off wins over stale
		CHECK(core::mqttGate(ip, ip, c, false, true, true) == G::Stale);
		CHECK(core::mqttGate(ip, ip, c, false, true, false) == G::Run); // remote admin is not needed
	}
	// case matters, and unknown commands pass (they do nothing)
	CHECK(core::mqttGate(ip, ip, "Open", false, false, true) == G::Run && !core::mqttIsDoorCommand("Open"));
	CHECK(core::mqttGate(ip, ip, "GETCONF", false, false, false) == G::Run && !core::mqttRequiresRemoteAdmin("GETCONF"));
	CHECK(!core::mqttIsDoorCommand(nullptr) && !core::mqttRequiresRemoteAdmin(nullptr));

	// the door of open/close
	DynamicJsonDocument d(256);
	auto door = [&](const char *json) {
		deserializeJson(d, json);
		return core::mqttDoorIndex(d["door"], 2);
	};
	CHECK(door("{\"door\":\"1\"}").index == 1 && door("{\"door\":1}").index == 1);
	CHECK(door("{}").index == 0); // missing: door 0, as upstream
	CHECK(door("{\"door\":2}").index == -1 && door("{\"door\":-1}").index == -1);
	CHECK(door("{\"door\":\"1x\"}").index == -1 && door("{\"door\":\"\"}").index == -1 && door("{\"door\":\"0001\"}").index == -1);
	core::MqttDoor bad = door("{\"door\":\"<script>\"}");
	CHECK(bad.index == -1 && bad.textLen == 8);
}

static void testWsCommandHelpers()
{
	CHECK(core::testRelayIndex("testrelay1") == 0 && core::testRelayIndex("testrelay4") == 3);
	CHECK(core::testRelayIndex("testrelay0") == -1 && core::testRelayIndex("testrelay5") == -1);
	CHECK(core::testRelayIndex("testrelay") == -1 && core::testRelayIndex("testrelay12") == -1 && core::testRelayIndex(nullptr) == -1);
	CHECK(core::testRelayIndex("testrelayx") == -1 && core::testRelayIndex("xtestrelay1") == -1);
	char out[core::MAX_UID_LEN + 1];
	CHECK(core::lowerUid("AbC123", out) && strcmp(out, "abc123") == 0);
	std::string longest(core::MAX_UID_LEN, 'F');
	CHECK(core::lowerUid(longest.c_str(), out) && strlen(out) == core::MAX_UID_LEN && out[0] == 'f');
	// too long (it overran the buffer), not a uid, absent: empty, false
	std::string tooLong(4000, 'A');
	CHECK(!core::lowerUid(tooLong.c_str(), out) && out[0] == '\0');
	CHECK(!core::lowerUid("../config", out) && out[0] == '\0');
	CHECK(!core::lowerUid(nullptr, out) && out[0] == '\0');
	CHECK(!core::lowerUid("", out) && out[0] == '\0');
}

static void testMqttQueue()
{
	// doorip pre-check in the client task: only payloads that can name the IP are queued
	CHECK(core::payloadMayNameIp("{\"cmd\":\"open\",\"door\":0,\"doorip\":\"192.168.1.50\"}", "192.168.1.50"));
	CHECK(!core::payloadMayNameIp("{\"cmd\":\"open\",\"doorip\":\"192.168.1.51\"}", "192.168.1.50"));
	CHECK(!core::payloadMayNameIp(std::string(4000, 'x'), "192.168.1.50"));
	CHECK(!core::payloadMayNameIp("{\"doorip\":\"\"}", "") && !core::payloadMayNameIp("{}", nullptr)); // no IP yet: nothing is for us

	// a retained command is never queued: the broker replays it on every subscribe
	CHECK(core::mqttCommandRefused(true));
	CHECK(!core::mqttCommandRefused(false));

	// a door command is stale after a disconnect, or once older than the limit
	const uint64_t t = WRAP32 + 1000; // and past the old 32-bit wrap
	CHECK(!core::mqttDoorCommandStale(t, 3, t, 3));
	CHECK(!core::mqttDoorCommandStale(t, 3, t + core::MQTT_DOOR_COMMAND_MAX_AGE_MS, 3));
	CHECK(core::mqttDoorCommandStale(t, 3, t + core::MQTT_DOOR_COMMAND_MAX_AGE_MS + 1, 3));
	CHECK(core::mqttDoorCommandStale(t, 3, t + 10, 4)); // queued before the reconnect

	// the byte budget as mqtt.esp uses it: 12 KB, 4 KB per message
	core::ByteBudget budget(12288);
	core::MessageAssembler a(4096, &budget);
	std::string chunk(4096, 'x');
	size_t held[3];
	for (int i = 0; i < 3; i++)
	{
		a.reset(4096);
		CHECK(a.append((const uint8_t *)chunk.data(), chunk.size()));
		CHECK(a.take(&held[i]).size() == 4096 && held[i] == 4096);
	}
	a.reset(4096); // the queue holds 12 KB: the next is refused, not allocated
	CHECK(a.overflowed() && a.refusedByBudget());
	a.take();
	budget.give(held[0]); // loop() processed one
	a.reset(10);
	CHECK(a.append((const uint8_t *)"{\"cmd\":1}", 10));
	size_t c = 0;
	CHECK(a.take(&c).size() == 10);
	budget.give(c);
	budget.give(held[1]);
	budget.give(held[2]);
	CHECK(budget.used() == 0);
}

// ---- live settings (core/livesettings.h) -----------------------------------
// test/vectors/live-settings.json, also run against the web UI's copy
// (policy.js) and the simulator by test/check-live-settings.mjs

// Every Settings field, classed live (copied by copyLiveSettings) or not.
// Appends the names of the fields of that class that differ.
static void settingsDiff(const core::Settings &a, const core::Settings &b, bool live, std::vector<std::string> &out)
{
#define FIELD(isLive, name, same)          \
	do                                     \
	{                                      \
		if ((isLive) == live && !(same))   \
			out.push_back(name);           \
	} while (0)
#define SAMEV(f) (a.f == b.f)
#define SAMES(f) (strcmp(a.f, b.f) == 0)
#define SAMEIP(f) (memcmp(a.f.b, b.f.b, 4) == 0)
	for (int i = 0; i < MAX_READERS; i++)
	{
		std::string r = "readers[" + std::to_string(i) + "].";
		FIELD(false, r + "enabled", SAMEV(readers[i].enabled));
		FIELD(true, r + "door", SAMEV(readers[i].door));
		FIELD(false, r + "d0", SAMEV(readers[i].d0));
		FIELD(false, r + "d1", SAMEV(readers[i].d1));
		FIELD(false, r + "ledPin", SAMEV(readers[i].ledPin));
		FIELD(false, r + "beeperPin", SAMEV(readers[i].beeperPin));
		FIELD(false, r + "feedbackActiveHigh", SAMEV(readers[i].feedbackActiveHigh));
		FIELD(true, r + "direction", SAMEV(readers[i].direction));
	}
	FIELD(false, "readertype", SAMEV(readertype));
	FIELD(true, "pinCodeRequested", SAMEV(pinCodeRequested));
	FIELD(true, "pinCodeOnly", SAMEV(pinCodeOnly));
	FIELD(true, "wiegandReadHex", SAMEV(wiegandReadHex));
	FIELD(true, "removeParityBits", SAMEV(removeParityBits));
	FIELD(false, "numRelays", SAMEV(numRelays));
	for (int i = 0; i < MAX_NUM_RELAYS; i++)
	{
		std::string n = "[" + std::to_string(i) + "]";
		FIELD(false, "relayPin" + n, SAMEV(relayPin[i]));
		FIELD(false, "relayHold" + n, SAMEV(relayHold[i]));
		FIELD(false, "relayUnlock" + n, SAMEV(relayUnlock[i]));
		FIELD(false, "lockType" + n, SAMEV(lockType[i]));
		FIELD(true, "activateTime" + n, SAMEV(activateTime[i]));
		FIELD(true, "doorName" + n, SAMES(doorName[i]));
		FIELD(false, "doorPin" + n, SAMEV(doorPin[i]));
		FIELD(false, "exitPin" + n, SAMEV(exitPin[i]));
	}
	FIELD(false, "accessdeniedpin", SAMEV(accessdeniedpin));
	FIELD(false, "beeperpin", SAMEV(beeperpin));
	FIELD(false, "doorbellpin", SAMEV(doorbellpin));
	FIELD(false, "ledwaitingpin", SAMEV(ledwaitingpin));
	FIELD(false, "wifipin", SAMEV(wifipin));
	FIELD(true, "maxOpenDoorTime", SAMEV(maxOpenDoorTime));
	FIELD(false, "accessPointMode", SAMEV(accessPointMode));
	FIELD(false, "ssid", SAMES(ssid));
	FIELD(false, "wifiPassword", SAMES(wifiPassword));
	FIELD(false, "bssid", memcmp(a.bssid, b.bssid, 6) == 0);
	FIELD(false, "networkHidden", SAMEV(networkHidden));
	FIELD(false, "fallbackMode", SAMEV(fallbackMode));
	FIELD(false, "fallbackPassword", SAMES(fallbackPassword));
	FIELD(false, "dhcpEnabled", SAMEV(dhcpEnabled));
	FIELD(false, "ipAddress", SAMEIP(ipAddress));
	FIELD(false, "subnetIp", SAMEIP(subnetIp));
	FIELD(false, "gatewayIp", SAMEIP(gatewayIp));
	FIELD(false, "dnsIp", SAMEIP(dnsIp));
	FIELD(false, "accessPointIp", SAMEIP(accessPointIp));
	FIELD(false, "accessPointSubnetIp", SAMEIP(accessPointSubnetIp));
	FIELD(true, "wifiIdleOff", SAMEV(wifiIdleOff));
	FIELD(true, "wifiIdleMinutes", SAMEV(wifiIdleMinutes));
	FIELD(false, "deviceHostname", SAMES(deviceHostname));
	FIELD(false, "adminHa1", SAMES(adminHa1));
	FIELD(false, "adminMustChange", SAMEV(adminMustChange));
	FIELD(false, "autoRestartIntervalSeconds", SAMEV(autoRestartIntervalSeconds));
	FIELD(true, "loggingEnabled", SAMEV(loggingEnabled));
	for (int d = 0; d < 7; d++)
		FIELD(true, "openingHours[" + std::to_string(d) + "]", SAMES(openingHours[d]));
	FIELD(false, "ntpServer", SAMES(ntpServer));
	FIELD(false, "ntpInterval", SAMEV(ntpInterval));
	FIELD(true, "tzInfo", SAMES(tzInfo));
	FIELD(false, "rtcType", SAMEV(rtcType));
	FIELD(false, "rtcSda", SAMEV(rtcSda));
	FIELD(false, "rtcScl", SAMEV(rtcScl));
	FIELD(false, "mqttEnabled", SAMEV(mqttEnabled));
	FIELD(false, "mqttHost", SAMES(mqttHost));
	FIELD(false, "mqttPort", SAMEV(mqttPort));
	FIELD(false, "mqttUser", SAMES(mqttUser));
	FIELD(false, "mqttPass", SAMES(mqttPass));
	FIELD(false, "mqttTopic", SAMES(mqttTopic));
	FIELD(false, "mqttAutoTopic", SAMEV(mqttAutoTopic));
	FIELD(true, "mqttInterval", SAMEV(mqttInterval));
	FIELD(true, "mqttEvents", SAMEV(mqttEvents));
	FIELD(false, "mqttHA", SAMEV(mqttHA));
	FIELD(true, "mqttRemoteAdmin", SAMEV(mqttRemoteAdmin));
	FIELD(true, "mqttDoorControl", SAMEV(mqttDoorControl));
	FIELD(true, "mqttCardUid", SAMEV(mqttCardUid));
	FIELD(false, "present", SAMEV(present));
#undef FIELD
#undef SAMEV
#undef SAMES
#undef SAMEIP
}

// A new Settings field must be added to settingsDiff() above, classed live
// or not (and, if live, to copyLiveSettings and LIVE_SETTINGS).
static_assert(sizeof(core::Settings) == 1496, "core::Settings changed: class the new field in settingsDiff() (test/native/tests.cpp)");

static std::string joined(const std::vector<std::string> &v)
{
	std::string s;
	for (const std::string &x : v)
		s += (s.empty() ? "" : ", ") + x;
	return s;
}

static void testLiveSettingsVectors()
{
	FILE *f = fopen("test/vectors/live-settings.json", "rb");
	CHECK(f != nullptr);
	if (!f)
		return;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	DynamicJsonDocument vec(131072);
	CHECK(!deserializeJson(vec, text));
	std::string base;
	serializeJson(vec["base"], base);
	const core::PolicyBoard board = core::policyBoardEsp32();
	std::set<std::string> liveSeen, restartSeen;
	int cases = 0, copies = 0;
	for (JsonObject c : vec["cases"].as<JsonArray>())
	{
		cases++;
		const char *name = c["name"] | "?";
		DynamicJsonDocument before(8192), after(8192);
		deserializeJson(before, base);
		deserializeJson(after, base);
		for (JsonPair kv : c["before"].as<JsonObject>())
			setPath(before.as<JsonObject>(), kv.key().c_str(), kv.value());
		for (JsonPair kv : c["set"].as<JsonObject>())
			setPath(after.as<JsonObject>(), kv.key().c_str(), kv.value());
		if (c["beforeNull"] == true)
			before.clear();
		bool want = c["restart"].as<bool>();
		core::SettingsChange ch = core::compareSettings(before.as<JsonObjectConst>(), after.as<JsonObjectConst>());
		if (ch.restart != want)
			fprintf(stderr, "live vector \"%s\": got %s (%s)\n", name, ch.restart ? "restart" : "live", ch.restartKey.c_str());
		CHECK(ch.restart == want);
		if (strncmp(name, "live: ", 6) == 0 || strncmp(name, "restart: ", 9) == 0) // one key each
		{
			CHECK(c["set"].size() == 1);
			std::string key = c["set"].as<JsonObject>().begin()->key().c_str();
			(want ? restartSeen : liveSeen).insert(key);
			CHECK(ch.changed.size() == 1 && ch.changed[0] == key); // the change is named
		}
		if (c["beforeNull"] == true)
			continue;
		// the copy: from a fresh load of the saved file into the running settings
		static core::Settings running, saved, orig;
		CHECK(core::parseSettings(before.as<JsonObjectConst>(), board, running).problem == nullptr);
		core::SettingsLoad load = core::parseSettings(after.as<JsonObjectConst>(), board, saved);
		if (load.problem != nullptr)
			fprintf(stderr, "live vector \"%s\": saved settings refused at load: %s\n", name, load.problem);
		CHECK(load.problem == nullptr);
		orig = running;
		core::copyLiveSettings(saved, running);
		copies++;
		std::vector<std::string> notLive, live;
		settingsDiff(running, orig, false, notLive);
		if (!notLive.empty())
			fprintf(stderr, "live vector \"%s\": the copy changed settings that are not live: %s\n", name, joined(notLive).c_str());
		CHECK(notLive.empty()); // only live fields are ever written
		if (!want)
		{
			// live: the running settings are now what a restart would load
			std::vector<std::string> d;
			settingsDiff(running, saved, true, d);
			settingsDiff(running, saved, false, d);
			if (!d.empty())
				fprintf(stderr, "live vector \"%s\": after the copy, differs from a fresh load: %s\n", name, joined(d).c_str());
			CHECK(d.empty());
		}
	}
	// every live key has a live case of its own, and nothing else does
	for (const char *k : core::LIVE_SETTINGS)
	{
		if (!liveSeen.count(k))
			fprintf(stderr, "live key %s has no single-key vector\n", k);
		CHECK(liveSeen.count(k) == 1);
	}
	CHECK(liveSeen.size() == sizeof(core::LIVE_SETTINGS) / sizeof(core::LIVE_SETTINGS[0]));
	// every other key of the base has a restart case
	std::vector<std::string> baseKeys;
	std::function<void(JsonObjectConst, const std::string &)> walk = [&](JsonObjectConst o, const std::string &p) {
		for (JsonPairConst kv : o)
		{
			std::string k = p.empty() ? kv.key().c_str() : p + "." + kv.key().c_str();
			if (kv.value().is<JsonObjectConst>())
				walk(kv.value().as<JsonObjectConst>(), k);
			else if (k != "command")
				baseKeys.push_back(k);
		}
	};
	walk(vec["base"].as<JsonObjectConst>(), "");
	for (const std::string &k : baseKeys)
		if (!core::isLiveSetting(k))
		{
			if (!restartSeen.count(k))
				fprintf(stderr, "restart key %s has no single-key vector\n", k.c_str());
			CHECK(restartSeen.count(k) == 1);
		}
	printf("live settings: %d shared vectors, %d copies checked\n", cases, copies);
	CHECK(cases >= 90);
}

static void testLiveSettingsCopy()
{
	// copyLiveSettings writes the live fields and nothing else: from a
	// Settings where every field differs from the running one
	static core::Settings running, from, orig;
	running = core::Settings();
	from = core::Settings();
	for (int i = 0; i < MAX_READERS; i++)
	{
		from.readers[i] = {true, 3, 40, 41, 42, 43, false, core::READER_DIR_OUT};
	}
	from.readertype = READER_WIEGAND;
	from.pinCodeRequested = true;
	from.pinCodeOnly = true;
	from.wiegandReadHex = false;
	from.removeParityBits = false;
	from.numRelays = 4;
	for (int i = 0; i < MAX_NUM_RELAYS; i++)
	{
		from.relayPin[i] = 20 + i;
		from.relayHold[i] = 1;
		from.relayUnlock[i] = 0;
		from.lockType[i] = LOCKTYPE_CONTINUOUS;
		from.activateTime[i] = 9000 + i;
		snprintf(from.doorName[i], sizeof(from.doorName[i]), "Door %c", 'A' + i);
		from.doorPin[i] = 30 + i;
		from.exitPin[i] = 35 + i;
	}
	from.accessdeniedpin = from.beeperpin = from.doorbellpin = from.ledwaitingpin = from.wifipin = 2;
	from.maxOpenDoorTime = 99;
	from.accessPointMode = from.networkHidden = from.fallbackMode = true;
	strcpy(from.ssid, "other");
	strcpy(from.wifiPassword, "other-pass");
	from.bssid[0] = 1;
	strcpy(from.fallbackPassword, "fallback");
	from.dhcpEnabled = false;
	from.ipAddress.parse("10.0.0.2");
	from.subnetIp.parse("255.0.0.0");
	from.gatewayIp.parse("10.0.0.1");
	from.dnsIp.parse("10.0.0.3");
	from.accessPointIp.parse("10.1.0.1");
	from.accessPointSubnetIp.parse("255.255.0.0");
	from.wifiIdleOff = true;
	from.wifiIdleMinutes = 77;
	strcpy(from.deviceHostname, "other-host");
	strcpy(from.adminHa1, "00000000000000000000000000000000");
	from.adminMustChange = false;
	from.autoRestartIntervalSeconds = 3600;
	from.loggingEnabled = false;
	for (int d = 0; d < 7; d++)
		strcpy(from.openingHours[d], "000000000000000000000000");
	strcpy(from.ntpServer, "time.example");
	from.ntpInterval = 5;
	strcpy(from.tzInfo, "CET-1CEST,M3.5.0,M10.5.0/3");
	from.rtcType = core::RTC_DS1307;
	from.rtcSda = 18;
	from.rtcScl = 19;
	from.mqttEnabled = from.mqttAutoTopic = from.mqttEvents = from.mqttHA = from.mqttRemoteAdmin = from.mqttDoorControl = true;
	strcpy(from.mqttHost, "h");
	from.mqttPort = 1;
	strcpy(from.mqttUser, "u");
	strcpy(from.mqttPass, "p");
	strcpy(from.mqttTopic, "t");
	from.mqttInterval = 1;
	from.mqttCardUid = core::MQTT_UID_FULL;
	from.present = false;
	running.present = true;
	orig = running;
	// the test itself: every field above differs from the defaults
	std::vector<std::string> all;
	settingsDiff(from, running, true, all);
	settingsDiff(from, running, false, all);
	CHECK(all.size() == 108); // every field of Settings
	core::copyLiveSettings(from, running);
	std::vector<std::string> notLive, live;
	settingsDiff(running, orig, false, notLive);
	if (!notLive.empty())
		fprintf(stderr, "copyLiveSettings wrote settings that are not live: %s\n", joined(notLive).c_str());
	CHECK(notLive.empty());
	settingsDiff(running, from, true, live);
	if (!live.empty())
		fprintf(stderr, "copyLiveSettings missed live settings: %s\n", joined(live).c_str());
	CHECK(live.empty());

	// the comparison as the UI makes it
	DynamicJsonDocument a(1024), b(1024);
	deserializeJson(a, "{\"command\":\"configfile\",\"hardware\":{\"rpin\":16,\"doorname\":\"Front\"}}");
	deserializeJson(b, "{\"command\":\"x\",\"hardware\":{\"rpin\":\"16\",\"doorname\":\"Front\"}}");
	core::SettingsChange c = core::compareSettings(a.as<JsonObjectConst>(), b.as<JsonObjectConst>());
	CHECK(!c.restart && c.changed.empty() && core::changedList(c).empty());
	b["hardware"]["doorname"] = "Back";
	b["general"]["logging"] = 0;
	c = core::compareSettings(a.as<JsonObjectConst>(), b.as<JsonObjectConst>());
	CHECK(!c.restart && c.changed.size() == 2 && core::changedList(c) == "hardware.doorname, general.logging");
	b["hardware"]["rpin"] = 17;
	c = core::compareSettings(a.as<JsonObjectConst>(), b.as<JsonObjectConst>());
	CHECK(c.restart && c.restartKey == "hardware.rpin" && c.changed.size() == 3);
	CHECK(core::changedList(c, 30) == "hardware.rpin, ...");
	CHECK(core::compareSettings(JsonObjectConst(), b.as<JsonObjectConst>()).restart);
	CHECK(core::isLiveSetting("hardware.relay4.rtime") && !core::isLiveSetting("hardware.relay4.rpin") && !core::isLiveSetting("hardware"));
}

int main()
{
	testValidators();
	testAssembler();
	testMqttQueue();
	testMqttGate();
	testWsCommandHelpers();
	testRelayTimers();
	testRelockDeadline();
	testWifiEnable();
	testWsAlive();
	testStorageSpace();
	testWifiIdleOff();
	testWifiLinkState();
	testMemGuard();
	testRemoveAllUserFiles();
	testUserIndex();
	testFirmwareConfirm();
	testUpdateImageHead();
	testLimiterAndSessions();
	testNoncesAndRevoke();
	testWiegand();
	testAccess();
	testAccessTypeName();
	testPin();
	testPinLockout();
	testUserFiles();
	testJsonRecover();
	testUserRecordVectors();
	testRelayTime();
	testRelays();
	testRestartGate();
	testRelayBoot();
	testExitBoot();
	testRelayHold();
	testDoorMonitor();
	testDoorbell();
	testExitButton();
	testReader();
	testUnknownCooldown();
	testPinOnlyLockout();
	testConfigPolicyVectors();
	testImageHeadVectors();
	testRemoteAdminVectors();
	testLiveSettingsVectors();
	testLiveSettingsCopy();
	testSettings();
	testRtc();
	testFeedbackPinsJson();
	testSecrets();
	testAdminPassword();
	testStepUp();
	testLogPager();
	testRotation();
	printf("%d checks, %d failures\n", checks, failures);
	// Floor just under the count when last raised (6447): a test that silently stops
	// running (an early return, a dropped call above) fails the gate. Raise it with new tests.
	const int minChecks = 6400;
	if (checks < minChecks)
		printf("only %d checks ran, expected at least %d\n", checks, minChecks);
	if (failures == 0 && checks >= minChecks)
	{
		printf("ALL NATIVE TESTS PASSED\n");
		return 0;
	}
	return 1;
}
