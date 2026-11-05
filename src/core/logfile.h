// Log paging and rotation, written against a minimal file/filesystem
// interface so the exact firmware code is exercised by host tests.
//
// Paging is stateless: the browser sends the byte offset it wants and gets the
// next offset back. Upstream kept one global offset for every log and every
// browser tab, so two readers (or the event and access log views) corrupted
// each other's pages.
#pragma once

#include <ArduinoJson.h>
#include <cstddef>
#include <cstdio>

namespace core
{

static const size_t LOG_LINE_MAX = 512; // longer lines are truncated

struct LogPage
{
	size_t nextPos = 0;
	size_t count = 0;
	bool eof = true;
};

// F must provide: bool seek(size_t), size_t position(), int read() (-1 at EOF).
// Reads up to maxItems non-empty lines starting at pos into items. Stops early
// (without losing the line) if the JSON document runs out of memory, so a page
// never silently drops entries the way the fixed 2 KB upstream page did.
template <class F>
LogPage readLogPage(F &file, size_t pos, size_t maxItems, JsonArray items, JsonDocument &doc)
{
	LogPage page;
	page.nextPos = pos;
	if (!file.seek(pos))
		return page;
	char line[LOG_LINE_MAX + 1];
	while (page.count < maxItems)
	{
		size_t lineStart = file.position();
		size_t n = 0;
		int c;
		bool sawAny = false;
		while ((c = file.read()) >= 0)
		{
			sawAny = true;
			if (c == '\n')
				break;
			if (c == '\r')
				continue;
			if (n < LOG_LINE_MAX)
				line[n++] = (char)c;
		}
		if (!sawAny)
		{
			page.eof = true;
			page.nextPos = lineStart;
			return page;
		}
		line[n] = '\0';
		if (n == 0)
		{
			page.nextPos = file.position();
			continue; // blank line
		}
		bool added = items.add((char *)line); // char* => copied into doc
		if (!added || doc.overflowed())
		{
			// a failed add can leave a null slot behind; drop it
			if (items.size() > page.count)
				items.remove(items.size() - 1);
			page.eof = false;
			page.nextPos = lineStart;
			return page;
		}
		page.count++;
		page.nextPos = file.position();
	}
	// Peek: is there anything (non-empty) left?
	page.eof = true;
	int c;
	while ((c = file.read()) >= 0)
	{
		if (c != '\n' && c != '\r')
		{
			page.eof = false;
			break;
		}
	}
	return page;
}

// FS must provide: bool exists(const char*), bool remove(const char*),
// bool rename(const char*, const char*).
// Shifts base -> base.1 -> base.2 ... keeping `keep` rotated files; the oldest
// one (base.keep) is deleted.
template <class FS>
void rotateLog(FS &fs, const char *base, int keep)
{
	char from[48], to[48];
	snprintf(to, sizeof(to), "%s.%d", base, keep);
	if (fs.exists(to))
		fs.remove(to);
	for (int i = keep - 1; i >= 1; i--)
	{
		snprintf(from, sizeof(from), "%s.%d", base, i);
		snprintf(to, sizeof(to), "%s.%d", base, i + 1);
		if (fs.exists(from))
			fs.rename(from, to);
	}
	snprintf(to, sizeof(to), "%s.1", base);
	if (fs.exists(base))
		fs.rename(base, to);
}

} // namespace core
