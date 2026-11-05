// The MQTT command queue (mqtt.esp): the MQTT client task copies each
// command in, loop() acts on it. Pure, so it is unit-tested on the host.
#pragma once

#include <ArduinoJson.h>
#include <cstdint>
#include <cstring>
#include <string>

#include "core/validate.h"

namespace core
{

// A door command (open, opendoor, close) older than this when loop() reaches
// it is dropped: a stale unlock must not run long after it was sent.
static const uint64_t MQTT_DOOR_COMMAND_MAX_AGE_MS = 5000;

// Cheap check in the client task, before a command is queued: every command
// must name this device's IP as doorip, so a payload that does not even
// contain the IP text cannot be for us. A "yes" is only a maybe: the exact
// doorip check runs after parsing.
inline bool payloadMayNameIp(const std::string &payload, const char *ip)
{
	return ip != nullptr && *ip != '\0' && payload.find(ip) != std::string::npos;
}

// A retained message on the command topic is refused: the broker replays it
// to every new subscription, so it would run again after each reconnect.
inline bool mqttCommandRefused(bool retained)
{
	return retained;
}

// A queued door command is stale if the connection it came on has dropped
// since (link: a count of disconnects) or it is older than the limit.
inline bool mqttDoorCommandStale(uint64_t queuedAtMs, uint32_t queuedLink, uint64_t nowMs, uint32_t link)
{
	return queuedLink != link || nowMs - queuedAtMs > MQTT_DOOR_COMMAND_MAX_AGE_MS;
}

// open, opendoor and close: MQTT door control (mqtt.doorcontrol) must be on.
inline bool mqttIsDoorCommand(const char *command)
{
	return command != nullptr && (strcmp(command, "open") == 0 || strcmp(command, "opendoor") == 0 || strcmp(command, "close") == 0);
}

// The user and settings commands: MQTT remote admin (mqtt.remoteadmin) must be on.
inline bool mqttRequiresRemoteAdmin(const char *command)
{
	if (command == nullptr)
		return false;
	const char *adminCommands[] = {"getuserlist", "deletusers", "deletuid", "adduser", "deletlog", "getconf", "updateconf"};
	for (const char *c : adminCommands)
		if (strcmp(command, c) == 0)
			return true;
	return false;
}

// What processMqttMessage() does with a parsed command before acting on it,
// checked in this order. Run also covers commands it does not know (they do
// nothing).
enum class MqttGate
{
	Run,
	NotForThisDevice,    // doorip missing or another device's: silently ignored
	NoCommand,           // no cmd key
	AdminDisabled,       // a remote-admin command with remote admin off (logged)
	DoorControlDisabled, // a door command with door control off (logged once per boot)
	Stale,               // a door command from before a reconnect or too old (logged)
};

// stale: mqttDoorCommandStale() for this message (used for door commands only).
inline MqttGate mqttGate(const char *doorip, const char *deviceIp, const char *command, bool remoteAdmin, bool doorControl, bool stale)
{
	if (doorip == nullptr || deviceIp == nullptr || strcmp(doorip, deviceIp) != 0)
		return MqttGate::NotForThisDevice;
	if (command == nullptr)
		return MqttGate::NoCommand;
	if (mqttRequiresRemoteAdmin(command) && !remoteAdmin)
		return MqttGate::AdminDisabled;
	if (mqttIsDoorCommand(command) && !doorControl)
		return MqttGate::DoorControlDisabled;
	if (mqttIsDoorCommand(command) && stale)
		return MqttGate::Stale;
	return MqttGate::Run;
}

// The door of an open/close command: "door" as text ("0") or a number (0);
// missing is door 0, as upstream. -1 unless it names a door below numRelays
// (parseRelayIndex). textLen: the length of the text it was read from, for
// the log (the value itself is the sender's and never logged).
struct MqttDoor
{
	int index;
	size_t textLen;
};

inline MqttDoor mqttDoorIndex(JsonVariantConst door, int numRelays)
{
	std::string text = door.is<const char *>() ? std::string(door.as<const char *>()) : std::to_string(door | 0);
	return {parseRelayIndex(text.c_str(), numRelays), text.size()};
}

} // namespace core
