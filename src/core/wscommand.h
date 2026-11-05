// Decisions of the WebSocket command handlers (websocket.esp), pure so they
// are tested on the host. The command table itself stays in websocket.esp
// (test/check-protocol.mjs reads it).
#pragma once

#include <cctype>
#include <cstring>

#include "core/validate.h"

namespace core
{

// testrelay1 .. testrelay4 -> relay 0..3; anything else -1.
inline int testRelayIndex(const char *command)
{
	if (command == nullptr || strncmp(command, "testrelay", 9) != 0)
		return -1;
	char n = command[9];
	if (n < '1' || n > '4' || command[10] != '\0')
		return -1;
	return n - '1';
}

// A uid from a command, lower-cased as the user files are named (/P/<uid>).
// False, and out empty, unless it is a valid uid. userfile copied
// "replaces" with no length check into a 33-byte stack buffer: a longer
// value from a signed-in page overran it. An invalid one now counts as
// absent (no rename), which is what it already did when it fitted.
inline bool lowerUid(const char *in, char (&out)[MAX_UID_LEN + 1])
{
	out[0] = '\0';
	if (!isValidUid(in))
		return false;
	size_t n = strlen(in);
	for (size_t i = 0; i < n; i++)
		out[i] = (char)tolower((unsigned char)in[i]);
	out[n] = '\0';
	return true;
}

} // namespace core
