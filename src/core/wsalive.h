// Is a page's WebSocket still there? A page whose device left without
// closing it (out of range, Wi-Fi off, laptop moved to another network)
// leaves a socket that still reads as connected, and Wi-Fi idle-off counts
// connected sockets as "someone connected" (wifiAnyoneConnected). The board
// pings a quiet socket (a browser answers a ping with a pong by itself, no
// page code) and closes one it has heard nothing from for a while. Pure, so
// it is tested on the host; websocket.esp acts on it.
//
// The library's own keepalive (keepAlivePeriod, closed by AsyncTCP's ack
// timeout) did not close such a socket on the board: it still read as
// connected 6 minutes after the laptop left (bench run, ledger H25).
#pragma once

#include <cstdint>

namespace core
{

static const uint64_t WS_PING_AFTER_MS = 30000;   // quiet this long: ping it, then again every 30 s
static const uint64_t WS_SILENT_CLOSE_MS = 90000; // nothing heard this long (three pings unanswered): close it

enum class WsAlive
{
	Fine,
	Ping,
	Close
};

// lastHeard: when it connected, or last sent anything (a message or a pong);
// lastPing: when the board last pinged it (0 = never). Uptime milliseconds.
inline WsAlive wsAlive(uint64_t now, uint64_t lastHeard, uint64_t lastPing)
{
	if (now < lastHeard)
		return WsAlive::Fine; // heard "after now": a stamp from another task, just set
	uint64_t quiet = now - lastHeard;
	if (quiet >= WS_SILENT_CLOSE_MS)
		return WsAlive::Close;
	if (quiet < WS_PING_AFTER_MS)
		return WsAlive::Fine;
	// quiet: one ping per 30 s, counted from the last one sent since it was heard
	if (lastPing > lastHeard && now - lastPing < WS_PING_AFTER_MS)
		return WsAlive::Fine;
	return WsAlive::Ping;
}

} // namespace core
