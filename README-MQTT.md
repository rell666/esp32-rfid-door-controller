# Ironframe RFID: MQTT

Ironframe RFID runs on the ESP32-S3 and the original ESP32 (see [README-IRONFRAME.md](README-IRONFRAME.md#hardware)). Over MQTT it can:
* send access messages, alarms, a heartbeat and, if you choose, the event log
* report door, tamper, doorbell and lock states to Home Assistant, with discovery
* open and lock doors (MQTT door control, off by default)
* list, add and delete users, clear the logs, and read or change the settings (MQTT remote admin, off by default)

## Broker settings
You can add all the broker details in the web UI (MQTT page).

## Using MQTT Topics
For the MQTT communication some additional TOPICs have been added internally. The default Topic is configured in the web UI. If you use more then one device, every device should have the same `TOPIC` name configured. All MQTT communication is done with JSON Payload as MQTT Message.

The topics under `TOPIC`:

```
TOPIC---+---/send     messages from the device: access, alarms, acknowledgments, events
        +---/cmd      commands to the device
        +---/tag      access messages instead of /send (MQTT for Home Assistant on)
        +---/avty     online / offline, retained (MQTT for Home Assistant on)
        +---/io/...   door, tamper, doorbell and lock states (MQTT for Home Assistant on)
```

For example, with `TOPIC` = `/rfid` the device publishes on `/rfid/send` and listens on `/rfid/cmd`. Home Assistant discovery configs go to `homeassistant/...` (see [Home Assistant messages](#home-assistant-messages)).

### Auto-topic

With Auto topic on, the device adds `-` and the last 6 hex digits of its access point (softAP) MAC address to the topic, for example `/rfid-a1b2c3`. The MQTT page shows it as `TOPIC-xxxxxx`.

This can be useful to deploy a batch of esp-rfid in one go. By knowing the MAC addresses in advance you can setup them all with a standard configuration and each one will talk on a separate topic.

## Commands received by ESP-RFID
The message format is JSON.

The message has to include the IP of the device together with one of the supported commands.

The commands should be sent to the `TOPIC/cmd` and the responses will be sent on  the topic `TOPIC/send`.

**Send commands with retain off.** A retained message on `TOPIC/cmd` is dropped and logged ("Dropped a retained MQTT command"): the broker replays a retained message on every subscribe, so a retained `opendoor` would open the door after every reconnect or restart. To clear one left on the broker, publish an empty retained message to `TOPIC/cmd`.

### Remote admin
**Needs MQTT remote admin** (MQTT settings, off by default): without it `getuserlist`, `adduser`, `deletuid`, `deletusers`, `deletlog`, `getconf` and `updateconf` are refused and logged ("Refused MQTT admin command"). Anyone who can publish to `TOPIC/cmd` gets these commands when it is on (the only other check is `doorip`, which the device publishes itself), so use broker authentication and ACLs.

Since Ironframe 1.4.2 remote admin cannot do everything the web page can:

* `adduser` refuses a user with access 99 (admin) on any door: nothing is stored, there is no acknowledgment and the event log says "adduser refused". Add admin cards from the web page.
* `updateconf` cannot change the settings that guard the doors or the device itself. Whatever the update says, these keep their stored values:
  * the Wi-Fi settings: the whole `network` section (network, password, BSSID, access point, addresses, fallback hotspot password);
  * the admin password (`general.pswd`; only Change Password on the web page sets it);
  * the broker connection and where commands come from: `mqtt.enabled`, `mqtt.host`, `mqtt.port`, `mqtt.user`, `mqtt.pswd`, `mqtt.topic`, `mqtt.autotopic`;
  * MQTT remote admin and MQTT door control (`mqtt.remoteadmin`, `mqtt.doorcontrol`);
  * Require pin code after RFID card and Allow pin code only (`hardware.requirepincodeafterrfid`, `hardware.allowpincodeonly`);
  * the reader type, the number of relays and the held-open alarm time (`hardware.readertype`, `hardware.numrelays`, `hardware.maxOpenDoorTime`);
  * every pin, and each relay's type, "when the relay is on, the door is" (`rhold`), lock type and activate time, for all four relays;
  * the reader blocks `hardware.reader1` and `hardware.reader2` (door, pins, direction, enabled);
  * the real-time clock module `ntp.rtc` (type and pins).

  Everything else it still changes: host name, door names, opening hours, automatic restart, logging, NTP and time zone, MQTT sync interval, MQTT logging, Home Assistant discovery, Card number in MQTT and the UID format (`useridstoragemode`, `removeparitybits`). A kept setting the update leaves out keeps its value too (until 1.4.2 a partial update dropped it). The acknowledgment lists in `ignored` each key the update tried to change, and the event log names them ("updateconf: kept the stored values of settings remote admin cannot change").

  The exact list (`REMOTE_ADMIN_KEPT` in `src/core/configpolicy.h`; a section name covers every key in it; `test/check-docs.mjs` checks this block against the firmware):

```remote-admin-kept
network
general.pswd
mqtt.enabled
mqtt.host
mqtt.port
mqtt.user
mqtt.pswd
mqtt.topic
mqtt.autotopic
mqtt.remoteadmin
mqtt.doorcontrol
hardware.requirepincodeafterrfid
hardware.allowpincodeonly
hardware.readertype
hardware.numrelays
hardware.maxOpenDoorTime
hardware.wgd0pin
hardware.wgd1pin
hardware.wifipin
hardware.doorstatpin
hardware.doorbellpin
hardware.openlockpin
hardware.accessdeniedpin
hardware.beeperpin
hardware.ledwaitingpin
hardware.rpin
hardware.rtype
hardware.rhold
hardware.ltype
hardware.rtime
hardware.relay2.rpin
hardware.relay2.rtype
hardware.relay2.rhold
hardware.relay2.ltype
hardware.relay2.rtime
hardware.relay2.doorstatpin
hardware.relay2.openlockpin
hardware.relay3.rpin
hardware.relay3.rtype
hardware.relay3.rhold
hardware.relay3.ltype
hardware.relay3.rtime
hardware.relay3.doorstatpin
hardware.relay3.openlockpin
hardware.relay4.rpin
hardware.relay4.rtype
hardware.relay4.rhold
hardware.relay4.ltype
hardware.relay4.rtime
hardware.relay4.doorstatpin
hardware.relay4.openlockpin
hardware.reader1
hardware.reader2
ntp.rtc
```

### Get all the users
When sending the following command:
```
{
   "cmd":"getuserlist",
   "doorip":"(The ESP-RFID IP address as String)"
}
```

A list of messages like the following will be sent, one for each user:
```
{
    "command": "userfile",
    "uid": "04a1b2c3",
    "user": "User Name",
    "acctype": 1,
    "acctype2": 0,
    "acctype3": 0,
    "acctype4": 0,
    "validsince": 0,
    "validuntil": 1608336000,
    "haspin": true
}
```
No PIN is sent: `haspin` says whether the user has one. A PIN-only user (whose uid is the PIN) is sent with `"uid": "keypad"` and `"keypad": true`. Until Ironframe 1.4.0 each user file went out whole, PIN included. A record stored before 1.4.0 without `acctype2` to `acctype4` sends them as `null`.

### Open door
**Needs MQTT door control** (MQTT settings, off by default since Ironframe 1.4.0). With it off, `opendoor`, `open` and `close` are ignored (logged once until the next restart) and Home Assistant gets no lock entities. Anyone who can publish to `TOPIC/cmd` can open the doors when it is on: the only other check is `doorip`, which the device publishes itself, so use broker authentication and ACLs.

A door command still waiting in the device's queue after 5 seconds, or queued before a reconnect, is dropped and logged ("Dropped a stale MQTT door command").

#### opendoor
Opens every door whose lock is locked at the time. A door already open (a continuous relay held open, or a momentary one mid-pulse) is left as it is; until Ironframe 1.4.0 a held-open continuous relay was toggled shut.

Command:
```
{
    "cmd":"opendoor",
    "doorip":"(The ESP-RFID IP of the door to open as String)"
}
```

The answer is an [access message](#publish-access) with `"username":"MQTT"`, `"access":"Always"` and `"uid":" "`.

#### open and close
`open` opens one door; `close` locks it again at once. `door` is the door number counted from 0 (0 = door 1), as a number or a string; without `door` it is door 1. Home Assistant's lock entities send these.

Command:
```
{
    "cmd":"open",
    "door":0,
    "doorip":"(The ESP-RFID IP address as String)"
}
```

`open` opens the door only if its lock is locked, and answers with an access message as `opendoor` does, plus `door`. `close` stops the door's relay timer and, if the relay is at its unlock level, switches it back and publishes `LOCKED` on `TOPIC/io/lock<n>` (with MQTT for Home Assistant on); it sends no access message. A `door` that is not a door on this device is ignored and logged ("Invalid door index"); a door with no relay pin is ignored.

### Delete user
Delete a single user by UID.

Command:
```
{
     "cmd":"deletuid",
     "doorip":"(The ESP-RFID IP address as String)",
     "uid":"(The UID of the user to delete as String)"
}
```

Response will be an acknowledgment to let the other party know that the message was processed. `result` is `false`, with a `message`, if the uid is invalid (WARN event "deletuid refused") or the user could not be removed (ERRO event; the user is then still on the device):
```
{
  "type":"deletuid",
  "result":true,
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

### Delete all users
Delete all user files.

Command:
```
{
     "cmd":"deletusers",
     "doorip":"(The ESP-RFID IP address as String)"
}
```

Response will be an acknowledgment to let the other party know that the message was processed. `result` is `false` (with a `message`, and an ERRO event in the log) if any user could not be removed; those users are then still on the device:
```
{
  "type":"deletusers",
  "result":true,
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

### Add user
Adds a user as a file to the device.

Command:
```
{
     "cmd":"adduser",
     "doorip":"(The ESP-RFID IP address as String)",
     "uid": "(The card number as String; for a PIN-only user, the PIN)",
     "user": "(User Name as String)",
     "acctype": "1",
     "validsince": "0",
     "validuntil": "1608466200"
}
```
* _acctype_ (door 1)
  * 0 = Disabled
  * 1 = Always
  * 99 (Admin) is refused over MQTT: add admin cards from the web page.

* _validsince_
  * User valid since date/time as Unix epoch timestamp
  * Can send calculations based on now:
    * ```validsince: {{ (as_timestamp(now()) + (2*24*3600)) }}```

* _validuntil_
  * Expiration date/time as Unix epoch timestamp (required)
  * Can send calculations based on now:
    * ```validuntil: {{ (as_timestamp(now()) + (2*24*3600)) }}```

* _pincode_ (optional): 4-12 digits, as a string. _acctype2_ to _acctype4_ (optional, doors 2-4): 0 or 1; missing is 0.

Since Ironframe 1.4.0 the device checks the record (these values, a name of at most 64 bytes, a uid of 1-32 letters and digits) and stores only these keys, the uid in lower case. A refused record is not stored and gets no acknowledgment; the event log says why ("adduser refused"). Since 1.4.2 a record with access 99 (admin) on any door is refused too (see [Remote admin](#remote-admin)). `adduser` replaces the whole record: a user sent again without `pincode` loses their PIN. If the record cannot be written there is no acknowledgment either, and the event log says "adduser write failed".

Response will be an acknowledgment to let the other party know that the message was processed:
```
{
  "type":"adduser",
  "result":true,
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

### Delete logs
Deletes the event log (`/eventlog.json`) and the older access log file (`/latestlog.json.1`), then rolls the current access log over. Home Assistant's Delete Log button sends this command.

Command:
```
{
     "cmd":"deletlog",
     "doorip":"(The ESP-RFID IP address as String)"
}
```

Response:
```
{
  "type":"deletlog",
  "result":true,
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

### Get configuration
Get the global configuration.

Command:
```
{
     "cmd":"getconf",
     "doorip":"(The ESP-RFID IP address as String)"
}
```

Response will be an object with a `configfile` key which holds the entire configuration object. The same object that you can download from the "Backup & Restore" section.
```
{
  "type":"getconf",
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname",
  "configfile": {
    // the entire configuration object
  }
}
```

### Update configuration
Update the global configuration. You can pass a configuration object, which will be used as the new configuration, except for the settings remote admin cannot change (see [Remote admin](#remote-admin)): those keep their stored values. Passwords sent as `********` (as `getconf` sends them) keep the stored ones. Then the system will restart to load the new configuration.

Command:
```
{
     "cmd":"updateconf",
     "doorip":"(The ESP-RFID IP address as String)",
     "configfile": {
      // the entire configuration object
     }
}
```

Response will be an acknowledgment to let the other party know that the message was processed. `ignored` lists the keys the update tried to change that kept their stored values (empty if none):
```
{
  "type":"updateconf",
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname",
  "ignored":["mqtt.doorcontrol","network.ssid"]
}
```

A refused update (settings the device would not accept, or stored settings it could not read) is not saved and gets no acknowledgment; the event log says why ("updateconf refused").

Then the system will automatically restart to use the new configuration.

## Messages sent by ESP-RFID
ESP-RFID sends a set of MQTT messages for the most significant actions that it does, plus can be configured to send all the logs over MQTT, instead of keeping them locally.

The messages below are sent on `TOPIC/send`, except that with MQTT for Home Assistant on, access messages go to `TOPIC/tag` instead (see [Home Assistant messages](#home-assistant-messages)).

### Base messages

#### Boot
Sent each time the device connects to the broker: after a restart and after a reconnect.

```
{
  "type":"boot",
  "time":1605987212,
  "uptime":"0",
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

#### Heartbeat
Every X seconds ESP-RFID sends a heartbeat over MQTT. The interval can be customised in the web UI, the default is 180 seconds.

```
{
  "type":"heartbeat",
  "time":1605991375,
  "uptime":999,
  "ip":"192.168.1.xxx",
  "hostname":"your esp-rfid hostname"
}
```

#### Publish Access
When a RFID token is detected a set of messages can be sent, depending on the presence of the token UID in the database.

**The card number (`uid`) depends on Card number in MQTT** (MQTT settings page, `mqtt.carduid` in the configuration): **Last 4** (`1`, the default) sends `"uid":"****c3d4"` (four `*` and the last 4 characters of the uid as stored; a uid of 4 characters or fewer is `"****"`), **Full** (`2`) sends the whole card number, **Off** (`0`) sends no `uid` field at all. A keypad entry is `"uid":"keypad"`, and an exit button or MQTT open `" "`, whatever the setting (Off: no `uid`). **Behaviour change in Ironframe 1.4.2:** every access message sent the full card number, which is all someone reading the topic needs to clone the card; settings saved before 1.4.2 have no `carduid` and get Last 4, so **Home Assistant automations or other consumers that match on the full uid stop matching until Card number in MQTT is set to Full**. The remote-admin user list (`getuserlist`) still sends the full uid. The examples below show `"token UID"`.

No access message carries a PIN: upstream sent the user's `pincode` with every access, Ironframe 1.2.0 removed it. A message may also carry `door` (a message for one door: 0 = door 1), `direction` (`"in"` or `"out"`, from a reader set to In or Out) and, with MQTT logging on, `"cmd":"log"`.

Card number in MQTT covers access messages only. With MQTT logging on, the event log goes to MQTT as written, and these events carry the full card number in `data`: "Unknown rfid tag is scanned", "Wrong PIN", "Card refused: PIN required, user has no PIN" and "Card not checked: not enough memory, try again".

`access` is one of:

* `Admin`: an admin user, let in
* `Always`: let in
* `Disabled`: no access on this door, or outside the opening hours
* `Expired`: outside the user's valid dates
* `Wrong pin code`: the PIN was wrong
* `No PIN`: a PIN is required after the card and the user has none
* `Clock not set`: the user has dates or opening hours and the clock is not set yet
* `Keypad locked`: see [Alarm](#alarm)
* `Busy`: the card or PIN could not be checked (not enough memory); try again
* `Denied`: an unknown card or PIN

`isKnown` is `"false"` for an unknown card, a keypad entry and `Busy`.

```
{
  "type":"access",
  "time":1605991375,
  "isKnown":"true",
  "access":"the access state",
  "username":"username",
  "uid":"token UID",
  "hostname":"your esp-rfid hostname",
  "doorName":"your door name"
}
```
If instead the UID is not present in the users list the message will be:

```
{
  "type":"access",
  "time":1605991375,
  "isKnown":"false",
  "access":"Denied",
  "username":"Unknown",
  "uid":"token UID",
  "hostname":"your esp-rfid hostname",
  "doorName":"your door name"
}
```

With MQTT logging on, an unknown card also writes this event (see [Log messages](#log-messages)). `data` is the full card number, the reader type and, for a reader bound to one door, the door:

```
{
  "type":"WARN",
  "src":"rfid",
  "desc":"Unknown rfid tag is scanned",
  "data":"(card number) (reader type) at (door name)",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

At a reader that opens every door (no single door chosen) with two or more doors, a granted access carries arrays instead: `access` holds the user's access on each door (`Always`, `Disabled` or `Admin`) and `doorName` each door's name, with no `door`. A refused card at such a reader gets the single-value message above.

```
{
  "type":"access",
  "time":1605991375,
  "isKnown":"true",
  "access":["Always", "Disabled"],
  "username":"username",
  "uid":"token UID",
  "hostname":"your esp-rfid hostname",
  "doorName":["door 1", "door 2"]
}
```

#### Alarm
Sent whatever the MQTT logging setting is, when 10 unknown cards are read at one reader (`"desc":"Unknown cards at reader"`; valid cards still open), or a keypad starts refusing every PIN after 5 wrong PINs (`"desc":"Keypad locked out"`, Ironframe 1.4.1). Up to Ironframe 1.4.2 the unknown cards locked the reader for every card instead (`"desc":"Card reader locked out"`); see the change log.

```
{
  "type":"alarm",
  "src":"rfid",
  "desc":"Unknown cards at reader",
  "data":"reader 1 at Front: 10 unknown cards; valid cards still open (alarm quiet for 30 s)",
  "time":1605991375,
  "hostname":"your esp-rfid hostname"
}
```

While a keypad lockout lasts, each PIN is answered with an access message with `"access":"Keypad locked"`. (`"access":"Reader locked"`, a card refused during a card lockout, is no longer sent since the card lockout was removed.)

### Log messages
Besides the above messages, ESP-RFID can send all the logs via MQTT instead of storing those locally. If this is enabled via the web UI, also the following messages are sent.

#### Door status
If the door has a contact (door status pin), two messages are sent. With two or more doors, `data` in these and in the tamper events is the door's name. One when the door is opened:

```
{
  "type":"INFO",
  "src":"door",
  "desc":"Door Open",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

And one when the door is closed:

```
{
  "type":"INFO",
  "src":"door",
  "desc":"Door Closed",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

#### Doorbell
If the doorbell is enabled, a message is sent when it's ringing:

```
{
  "type":"INFO",
  "src":"doorbell",
  "desc":"Doorbell ringing",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

#### Tamper status
If the door opens while its lock is locked (not after an access or an exit button), this message is sent. If the door is already open when the controller starts and its lock is locked, `desc` is `Door was open when controller started`.

```
{
  "type":"WARN",
  "src":"tamper",
  "desc":"Door was tampered!",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

If the door stays open longer than the held-open alarm time (`hardware.maxOpenDoorTime`, seconds; 0 = no alarm):

```
{
  "type":"WARN",
  "src":"tamper",
  "desc":"Door wasn't closed within max open time!",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

#### WiFi status
Some messages around WiFi handling are also sent.

Enabling/disabling of WiFi:

```
{
  "type":"INFO",
  "src":"wifi",
  "desc":"WiFi is going to be disabled",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

#### MQTT status
MQTT connection or message handling related.

On connecting to the broker, only when the broker reports a session kept from an earlier connection (`Session Present`):
```
{
  "type":"INFO",
  "src":"mqtt",
  "desc":"Connected to MQTT Server",
  "data":"Session Present",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

On disconnecting from the broker:
```
{
  "type":"WARN",
  "src":"mqtt",
  "desc":"Disconnected from MQTT server",
  "data":"reason of disconnection",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

When an incoming message is dropped because the queued commands would take too much memory, or because it is larger than the device takes (4096 bytes), this event is written; `desc` is `Dropped MQTT message: too many queued` or `Dropped oversized MQTT message`. A command that arrives while 16 are already queued is dropped without an event.
```
{
  "type":"WARN",
  "src":"mqtt",
  "desc":"Dropped MQTT message: too many queued",
  "data":"xxx bytes",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

Commands that are refused or fail write these events (`src` is `mqtt`; `data` in brackets):

* WARN "Dropped a retained MQTT command (commands must be sent with retain off)" (size in bytes)
* WARN "Refused MQTT admin command (remote admin disabled)" (the command)
* WARN "Ignored MQTT door command (MQTT door control disabled; logged once until restart)" (the command)
* WARN "Dropped a stale MQTT door command (sent before a reconnect, or too long ago)" (the command)
* WARN "Invalid door index" (the length of the value sent)
* WARN "adduser refused" (why); ERRO "adduser write failed"
* WARN "deletuid refused" ("Invalid uid"); ERRO "deletuid failed: the user could not be removed" (the uid)
* ERRO "deletusers failed: some users could not be removed"
* WARN "updateconf refused" (why); ERRO "updateconf refused: the stored settings could not be read"
* WARN "updateconf: kept the stored values of settings remote admin cannot change" (the keys)

#### System messages
When the system configuration is done and the system is up and running
```
{
  "type":"INFO",
  "src":"sys",
  "desc":"System setup completed, running",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

Before performing a requested reboot:
```
{
  "type":"INFO",
  "src":"sys",
  "desc":"System is going to reboot",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

Before performing a scheduled reboot:
```
{
  "type":"WARN",
  "src":"sys",
  "desc":"Auto restarting...",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

When a blank device formats its filesystem:
```
{
  "type":"WARN",
  "src":"sys",
  "desc":"Filesystem formatted",
  "data":"factory blank device",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

When saving the configuration:
```
{
  "type":"INFO",
  "src":"sys",
  "desc":"Config stored in the filesystem",
  "data":"xxx bytes",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

After deleting all the event logs:
```
{
  "type":"WARN",
  "src":"sys",
  "desc":"Event log cleared!",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

After deleting all the access logs:
```
{
  "type":"WARN",
  "src":"sys",
  "desc":"Latest Access log cleared!",
  "data":"",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

When starting the firmware update:
```
{
  "type":"INFO",
  "src":"updt",
  "desc":"Firmware update started",
  "data":"file name",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

If there's no space to upload the firmware:
```
{
  "type":"ERRO",
  "src":"updt",
  "desc":"Not enough space to update",
  "data":"(the update error)",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

If the firmware update failed because it's not possible to write on flash:
```
{
  "type":"ERRO",
  "src":"updt",
  "desc":"Writing to flash is failed",
  "data":"(the update error)",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

If the firmware update successfully finished:
```
{
  "type":"INFO",
  "src":"updt",
  "desc":"Firmware update is finished",
  "data":"xxx bytes",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

If the firmware update failed:
```
{
  "type":"ERRO",
  "src":"updt",
  "desc":"Update is failed",
  "data":"(the update error)",
  "time":1605991375,
  "cmd":"event",
  "hostname":"your esp-rfid hostname"
}
```

### Home Assistant messages

#### Discovery
With MQTT for Home Assistant on, the device announces its entities each time it connects to the broker, as retained discovery configs under `homeassistant/`:
* a lock per door with a relay pin, only with MQTT door control on; with it off an empty retained config removes them
* a door sensor and a tamper sensor per door with a contact
* a doorbell sensor, if a doorbell pin is set
* Tag, User, Access, DoorName and Time sensors, read from `TOPIC/tag`
* a Delete Log button, which sends `deletlog`. It is announced whatever the remote admin setting; with remote admin off its press is refused.

Availability is on `TOPIC/avty`: `online` (retained) on connecting, and `offline` (the retained last will) when the device drops off.

#### IO messages
The states are published, not retained, when they change and again on each connection:

| Topic | Payload |
|---|---|
| `TOPIC/io/door` (door 1), `TOPIC/io/door2` to `door4` | `ON` open, `OFF` closed |
| `TOPIC/io/tamper` (door 1), `TOPIC/io/tamper2` to `tamper4` | `ON` / `OFF` |
| `TOPIC/io/doorbell` | `ON` ringing, `OFF` |
| `TOPIC/io/lock0` (door 1) to `lock3` | `LOCKED` / `UNLOCKED` |

Lock numbers count from 0; door and tamper numbers from 2 (door 1 has no number). A lock entity sends `{cmd:'open', door:'<n>', doorip:'<IP>'}` to unlock and `{cmd:'close', door:'<n>', doorip:'<IP>'}` to lock, on `TOPIC/cmd`.


#### Publish access
Similarly to what is published for the standard MQTT settings, when Home Assistant is setup, esp-rfid sends a set of messages when a rfid card is swiped.

Read above for the possible cases, the significant part for HA is that the topic to which the message is sent is different: `TOPIC/tag`. The `uid` follows **Card number in MQTT** as above (default last 4 since 1.4.2), so the Tag sensor shows `****c3d4`, and nothing with Off; automations that match the full card number need Full.

And the message looks like this:

```
{
  "uid":"token UID",
  "username":"username",
  "access":"the access state",
  "time":1605991375,
  "doorName":"your door name"
}
```

It has no `type`, `isKnown` or `hostname`. It may carry `door`, `direction` and `"cmd":"log"` as the `TOPIC/send` access message does, and at a reader that opens every door, the arrays described above.
