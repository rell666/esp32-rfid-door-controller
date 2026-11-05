# Change Log
All notable changes to this project will be documented in this file.

## Ironframe 1.9.1 - 2026-10-26

Updates from 1.9.0 (or earlier 1.x) through Update with `ironframe-rfid-1.9.1.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). From review 8. Bench checks owed: ledger H31 (none run yet on this release). Not yet checked on a door.

**Behaviour changes:**
- **The admin password is needed for what opens a door, enrols a credential or erases the record**, not only a signed-in page (the session token travels in the plain-HTTP WebSocket URL): Test, Restart, removing a user, a user save that adds a user, gives admin access or sets, changes or removes a PIN (a name, the dates or roles Always/Disabled on a stored user still need only the session), a backup restore, clearing a log, logging on or off, moving a clock that is already set (a lost clock is still set from the browser), and any change on Doors & Readers. The page keeps the password's hash after sign-in and asks after a reload (review 8 V1).
- **A card whose number is a keypad-only user's UID is refused** as an unknown card (it counts toward the unknown-card alarm); up to 1.9.0 it opened as that user with no PIN (review 8 V2).
- **Every restart waits for the doors**, at most 30 s: Save & Reboot, Restart, the end of an Update, MQTT `updateconf` and the factory reset wait until no reader is part-way through a card or PIN and every door is locked; the event log says what it waited for. They used to restart at once (review 8 V3).
- **Sessions end 12 hours after the last use** (a message from a page of that session), and 24 hours after sign-in however busy; the open pages of an ended session are closed. Up to 1.9.0 a page's connection simply closed 12 hours after it opened, so the 24-hour limit was never reached (review 8 V20).
- **Test asks before it unlocks a real door**, and Restart, Save & Reboot, Update and Auto Restart say when a door held locked by its relay (a maglock on NO) will unlock while the reader restarts (review 8 V8).

**Fixes:**
- A PIN typed while the controller was busy for a couple of seconds lost digits, and the garbled PIN counted toward the keypad lockout: the reader now queues 32 frames, and an entry that still lost frames is cancelled, not counted (review 8 V4).
- The low-memory restart no longer waits for ever behind one door held open: after an hour it goes ahead, naming what held it (review 8 V5).
- The page no longer stalls on "Reconnecting..." after a slow connect (review 8 V6).
- A granted card no longer shows "The relay fired" in every open tab (review 8 V7).
- Opening-hours edits count as unsaved: leaving the page asks (review 8 V12).
- A reader set to a door that does not exist is warned at start-up and marked on Status, instead of refusing every card silently (review 8 V14).
- A user stored with its role or dates as text is listed as the reader reads it (review 8 V15).
- A reply too large for the device is logged; Status keeps the network fields; a Users page too large to send says why at once (review 8 V16).
- MQTT access messages name one role per door whatever is stored (review 8 V17); the factory reset asks for the host name the reader runs with; a cancelled password prompt is not shown as a failure; the user editor does not close on a stray tap once typed in; help buttons are no longer inside their labels; the time zone list names Europe/London; Save is described the same way on every page; smaller fixes (review 8 V13, V18, V19, V21).
- Tooling: the pre-commit hook needs every gate's PASS line, a clone without the hook fails the gates, two builds of one commit give the same image (the build time is gone from it), `test/check-release.sh` builds a release twice from its tag and compares, release records for 1.7.1-1.9.0 are complete and checked (review 8 V10, R5-4, R5-5, R5-7). QEMU cannot read GPIO levels back, so the relay levels are still checked on the bench, not in the emulator (plan 1.9.1 E1).

## Ironframe 1.9.0 - 2026-10-19

Updates from 1.8.1 (or earlier 1.x) through Update with `ironframe-rfid-1.9.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). From review 7. Bench checks on a second ESP32: ledger H30. Not yet checked on a door: real Wiegand frames, real power cuts and the panel checks (plan 1.9 H).

**Behaviour changes:**
- **An update, a factory reset and a change to the network or MQTT settings need the admin password**, not only a signed-in page: a session token travels in the plain-HTTP WebSocket URL, and whoever captured it could install firmware or point the reader at another MQTT broker. The page keeps the password's hash in memory after sign-in and answers without asking; after a reload it asks once ("Confirm the admin password").
- **After an unknown card the reader waits 5 s** (10 s while unknown cards keep coming) before it reads the next card, so card numbers are about 5 times slower to guess. A valid card used straight after an unknown one waits out that pause (2026-10-19).
- **Wrong PIN-only entries add up across readers:** five lock PIN-only entry at every reader (cards and card+PIN still work), and a new keypad-only user needs a PIN of at least 6 digits (existing ones keep working until changed).
- **A page's Save opens the review straight away**, so Save leads to saving; leaving a page with edits not saved asks first, closing or reloading the tab with unsaved settings gets the browser's warning, and the phone's Back button goes back a page.
- **Status shows the doors** (locked or not, open or closed with a contact), the last card, and on a new reader "not set up yet" with where to start.
- **Sessions end 24 hours after sign-in** however busy (and after 12 hours unused, as before).

**Fixes:**
- **The Users page and Backup users no longer hold up the doors**: the users are kept in memory, so a page answers in about 50 ms (3.8-11 s with 200 users on 1.8.1, during which cards and exit buttons waited).
- **MQTT uses a maintained library** (espMqttClient 1.7.3; AsyncMqttClient had no release since 2021 and was used from two tasks at once). Outgoing messages wait in an outbox of at most 48 (a broker that stops reading cannot use up the memory; refused ones are counted in the Event Log); cards reach the broker as fast as before.
- **Sign-in cannot be blocked from a few other addresses** (they could use up every sign-in challenge).
- The emulator gates no longer fail on a busy host, and now cover the damaged-storage start that left a board restarting forever in 1.8.0.

## Ironframe 1.8.1 - 2026-10-19

Updates from 1.8.0 (or earlier 1.x) through Update with `ironframe-rfid-1.8.1.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Stability fixes from the bench runs of 2026-10-17 to 2026-10-19 on a second ESP32 (ledger H25-H29) and review 7. Bench checks: ledger H27-H29.

**Behaviour changes:**
- **At most 200 users** (sites have under 200). A new user above that is refused from the Users page, a backup restore or MQTT `adduser` with "The user limit (200) is reached"; editing an existing user still works. A reader updated with more than 200 keeps them all but takes no new ones. New users are also refused with less than 64 KB of storage free ("Storage is nearly full"), and nothing is written with less than 16 KB free. README: How many users.
- **Settings the reader cannot use are refused** with a message instead of stored: a settings file with no network or hardware section (the reader then ran with no doors or readers), an SSID over 32 characters, a Wi-Fi password over 64, a door name over 63, an MQTT port outside 1-65535, an NTP interval outside 0-10080 minutes, and a host name other than 1-32 letters, digits and hyphens (the page only warned about spaces before). An old backup with such a value is refused on restore with the reason; fix the value in the file and restore again.

**Fixes:**
- **A full or damaged store no longer leaves the reader restarting forever.** Adding users until storage was full crashed the reader, and it then crashed on every start. With storage erased or damaged on a set-up reader, it restarted every second, so neither the page nor the BOOT-button recovery worked. Both now start: the damaged one with Wi-Fi off, as intended, and holding BOOT 12 s recovers it.
- **Start-up with many users: 136 s -> under 2 s** (776 users on the bench; 0.7 s with 200). The user folder was walked by opening every file. The Users page, delete-all and the boot check now walk names only.
- **Status and saves no longer stall with many users**: free space was measured by walking the whole store on every card, save and Status refresh (about 1 s each with 700 users; a save outlasted the loop watchdog). It is now measured at most every 30 s and checked again before anything is refused.
- **A PIN refusal logs the card's user and role.** A wrong PIN, a locked keypad and "PIN required, user has no PIN" were logged with role Disabled and, for a wrong PIN, no name. Keypad-only digits still name nobody: they are logged as Unknown.
- **A page that went away without closing is dropped after 90 s.** The reader pings a quiet page every 30 s and closes one silent for 90 s, so Wi-Fi idle-off is no longer kept on by a laptop that left.
- **A Network save in Hotspot mode keeps DHCP as saved.** It staged "Use DHCP: Yes -> No" on every save, forced Save & Reboot, and a later switch to Client mode came up on a fixed address.
- **An unknown WebSocket command is answered** ("Unknown command") instead of left without a reply.
- **The MQTT user list no longer holds up the doors.** `getuserlist` opened every user file in one go (about 9 s with 200 users, no card decided meanwhile); it now sends one user per pass, and cards reach MQTT in under a second while it runs (bench: 200 users in 72 s).
- **The scheduled auto-restart waits until the reader is idle** (no card or PIN part-way, every door locked, no update running), at most an hour past its time, as the low-memory restart does. It used to cut a PIN entry or release a maglock on NO at any moment.
- **A wrong time from a browser is ignored.** A missing or pre-2016 time made a set clock untrusted, so dated and opening-hours users were refused until NTP answered (on a hotspot-only site, until someone set the time again).
- **Log split keeps the log floor** (48 KB plus the file, not 4 KB) and says so when a split could not be written, instead of reporting it done.
- **MQTT `adduser` answers every refusal** (an invalid record, an admin card, a failed write) as the other commands do.
- **Logout ends the page's own session**, not the one named in the message.
- **Logs: switching logging on or off** no longer shows up later as an unsaved change.
- **Help text:** Allow PIN code only is under Doors & Readers; both readers are Wiegand; the NTP sync interval; the Test-relay message names Doors & Readers.

## Ironframe 1.8.0 - 2026-10-17

Updates from 1.7.1 (or earlier 1.x) through Update with `ironframe-rfid-1.8.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept; a stored WiFi Timeout is converted once at the first start). Production-network choices of 2026-10-17. Board checks: ledger H24.

**Behaviour changes:**
- **Turn Wi-Fi off when nobody is connected** replaces **WiFi Timeout** (Wireless Network page, Power saving). A tick box, off by default: unticked, Wi-Fi stays on. Ticked, Wi-Fi turns off once nobody has been connected for the set minutes (1-1440, default 15): no device joined to the reader's hotspot and no signed-in page open. It applies in every mode (router, hotspot, fallback hotspot); WiFi Timeout counted only router-connected time, so a hotspot install never turned off. An admin card or a power cycle turns Wi-Fi back on. Saved without a restart. An updated reader converts a stored WiFi Timeout once at its first start: N seconds becomes ticked with N/60 minutes rounded up (event "WiFi Timeout replaced by ..."); none stays unticked (`network.idleoff`, `network.idlemins`; `core/wifiidle.h`). A pending 5-minute Wi-Fi reconnect no longer turns Wi-Fi back on after it was turned off.
- **The setup hotspot has a password.** A new or reset board (no settings) opens `IRONFRAME-RFID-xxxxxx` with the password `ironframe-setup` instead of an open network: a public factory default, documented in the README, so the session token no longer travels over an open network; the factory admin password must still be changed at the first sign-in. It closes after 15 minutes with nobody connected (event "Setup hotspot closed"); a power cycle, or an admin card on a board recovered with its users, opens it again. A fresh board's first save keeps the hotspot's name and this password (it saved an open hotspot) (2026-10-17).
- **Low memory restarts the board, only when idle.** When three card reads in a row are refused for lack of memory ("Not enough memory to read a user record"), or the largest free memory block stays under 8192 bytes for 10 minutes, the reader restarts, but only while no reader is part-way through a card or PIN, every door is locked with no open pulse, and no Update or settings apply is running; never within an hour of any start, so at most once an hour. The event log says "Restarting: low memory (largest block N bytes)" and why, before it restarts. A restart releases a maglock for about 0.5-2 s (ledger H22.4). Until now a fragmented heap left valid cards refused until someone restarted the reader (review 6). The 8192-byte threshold is set from the code's allocations (8 KB settings documents, 1 KB per card lookup), not measured on the board (`core/memguard.h`).
- **Host tests for more of the glue code** (no behaviour change): the MQTT command checks (doorip, remote admin, door control, stale door commands) and door index, the WebSocket Test-relay index and uid lower-casing, and the Wi-Fi link-lost and fallback-retry timing now live in `src/core` with native tests. One fix found on the way: the user editor's "replaces" field (a changed UID) was copied into a 33-byte buffer with no length check, so a longer value from a signed-in page overran the stack; an invalid one now counts as no rename, as a short invalid one already did.
- **Deleting every user (MQTT `deletusers`) works in batches** of 16 file names instead of listing every user in memory first, which with many users could run out of memory and crash the reader (review 6).

## Ironframe 1.7.1 - 2026-10-17

Updates from 1.7.0 (or earlier 1.x) through Update with `ironframe-rfid-1.7.1.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). A bench report on 1.7.0 and the choices that followed, 2026-10-16. Board checks: ledger H23.

- **The web page no longer signs you out at random.** When its live connection dropped and the next one would not open, the page threw the sign-in away whenever the reader answered at all, though the session was still good (a busy reader, or a Wi-Fi blip that ended between the two tries); during an Update the page then asked for a new sign-in. It now asks the reader (`GET /session`: 204 still signed in, 401 not, 429 locked out) and signs out only on a 401, so a restart, a password change, a logout or an expired session still asks for the password; anything else keeps the session and retries every 5 s (2026-10-16). A real restart still signs every browser out: sessions are kept in memory. Board checks: ledger H23.
- **A card no longer locks a Continuous door held open.** A valid card toggled a Continuous (latching) relay, so a card at a door held open locked it (review 6 V3); the exit button and MQTT `open`/`opendoor` already only opened. Now no card locks it: lock it again with **Test** on Doors & Readers or MQTT `close` (2026-10-16). Momentary relays are unchanged.
- **Save warns before card numbers change.** Changing **User ID storage mode** or **Remove parity bits** changes the number every Wiegand card reads as, at once on Save, so enrolled cards stop matching; the review now says so in a warning before Save (a 1.7.0 bench report, 2026-10-16).

## Ironframe 1.7.0 - 2026-10-16

Updates from 1.6.0 (or earlier 1.x) through Update with `ironframe-rfid-1.7.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Decisions of 2026-10-16. Board checks: ledger H22.

**Behaviour changes:**
- **A new board defaults to Locked when the relay is on.** Each door has a new setting, **When the relay is on, the door is**: **Unlocked** (electric strike, or maglock on NC) or **Locked** (maglock on NO: released if the controller fails or loses power). A new board (the ESP32 two-door preset, the built-in default settings) and a door added with **Doors** start as **Locked**: the relay is on all the time the door is locked, so a dead, restarting or unpowered controller lets a maglock wired to NO go. **Stored settings keep their behaviour**: without the setting a door is Unlocked when the relay is on, as before, so an updated board changes nothing until it is changed. Needs a restart; MQTT remote admin cannot change it (key `rhold`; `9540112`).
- **RTC module** on the Time page: a DS3231 or DS1307 on I2C (SDA GPIO21, SCL GPIO22 unless chosen otherwise), off by default. Read once at start: a good time sets the clock at once (event "Time set from RTC"), so dated and opening-hours users get in after a power cut with no NTP and no browser; a flat cell logs "RTC lost the time (battery?)", no answer "RTC not found on SDA x / SCL y", and the reader carries on as without one. Written whenever the time comes from NTP or a browser. Its pins are checked with every other pin. Needs a restart; MQTT remote admin cannot change it (`ntp.rtc`; `64b45fa`, `2fae677`, `6acc72e`).

- **Pin conflicts are marked on the fields** (Doors & Readers, and the Time page for the RTC): a clashing pin is outlined in red with a line saying what else uses the GPIO, the card holding it shows **Pin clash**, the banner above Save lists every clash, and each pin menu marks the GPIOs already in use (`GPIO-21 — in use: Relay 1`). The two pages check against each other's staged pins (`4be12dc`, `64b45fa`, `6acc72e`).
- **Relay type** is now explained as the pin level that switches this board's relay on (the VOANZO board: Active High); what the door does is the new setting above.
- Status reports the RTC: `rtc: {state: off | ok | lost | missing, time}` (`2fae677`).

- **Dead-code cleanup** after a read-only audit (no behaviour change): leftovers of the removed MFRC522, PN532 and RDM6300 readers in the firmware, the core code and the tests; the unused TimeLib library; dead UI code and CSS; the upstream WebSocket emulator (`tools/wsemulator`) and the UI's demo mode for it; the `demo/` images; the web builder's unused dependencies (rebuilt assets byte-identical); wrong live docs (`05c8f4d`..`b371444`).

## Ironframe 1.6.0 - 2026-10-16

Updates from 1.5.0 (or earlier 1.x) through Update with `ironframe-rfid-1.6.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Eight review fixes after 1.5.0 (2026-10-16). Board checks: ledger H21.

**Behaviour changes:**
- Reader 1 without a stored door now opens **door 1** when there are two or more doors (it was every permitted door). A stored "every door" is kept; with one door nothing changes (`e04f41a`).
- The NTP **sync interval is used** (it was stored and never read: the reader synced every 3 hours whatever it said). 1 minute up to 7 days; 0 keeps the 3-hour default. Changing it now needs a restart (`1587d1a`).
- **Wiegand readers only.** The MFRC522, PN532 and RDM6300 readers are removed (2026-10-16). A board that stored one of those starts with reader 1 off and a warning in the event log (never a refusal: the settings still load); Wiegand + RDM6300 keeps its Wiegand reader. A save, a restored old backup and MQTT `updateconf` must name a Wiegand reader (`d43fcd4`).
- A **factory reset from the web page keeps the relays locked** at power-up: it no longer erases the NVS copy of the relay pins and their locked levels (since 1.4.2 a reset board left them undriven, floating). It still erases the exit-button copy (2026-10-16, option b; `b4b6c77`).
- A request or WebSocket whose Host names **another site** gets 421 (DNS rebinding). The reader's IP addresses, 192.168.4.1, its host name and `<name>.local` always work (`e3a361c`).

- One address can hold at most 2 of the 8 login nonces, so a `/login` flood from one address no longer breaks everyone else's sign-in (`e3a361c`).
- MQTT `deletuid` / `deletusers` answer `"result":false` with a `message` (and log an ERRO event) when a user could not be removed; they acknowledged success whatever happened. Every answer now carries `result`. A `.bak` that cannot be removed keeps the user present instead of bringing them back later. The web page's Delete reports the same failure (`686a818`).
- Backup Users keeps its own rows: opening another list page during a backup put that page's rows into the file, and a Users page opened meanwhile showed the backup's PINs. The Users page now loads after the backup (`36afacb`).
- Doors & Readers no longer lists a stray "Reader 2 opens" change while reader 2 is off (1.4 stored its door as `null`); the stored door is kept (`a4a2868`).

## Ironframe 1.5.0 - 2026-10-16

Updates from 1.4.3 (or earlier 1.x) through Update with `ironframe-rfid-1.5.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). A new web UI, and settings saved without a restart where it is safe (2026-10-16).

**Behaviour changes, read before updating:**
- Many settings now apply **without a restart** (see README-IRONFRAME.md, *Saving settings*): the review's button says **Save** for those and **Save & Reboot** for the rest. The first save after the update may still restart once (settings stored by an older page lack keys the new pages always write).
- Editing a user keeps their access on doors beyond the current number of doors (the old page saved those as disabled).
- New refusals on the settings pages: an MQTT port outside 1-65535, a sync time or NTP interval that is not a whole number, an auto restart under 300 seconds (a smaller one restarted the reader before it could be changed back), a malformed BSSID while the lock is ticked, an empty host name.

- **New web UI, no library.** jQuery, Bootstrap 3 and FooTable are gone, with the icon font: the pages are plain JavaScript, native dialogs and one stylesheet of our own. The UI the board serves fell from ~115 KB to ~52 KB gzipped, and no third-party UI code is left to carry XSS history (`test/check-assets.mjs` now fails if any comes back, or a Bootstrap class, or an inline script).
- **Phone first.** A tab bar (Status, Users, Access Log, More) and dialogs that open from the bottom on a phone; a fixed sidebar on a wide screen; 44 px touch targets; no page scrolls sideways (logs become stacked entries on a phone).
- **Status:** summary tiles (uptime, clock, IP address, network), memory and storage bars, banners when the clock is not set or the hotspot has no password.
- **Users:** one row per user with access per door, validity ("Expired ...", "Until ...") and PIN set; search, filter, sort and pages of 25; the editor is a dialog with the error kept in view above its buttons. A failed save after the editor closed is now reported, and an answer arriving after the page was left no longer changes the next page.
- **Access Log / Event Log:** newest first, search, filters with counts (granted/denied, errors/warnings), readable event types, entries written before the clock was set say so instead of 1970, in written order (the timestamp sort mixed those up).
- **Log Settings, Backup & Restore:** file sizes and free storage; restore shows progress and the skipped users and cannot be closed half-way; a backup of a reader with no users no longer waits for ever; Restart, New file and Clear log ask first.
- **Doors & Readers** (was Hardware Settings): one card per door with its readers inside, advanced pins folded, a live banner saying why the settings cannot be saved yet. A stored pin with no menu entry (255, or a pin this board refuses) was saved back as `null`; it is now shown and kept or refused. Wiegand options also show when only reader 2 is Wiegand (the firmware applies them to every Wiegand port).
- **Network, General, MQTT, Time:** network scan results as a list with signal bars; passwords with Show; the opening hours as 24 tappable hours per day with All day / Closed and copy Monday to the week; the MQTT topics shown for Auto topic; the device clock ticking and its offset from this browser. MQTT sync time was saved as text, which the firmware read as missing (always 180 s): saved as a number now. A time zone or Wi-Fi off time not in the list was wiped on the next save: kept now.
- **Firmware update** shows the real upload progress instead of a timed bar.
- **Save without a restart** (`src/core/livesettings.h`, `test/vectors/live-settings.json`): the device compares the stored settings with the new ones; when every changed key is on the live-safe list it stores them, answers `restart: false` and copies only those fields into the running settings between two reader passes. Anything not on the list, an unknown key, damaged stored settings or a restart already due restarts as before. The page mirrors the list (`policy.js settingsNeedRestart`), checked against the same vectors (`test/check-live-settings.mjs`). MQTT `updateconf` still restarts.

## Ironframe 1.4.3 - 2026-10-16

Updates from 1.4.2 (or 1.4.1 / 1.4.0 / 1.3.x / 1.2.x) through Update with `ironframe-rfid-1.4.3.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Fixes from the sixth five-reviewer review.

**Behaviour changes, read before updating:**
- Unknown cards no longer lock a reader: valid cards always open, and 10 unknown cards raise an alarm. The MQTT alarm's `desc` is now "Unknown cards at reader" (was "Card reader locked out"): Home Assistant automations on the old text need changing.
- With Wi-Fi fallback mode on, set a **Fallback hotspot password** (Network page): without one no fallback hotspot opens.
- Retained MQTT commands are dropped: send commands with retain off.
- The user editor never shows a stored PIN; leave it empty to keep it.
- Change Password checks the 8-64 length on the page; the device refuses only the factory password.

- **Behaviour change: retained MQTT commands are dropped.** The broker replays a retained message on `TOPIC/cmd` to every new subscription, and the stale-command check only caught commands queued before a disconnect, so with MQTT door control on a retained `opendoor` or `open` opened the door after every reconnect or restart (and a retained `deletusers` would have emptied the user list each time). Every retained command is now dropped and logged ("Dropped a retained MQTT command"); send commands with retain off. Home Assistant's lock and button entities publish without retain.
- **Behaviour change: unknown cards raise an alarm and no longer lock a reader; valid cards always open** (2026-10-16). Since 1.4.0, 10 unknown cards at a reader made it refuse **every** card, valid and admin ones too, for 30 s doubling to 15 min, kept across a restart, so anyone with a few cheap tags could keep a door shut to its users indefinitely. The same count now only raises an alarm: event log "Unknown cards at reader" and an MQTT `alarm` with that `desc` (it was "Card reader locked out"), then quiet for 30 s doubling to 15 min. MQTT access messages no longer carry `"access":"Reader locked"`, and a card lockout stored by 1.4.2 or earlier is erased at start-up. **Card-number guessing is slowed only by the 2 s reader cool-down now: act on the alarm.** The keypad lockout (5 wrong PINs) is unchanged.
- **Behaviour change: the Wi-Fi fallback hotspot has its own password, and never opens without one.** With fallback mode on, losing the router for 5 minutes (or failing to join it at start-up) opened the `IRONFRAME-RFID-xxxxxx` hotspot with no password, so anyone who could jam the Wi-Fi for 5 minutes had an open network to the admin page. A new Network setting, **Fallback hotspot password** (`network.fallbackpswd`, 8-63 characters, masked like the other passwords and kept from MQTT remote admin with the rest of `network`), is required to stage fallback mode on. **A board updated with fallback mode on and no such password opens no fallback hotspot** (logged at start-up) until one is set. A new, unconfigured board still opens an open hotspot for commissioning, behind the factory password.
- **PINs are no longer sent to the web page.** The user list carried every user's PIN to the browser (hidden in the table), so anyone watching the link or the browser had them. It now sends only whether a user has one (`haspin`); Backup Users still gets the PINs (it asks with `backup: 1`), as a backup must hold them. The user editor never shows a stored PIN: leave the field empty to keep it (`keeppin`), type a new one to change it, or tick **Remove this user's PIN**. A keypad-only user's UID is still their PIN, by the design of PIN-only mode.
- **Change Password no longer sends either password in clear.** The page sent the current and the new password as typed over `ws://`, so anyone watching the network had both. It now sends the new password's digest hash encrypted under the current password's hash and the session token, with a proof of the current password (`core::openPasswordChange`); the forced first change proves the password just signed in with (after a reload it asks for it). The device no longer sees the new password, so the 8-64 length rule is checked by the page (which reports the length) and the device refuses only the factory password. A `setpassword` in the old form is refused.

## Ironframe 1.4.2 - 2026-10-15

Updates from 1.4.1 (or 1.4.0 / 1.3.x / 1.2.x) through Update with `ironframe-rfid-1.4.2.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). The remaining review 5 findings chosen for a fix.

**Behaviour changes, read before updating:**
- The admin password is stored as its Digest hash; the first start converts it. **Do not go back to an older firmware without reading the admin-password line below** (an older firmware would take the hash itself as the password).
- MQTT access messages send only the last 4 characters of the card number by default (MQTT settings: **Card number in MQTT**). Home Assistant automations that match the full number stop matching until it is set to Full.
- MQTT remote admin can no longer change the settings that guard the doors (door control, broker, Wi-Fi, admin password, PIN rules, relays, pins), nor add admin cards.
- A factory reset from the web page also erases the relay and exit-button boot copies; holding BOOT to recover keeps them.
- Backup Settings saves what the device has stored, not unsaved changes on the page.


- **Backup Settings saves the device's stored settings.** It saved the page's copy, which holds any changes staged on the settings pages but not saved, so a backup taken mid-edit was not what the device was running. It now asks the device for its settings (`getconf`, passwords masked as before) and saves those; with changes staged it says the backup holds the saved settings, not the unsaved changes. If the device sends nothing (no saved settings yet) it says so.
- **Behaviour change: the web page's Factory reset also erases the relay and exit-button boot copies.** They are kept in NVS so the exit buttons work when the settings are damaged, and a factory reset kept them, so a blank board went on driving the old relay pins at power-up and opening on the old exit buttons. A factory reset now removes them with the rest; BOOT-hold recovery still keeps them, on both its paths (settings-only erase and the full-format fallback). Which kind a reset is is now explicit in the firmware (`core::ResetKind`), and a format interrupted by a power cut is finished as the kind it was.
- **Behaviour change: MQTT access messages carry only the last 4 characters of the card number by default.** Every access went to the broker with the full card number, which is all someone reading the topic needs to clone the card. A new MQTT setting, **Card number in MQTT** (`mqtt.carduid`: 0 Off, 1 Last 4, 2 Full), decides: Last 4 sends `"uid":"****c3d4"`, Off sends no `uid`; keypad entries stay `keypad`. It is Last 4 on a fresh device and on settings saved before it existed, so **Home Assistant automations (or other consumers) that match on the full uid stop matching until it is set to Full.** The remote-admin user list (`getuserlist`) is unchanged.
- **A slow event-log write no longer restarts the controller.** One append to a log file is several filesystem reads (one of them, the free-space check, walks the whole filesystem), and the loop watchdog was fed only after it. On QEMU's emulated flash an append took up to 6 s and grew with every line, so the configured-device boot test was restarted by the 8 s watchdog as soon as one more event was logged at start-up. The watchdog is now fed between the steps of an append too. Not seen on the board, where an append takes milliseconds.
- **Behaviour change: the admin password is stored as its digest hash, not as typed.** `config.json` held it in clear (and NVS too, for one set before the first settings save), so anyone who could read the flash or a copy of the file had it. The device now stores only HA1 = MD5(`admin:ironframe-rfid:<password>`), which the Digest sign-in checks directly; Change Password checks the current password against it. A password stored by 1.4.1 or earlier is hashed at the first start after the update and `config.json` (and the NVS copy) rewritten once, logged as "Admin password now stored as a digest hash"; signing in is unchanged. Whether the factory password must still be changed is now a flag stored with it (set for a fresh device, or when the old value was the factory or a too-short password). **Downgrading below 1.4.2 afterwards leaves the hash as the password:** an older firmware takes the stored value as typed, so the old password no longer signs in. To recover on the older firmware, sign in with the hash itself as the password (`printf '%s' 'admin:ironframe-rfid:<old password>' | md5sum`, the 32 characters) and set the password again with Change Password (current password: the same 32 characters); or update back to 1.4.2, where the old password works.
- **Behaviour change: MQTT remote admin can no longer change the settings that guard the doors, or add admin cards.** With remote admin on, anyone who could publish to the command topic could use `updateconf` to turn on MQTT door control, point the device at their own broker or topic, change the Wi-Fi or turn off Require pin code, and `adduser` to enrol an access-99 admin card. `updateconf` now keeps the stored values of the Wi-Fi settings, the admin password, the broker connection and topic, remote admin, door control, PIN required / PIN only, the reader type and reader blocks, the relay count, every pin, every relay's type, lock type and time, and the held-open time (README-MQTT, Remote admin, has the exact list); its acknowledgment lists them in `ignored` and the event log names them. Names, opening hours, time, logging and the other MQTT options still change. `adduser` refuses a user with access 99 on any door (event log "adduser refused"). **A broker-side tool that relied on `updateconf` for these settings must now use the web page.** A kept setting left out of an update keeps its value (it was dropped), and `updateconf` is refused if the stored settings cannot be read.
- **README-MQTT: the access message examples no longer show `pincode`.** The firmware stopped sending it in 1.2.0, but the examples (plain and Home Assistant `tag`) still had a `pincode` field; they now show what is sent (with `doorName` on the unknown-card and `tag` examples, and a note on `door` and `direction`). Docs only.
- **Tooling: CI.** Every push to `main` now runs all the gates in CI; review 5 found there was no CI. No firmware change.

## Ironframe 1.4.1 - 2026-10-15

Updates from 1.4.0 (or 1.3.x / 1.2.x) through Update with `ironframe-rfid-1.4.1.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Fixes from the fifth five-reviewer review.

**Behaviour changes, read before updating:**
- **Require pin code after RFID card** is off on a fresh device and shown for every reader type. A board that already has it on keeps it on: check the Hardware page.
- The wrong-PIN lockout is per reader (the old shared level is copied to every reader once) and sends an MQTT `alarm`.
- Lockouts no longer reset after 10 quiet minutes: one wrong PIN is forgiven per hour, one unknown card per 30 min, and after a lockout the next failure soon re-locks. The short 30 s lockout comes back after 4 h (PIN) / 4.5 h (cards) with no failure, not 1 h.
- An exit button only opens: on a Continuous (latching) relay a press no longer locks a door held open; on a Momentary relay a press during the hold does not restart it.
- Holding BOOT for 10 s erases the settings only; users and logs are kept.
- A card read while memory is short is refused as **Busy** (MQTT `"access":"Busy"`), not Unknown.
- Choosing a scanned Wi-Fi network no longer locks the device to that access point unless **Lock to this access point** is ticked.

- **"Require pin code after RFID card" is off on a fresh device, and shown for every reader type.** The web page's built-in default was on (the firmware's is off), and the checkbox sat in the Wiegand-only part of the Hardware page, so with an MFRC522, PN532 or RDM6300 reader it was hidden but still saved: a fresh board's first save turned it on unseen and, since 1.4.0, refused every card with no PIN, admin cards too. The default is now off, the checkbox is shown whatever the reader type, and the first-save review lists it (with Allow pin code only and MQTT door control).
- **An exit button press is not missed while the controller is busy.** The buttons were only read from the main loop, so a press made and let go while it was busy (a web page or MQTT command writing flash, a long user list) was never seen and the door stayed shut. An interrupt on the button pin now records the press (still 30 ms debounce; a button held down at power-up is not a press) and the door opens as soon as the loop comes back.
- **Web page and MQTT commands no longer hold up the door for seconds.** The main loop worked through every queued WebSocket message (up to 16, each possibly a flash write or a log page) and every queued MQTT command in one go, while the readers and exit buttons waited. Each queue now gets at most 100 ms per pass, as the log writer already did; the rest is handled on the next pass.
- **An exit button only ever opens.** A press requested the relay whatever its state, and a Continuous (latching) relay toggles, so pressing the button of a door held open locked it. A press now opens only a locked door, as MQTT `open` and `opendoor` do; it is still logged as "Button". With a Momentary relay a second press during the hold no longer restarts it.
- **The keypad (wrong-PIN) lockout is per reader, and raises an MQTT alarm.** One lockout covered every keypad, so 5 wrong PINs at the outside reader also blocked card+PIN at the inside reader people leave by (up to 15 min, kept over a restart). Each reader now has its own, kept in NVS per reader as the unknown-card lockout is; a keypad lockout running when 1.4.0 was updated is resumed on every reader once. Its start now sends an MQTT `alarm` message ("Keypad locked out"), as the card lockout does.
- **Lockouts cannot be beaten by pacing.** The keypad and unknown-card lockouts counted failures only while each came within 10 minutes of the last, so 4 wrong PINs (or 9 unknown cards) every 10 minutes, about 576 PINs a day, never locked. Failures now add up in a leaky bucket: one wrong PIN is forgiven per hour, one unknown card per 30 minutes. 5 wrong PINs or 10 unknown cards still lock the reader as before; any steady rate above one an hour (PINs) or one per 30 min (cards) now locks in the end, while an occasional slip drains away.
- **A lockout no longer hands a guesser a fresh allowance.** When a keypad or unknown-card lockout ended the bucket started empty, so each lockout bought 5 more PINs (10 more cards): about 480 PINs a day at the 15-minute maximum. A lockout now leaves the bucket one short of full, draining from when it ends, so one more failure soon after locks again for twice as long: at most 99 tries a day per reader once locked. The short 30 s lockout and the full allowance return once the bucket has drained empty (4 hours for PINs, 4.5 for cards; it was one hour), so a single mistake the next morning does not lock.
- **A card is not refused as unknown when memory runs short.** A user lookup that could not allocate memory to read the record returned "no such user", so a valid card was refused as Unknown and counted toward the unknown-card lockout (a PIN as a wrong PIN). The lookup now tells the two apart: such a card or PIN is refused as busy (denied beep, event "Card not checked: not enough memory, try again", MQTT access `Busy`), is not counted by either lockout, and works on the next try once memory is back.
- **BOOT-hold recovery keeps the users.** Holding BOOT for 10 s on a board whose settings were damaged or refused formatted the whole filesystem, so every user was lost to a bad settings file. When the filesystem mounts it now erases only the settings (`config.json` and its `.bak`/`.tmp`) and the commissioning state, keeping the users, the logs and the NVS relay and exit-button boot copies; a filesystem that does not mount is still formatted, as the only way back. The event log says which was done. The web page's factory reset is unchanged.
- **Changing a user's UID is one step on the device.** The user editor saved the record under the new UID and then sent a separate command to remove the old one, so a connection dropped in between left the old card valid with nobody seeing it. The save now names the old UID (`replaces`) and the device stores the new record and removes the old one together; if the old one cannot be removed, nothing is changed and the editor says so.
- **Choosing a scanned Wi-Fi network no longer locks the device to one access point.** The scan filled the BSSID field without saying so and it was saved, so the device then joined only that access point, and stayed off Wi-Fi if it was switched off or replaced. Locking is now a visible "Lock to this access point" checkbox, off by default; only when it is ticked does a scanned network fill in the BSSID that is saved. Existing settings with a BSSID show the box ticked.
- **The log file list refuses a bad page number.** The page asked for by the browser went into `(page - 1) * 20.0` and on into an unsigned size, so a page of 0, a negative one or a huge one was undefined behaviour in the firmware. A page below 1 is now page 1 and the arithmetic is whole numbers that cannot overflow.
- **Signing in says so when the device does not answer.** If the sign-in request failed (device off, phone off its Wi-Fi) or never came back, the sign-in dialog showed nothing at all. It now says "The device did not answer" after a network error or 15 s without a reply.
- **Deleting a user with the user list open in two tabs drops the right row in both.** The device tells every open page that a user was removed, but did not say which, so another tab with a delete of its own waiting dropped that row instead (and kept the removed user's). The message now names the user; each tab drops that user's row, and finishes its own delete only when it is that user.
- **Moving a set clock from the browser is logged.** `settime` was logged only when it set a clock that was not set, so an admin moving a working clock (which decides who gets in on dated and opening-hours users) left no trace. It now logs "Time changed from the browser" with the old and new time (UTC) and the browser's address; the first "Time set" also names the address.
- **README: the reader LED/buzzer transistor needs a base pull-down.** The firmware drives the reader LED and buzzer pins only once the settings are loaded, and never while they are damaged or refused; until then the pin floats and the recommended NPN driver could switch on. The wiring now adds 10 kΩ from the base to GND (the diode wiring needs nothing). No firmware change.
- **Tests: a boot with a damaged `config.json` is now checked.** The README said the QEMU boot test covered the exit buttons and relays set up from their NVS copy, but every boot it ran loaded a good `config.json`, which replaced that copy. The configured-device boot test now adds a third boot with `config.json` damaged: the settings are refused, both relays are driven locked and both exit buttons attached from the NVS copy alone, and no relay is energised. Debug builds log what was set up from NVS at start-up. No change to how the firmware behaves.
- **Tests: the momentary relock deadline is unit-tested.** The deadline that stops a late relock timer from locking a door opened again, held in `main.cpp`, had no test (the native relay tests stub the pulse). It now lives in `core/relaytimer.h` (`RelockDeadline`), used by the firmware as before, with native tests for the 1 ms tolerance, firing once, a re-open during the hold, cancel, the longest hold and 64-bit uptime. No change to how the firmware behaves.
- **Docs: a maglock needs a hard-wired emergency release.** The README's lock wiring now says a maglock must have a release that does not depend on the controller (a fire-alarm relay cutting its power) and advises a green break-glass unit on the escape side. It also no longer claims an unusable pin in a stored configuration is ignored with a warning: the whole configuration is refused, as the firmware does. The 1.4.0 entry names the release file `ironframe-rfid-1.4.0.bin`, as the Update dialog does, and the unused upstream `tools-build-*` GitHub workflows are gone. No firmware change.
- **Tests: the native tests fail if checks go missing.** The runner passed with any count over 100 of its 3,635 checks, so a test that stopped running unnoticed still passed the gate. It now needs at least 3,600. No firmware change.
- **The build stamp counts untracked files, and a release build refuses a bad one.** `scripts/version.py` marked a build `-dirty` only for edited tracked files, so a new untracked source file built in went unmarked, and a tree copied inside some other git checkout took that checkout's commit. Untracked (not ignored) files now mark it `-dirty`, and a tree that is not the top of its own checkout, or no git, stamps `unknown`. Building with `IRONFRAME_RELEASE=1` (release images) fails unless the stamp is clean and HEAD is the tag `ironframe-<IRONFRAME_VERSION>`. New gate `test/check-version.py`. No firmware change.
- **Tooling: a pre-commit hook refuses a commit the gates did not pass.** Nothing tied a commit to a gate run. `test/all.sh` now names the tested tree by its git tree id (`tree <id>` on its last line; untracked files included, as before) and records a pass in `.git/ifrfid-gates/`; the hook (`tools/hooks/pre-commit`, installed by `bash tools/install-hooks.sh`) refuses a commit whose staged tree has no such pass. `git commit --no-verify` is the only bypass. New gate `test/check-hook.sh`. No firmware change.
- **The Status page shows each Wiegand reader's noise counters.** The decoder already counted edges dropped as glitches, frames with bad parity and frames lost to a full queue, but nothing showed them, and frames of no card or key length (or a corrupt 8-bit key) were dropped without being counted. Those are now counted too, and the status reply carries all four per running Wiegand reader (`wiegand`), shown as a **Wiegand Noise** row on Status, so noisy wiring shows before cards stop reading.

## Ironframe 1.4.0 - 2026-10-15

Updates from 1.3.x (or 1.2.x) through Update with the release file `ironframe-rfid-1.4.0.bin` (`bin/esp32wroom.bin` when built from source; the partition layout is unchanged; no serial flash, settings and users are kept). Fixes from the fourth five-reviewer review.

**Behaviour changes, read before updating:**
- MQTT `open`, `opendoor` and `close` are ignored until **MQTT door control** is turned on (MQTT settings).
- With **Require pin code after RFID card** on, a card whose user has no PIN (admin cards too) is refused.
- 10 unknown cards at one reader lock that reader for 30 s, doubling to 15 min; valid cards are refused meanwhile.
- User records are checked: PINs 4-12 digits, names up to 64 bytes. A restore skips users that fail and names them.

- **Exit buttons work when the settings are damaged or refused.** They were only set up from a loaded configuration, so a damaged or refused `config.json` left the door locked with no electronic exit. Each door's exit button and relay settings are now also kept in NVS and the buttons are set up from that copy at power-up.
- **Relay Type and Lock Type must be 0 or 1.** Any other value (from a restored backup, MQTT `updateconf` or a hand edit) was stored as sent: a bad Lock Type never fired the relay, a bad Relay Type made every opening log "Door was tampered!". A save with one is now refused; a stored file with one loads with a warning as Active High / Momentary (the relay was already driven as Active High).
- **The doorbell reads the right way round, debounced.** The pin has its pull-up on, so a button to GND pulls it LOW, but HIGH was treated as ringing: an idle button read as ringing from boot, and a press published OFF. LOW is now ringing, with the same 30 ms debounce as the exit buttons; the MQTT state sent on (re)connect follows it. Wiring is in the README (Doorbell).
- **MQTT `opendoor` no longer locks a door that is held open.** It requested every relay, and a continuous relay toggles, so a door held open was locked. It now opens only the doors that are locked, as `open` already did.
- **MQTT (re)connect publishes the real tamper state.** Tamper was always sent OFF, even during a live alarm, and only on door 1's topic; each door with a contact now sends its own (`io/tamper`, `io/tamper<n>`). Relays with no pin no longer get a lock state read from a pin that does not exist.
- **A PIN typed straight after a serial or SPI card counts.** With PIN required, an RDM6300/MFRC522/PN532 card started the reader's 2 s cool-down at once, so keypad digits typed in those 2 s were thrown away and the half-typed PIN then failed (and counted towards the keypad lockout). The 2 s hold-off after such a card now applies to cards only. Not on a board with Wiegand readers only.
- **No tamper alarm for a door opened just as the lock relocks.** A door pulled open a moment after the release pulse ended logged "Door was tampered!". An opening within 3 s of the relock is now a normal Door Open.
- **No LED or buzzer blip at start-up.** The access-denied LED was switched on (LOW, its on level) when the settings were applied and stayed lit until the main loop started; reader LED/buzzer lines and the board LEDs and beeper were made outputs before their off level was written, a short blip on active-low wiring. Each now gets its off level first, as the relays do.
- **Unknown cards lock the reader.** Only a wrong PIN counted towards a lockout, so a card guesser was slowed by nothing but the 2 s cool-down. 10 unknown cards at one reader, each within 10 minutes of the last, now make that reader refuse every card (valid ones too, logged by name) for 30 s, doubling to 15 min, kept over a restart. It is logged and sent as an MQTT `alarm` message.
- **MQTT door commands are off unless enabled (behaviour change).** `opendoor`, `open` and `close` were accepted from any broker client that named the device's IP, which the device publishes itself. A new MQTT setting, **MQTT door control**, is off by default (also for existing settings, which have no such key): with it off these commands are ignored, logged once until the next restart, and Home Assistant discovery removes the lock entities. **If you open doors from Home Assistant or another MQTT client, turn it on** under MQTT settings.
- **MQTT `getuserlist` no longer publishes PINs.** It sent each stored user file whole, `pincode` included (a PIN-only user's uid is the PIN too), and the `.bak`/`.tmp` copies a save leaves. It now sends user records only, without the PIN (`haspin` instead), and a PIN-only user as uid `keypad`. Needs MQTT remote admin, as before.
- **The device checks user records before storing them.** A user saved from the editor, restored from a backup or sent with MQTT `adduser` was stored as sent: any access value, PIN or date, the `command`/`cmd`/`doorip` keys, a name long enough to break the user list page. Now access must be 0, 1 or 99, a PIN empty or 4-12 digits, valid since/until numbers (valid until required), a name at most 64 bytes (32 accented letters); only these keys are stored, the uid in lower case. A refused user gets the reason in the editor; a restore skips it and names it (next line).
- **"Require pin code after RFID card" refuses a card with no PIN (behaviour change).** A card whose user had no PIN stored opened with the card alone. It is now refused, admin cards too, logged as "Card refused: PIN required, user has no PIN" (MQTT access: `No PIN`); it does not count towards the keypad lockout. **Give every card user a PIN before relying on this setting.**
- **The user editor no longer overwrites a user by accident.** A new user, or an edit that changed the UID, to a UID that already existed silently replaced that user. The editor now asks the device to create only (`userfile` with `create: 1`, checked on the device, since the page's list can be stale); if the UID exists it says so and only a second Save replaces that user. The UID is lower-cased as it is typed and must be 1-32 letters and digits; the PIN must be 4-12 digits.
- **Logout ends the session everywhere.** It revoked the token but closed only the socket that asked, so another tab (or anyone holding the token) stayed connected until it reloaded. Every WebSocket opened with that token is now closed.
- **Content-Security-Policy on the web pages.** There was none, so an injected `<script>` or `onerror=` would have run in the admin's session. The pages now allow scripts, styles, fonts, images and connections from the device only and no inline script (inline styles stay), and cannot be framed; the UI's inline `onclick=` handlers became `data-on*` attributes bound in one place. The user-restore progress bar shows the device's message as text, not HTML.
- **A user restore skips the users the device refuses, and says which.** With the user checks above, a backup holding a user that is now invalid (a 1-3 digit PIN, a name over 64 bytes) stopped at that user, leaving the rest of the backup unrestored. The device now marks such a refusal (`invalid` in the result) and the restore goes on; at the end it shows how many were restored and skipped and lists each skipped user by UID and name with the reason. A user the device could not store (a storage failure) still stops the restore.
- **MQTT commands are held under a memory budget, and a stale door command never runs.** The incoming queue held up to 16 commands of 4 KB each (64 KB of heap) and checked `doorip` only when it got to each one. Commands now share a 12 KB budget (as WebSocket messages do; over it they are dropped and logged), a command whose payload does not contain the device's IP is not queued at all, and a queued `open`/`opendoor`/`close` is dropped (and logged) if the broker connection dropped since it arrived or it is more than 5 s old.
- **MQTT logging no longer loses events while the broker is down.** With MQTT logging on, events were only published, so anything logged while the broker was unreachable (including the disconnect itself and the events at boot before the first connection) was gone. Such events are now written to the Event Log on flash instead (when Logging is on); with the broker up they still go over MQTT only, to spare the flash.
- **Low memory no longer rolls the settings back.** When `config.json` (or a user record) could not be parsed for lack of memory, it was treated as damaged and replaced by the older `.bak`, silently undoing the last settings save. Out of memory now only fails that read (logged as "Not enough memory to read ..."), and both files are left as they are.
- **The loop watchdog is fed while WebSocket and MQTT commands are worked through.** A burst of queued commands (each a flash write or a log page), a log split or a long file list ran without feeding the 8 s loop watchdog, which could restart the board mid-work. Each command, each 512-byte block of a split and each file listed now feeds it.
- **A message the device cannot read gets an answer.** A WebSocket message that was not valid JSON, too big for the device to parse, or without a command was dropped in silence, and the page could wait for ever ("Saving..."). The device now answers with the reason, which the page shows; for a message too big to parse it answers the command it names, so a save or restore waiting for it stops with the message.
- **A firmware update says why it failed, and wrong files are refused first.** A failed update showed a bare "FAIL", and a second upload while one was running was answered 401 as if signed out. The device now checks the start of the image before writing anything (an app image for this chip: not a -full-flash image, not the other chip's) and answers with the reason, the flash error (`Update.errorString()`, e.g. Not Enough Space) or "Another firmware upload is in progress" (409). The page shows it, and checks the file before uploading: the name (no `-full`), the size against the update slot, the first bytes.
- **A Wi-Fi blip no longer signs you out.** A WebSocket reconnect that failed for any reason was taken as a revoked session: the page threw the sign-in away and asked for the password. It now asks the device for a small file first; only if the device answers is the failed reconnect a refusal, otherwise the page keeps the session and retries every 5 s. A retry no longer opens a second socket beside one still connecting, and a frame that is not JSON is ignored instead of raising an error.
- **The user editor no longer sticks on "Saving...".** If the connection dropped, or the device never answered, the editor waited for ever and refused every further save. It now gives up when the connection closes or after 15 s, re-enables Save and says the user may not be saved and to check the list.
- **Relay Test says the relay fired.** The device answered Test, but the page ignored the answer, so nothing on screen showed it had worked. The answer now names the relay and the page shows "Relay N fired".
- **Small UI and discovery fixes.** The sign-in page said "Wait 5 minutes" for every login block, but a device-wide block lasts 1-15 minutes: the device now sends the wait (`Retry-After`) and the page shows it. A known card scanned on Users filled the first text input on the page, not necessarily the table's search box; it now fills the table's own. The Users menu link no longer follows its `#` link (its handler did not return false, as the others do). Home Assistant discovery no longer announces a lock for a relay with no pin.
- **A long WiFi Timeout no longer turns Wi-Fi off early.** The timeout in seconds was multiplied by 1000 in 32 bits, so anything over 4,294,967 s (49.7 days) wrapped and Wi-Fi went off at the wrapped value, days early. It is now compared in 64-bit milliseconds, like the other uptime timers.
- **Test: a configured device boots in QEMU.** The boot test only ever started blank flash. A new gate (`qemu-esp32-configured`) boots the ESP32 build with a LittleFS image holding the VOANZO two-door preset plus exit buttons, twice, and checks the settings load and apply, both readers start, both doors get their relay and exit button, nothing is refused or logged as an error and the loop keeps running. ESP32 only: the S3 emulator cannot read a valid LittleFS image either.
- **Test: the Wiegand interrupt path is checked in the linked image.** `IRAM_ATTR` on the handlers was only a request; nothing checked that they, or what they call, ended up in IRAM, where they must be to run during flash writes. A new gate (`iram`, `test/check-iram.py`) reads both release ELFs and follows every call from the Wiegand ISRs and the IDF GPIO dispatcher; each must land in IRAM or ROM. Controls make sure it resolves calls and flags a known flash function, and an ISR edited to call `millis()` fails it.
- **Test: 24- and 32-bit Wiegand cards and the hexadecimal user id.** Only 26- and 34-bit frames and keys were tested. The native tests now decode 24- and 32-bit frames with and without "remove parity bits" (and pin down that an unstripped 32-bit frame loses its first bit, as upstream did), and the user id a card is stored under, decimal or hexadecimal, is built by `core::wiegandUid` and tested (lower case, no leading zeros, as before).

## Ironframe 1.3.2 - 2026-10-14

Updates from 1.3.x (or 1.2.x) through Update with `esp32wroom.bin` (the partition layout is unchanged; no serial flash, settings and users are kept). Fixes from the third five-reviewer review.

- **Door contacts read the right way round.** A contact closes to GND when the door is shut (as the README and the Hardware page always said), but the firmware read that as open: a shut door raised a tamper alarm at boot, a forced door logged Door Closed, and a cut contact wire read as shut. A cut wire now reads as open. **If you wired a contact the other way to make it work, swap it back to the documented wiring.**
- **A correct PIN no longer resets the keypad lockout.** Anyone who knew one PIN could guess others for ever (four wrong, one right, repeat). Wrong PINs now add up while each is within 10 minutes of the last; an hour after a lockout ends without another, the next one is 30 s again.
- **A settings save can no longer leave the hotspot without a password.** If the stored settings could not be read during a save (low memory, damaged file), the saved passwords were dropped and the hotspot came back open. Such a save is now refused with a message to try again.
- **An update is no longer undone by a power cut.** A new image was only confirmed once someone opened the web page; if nobody did, the next power cut silently put the old firmware back. It is now confirmed after an hour of running anyway, and a rollback is logged ("A firmware update was rolled back").
- **No heap churn when there is nothing to log.** The log writer allocated and freed memory about 2,000 times a second even with nothing to write; over months that fragments memory.
- **An admin card no longer restarts the hotspot** (it dropped everyone connected to it). It still turns Wi-Fi back on after WiFi Timeout switched it off.
- **Changing Relay Type no longer releases the lock at the next boot.** The locked level used at power-up is now stored when the settings are saved, not after the restart.

## Ironframe 1.3.1 - 2026-10-14

Updates from 1.3.0 (or 1.2.x) through Update with `esp32wroom.bin` (the partition layout is unchanged; no serial flash, settings and users are kept).

- **Memory can be watched over weeks of uptime.** Status shows the largest free block (falls if memory fragments) and the lowest free heap since the last restart, next to free heap. Once an hour the Event Log gets a `Memory` line with all three and the uptime, so a slow leak shows as a falling series without anyone checking by hand.
- **Release files are named by version.** Releases carry `ironframe-rfid-<version>.bin` (the Update file, = `bin/esp32wroom.bin`), `-full-flash.bin` (serial), `-SHA256SUMS.txt` and `-README.txt`, and the Update dialog on the ESP32 asks for `ironframe-rfid-<version>.bin`.

## Ironframe 1.3.0 - 2026-10-14

Updates from 1.2.x through Update with `esp32wroom.bin` (the partition layout is unchanged; no serial flash, settings and users are kept).

- **Hardware page reorganised.** Setup (how many doors, how many readers) at the top, then the settings common to all doors, then one panel per door with its relay, name, sensor, exit button and the reader(s) that open it. Each reader's D0/D1 are named by their reader ("Reader 1 D0"), so two readers show exactly two D0/D1 pairs. The door count applies at once (no "update" button).
- **One door with a reader each side.** Doors = 1 with Readers = 2 puts both readers on door 1 and sets reader 1 to In and reader 2 to Out. The side is logged, not enforced: the Access Log has an In/Out column, the event log names the side, and MQTT access messages carry `direction`. Setting: `hardware.readerN.direction` (0 not set, 1 in, 2 out).
- The settings review names door 1's sensor and exit button as door 1's.

## Ironframe 1.2.1 - 2026-10-14

Updates from 1.2.0 through Update with `esp32wroom.bin` (the partition layout is unchanged; no serial flash, settings and users are kept).

- **A card scanned on the Users page fills in New User again.** Since the web page moved to jQuery 3, scanning an unknown card opened New User with the UID empty, so the card could not be enrolled by scanning (it worked on the original ESP8266 software). The table's add handler runs a moment after the click and cleared the form; the scanned UID and type are now filled in after that. The browser test covers an unknown card, New User by hand afterwards, and a known card.

## Ironframe 1.2.0 - 2026-10-14

Updates from 1.1.0 through Update with `esp32wroom.bin` (the partition layout is unchanged; no serial flash, settings and users are kept).

- **Readers no longer stop after 24.8 days.** A known card never started the reader's cool-down timer, and the 32-bit time comparison then made both readers ignore every card and key for 24.8 days. Every timer now runs on a 64-bit uptime clock. The keypad lockout and the login block, which could come back on by themselves after the same 24.8 days, are fixed with it.
- **One keypad lockout for the whole device, kept across a power cut.** Two readers no longer give twice the guesses, and a restart resumes a lockout instead of clearing it.
- **Saving settings can no longer change the admin password** (a browser left signed in could do it without the current password, as could MQTT `updateconf`). Only Change Password changes it.
- **PINs are never logged, published or shown.** A PIN-only entry is recorded as `keypad` with the user's name; MQTT access events no longer carry `pincode`; the Home Assistant "PinCode" sensor is removed on the next discovery.
- **Relays are driven locked first thing at power-up**, from the last loaded settings kept in NVS, instead of floating until the settings were read (seconds).
- The fallback hotspot is no longer replaced by a hotspot with the home Wi-Fi name and password when an admin card is swiped. With fallback on, a Wi-Fi link lost for 5 minutes also opens the fallback hotspot.
- **Login guessing:** 20 failed logins in 5 minutes from any mix of addresses refuse every login for 1 minute, doubling to 15 (the per-address limit alone could be dodged). Signed-in sessions and cards keep working.
- **Wiegand:** frames are split in the interrupt, so a busy moment no longer merges a card and a key press into noise; an edge less than 150 µs after the previous one is ignored as noise.
- **Recovery without a serial cable:** while the storage is damaged (the board is locked and offline), holding BOOT for 10 s erases it and restarts into the setup hotspot. A factory reset interrupted by a power cut is finished at the next boot.
- **Status shows why the board last restarted** (power on, brown-out, watchdog, crash) and whether a crash dump is stored; every boot logs it.
- **Doors 2-4 get their own door sensor, exit button and "left open" alarm** (Hardware page, in each relay section). Door 1 keeps Door Status Pin and Open Lock Pin. MQTT: `io/door<n>`, `io/tamper<n>`.
- Robustness: the WebSocket has a total memory budget (a client could run the board out of memory); the watchdog is fed while walking the user list and writing logs, and the log is written in 100 ms slices so a backlog no longer holds up the readers.
- Web page: a refused Save & Reboot keeps the staged changes and shows the reason (settings are checked in the page with the device's own rules first); the first save on a fresh board keeps its hotspot name; after a restart the page reconnects to the same address and reloads by itself; no blocking pop-ups; the review lists changes by field name; a backup file of the wrong kind is reported; Edit user waits for the device; wording, labels and phone layout fixes.
- Code: the reader session, settings loading and door monitoring are core code tested on the host; settings use fixed buffers instead of strdup'd pointers; WebSocket commands are a table; storage, lifecycle and clock have their own files; the web UI script is split into modules. New gate `check-protocol`; `tools/bootstrap.sh` installs the toolchain.

## Ironframe 1.1.0 - 2026-10-14

- **PIN fix (behaviour change).** A card's own number no longer works as its PIN, and in "Allow pin code only" mode typing an enrolled card number no longer opens the door. Only the stored pincode is compared. Keypad-only users are enrolled with the PIN as both the UID and the Pin code; a card with no PIN cannot be reached from the keypad. Digits that match nobody are logged as a wrong PIN, not as an unknown card.
- **Keypad lockout.** After 5 wrong PINs in a row a reader refuses PINs for 30 s, doubling with each further lockout up to 15 min; a correct PIN resets it. Cards that need no PIN still work during a lockout. Every wrong PIN and every lockout is written to the event log (and sent over MQTT when MQTT event logging is on).
- **Clock not set (behaviour change).** 1.0 refused everyone, admins included, while the time was unknown, which on a hotspot-only install is after every power cut. Now admins and Always users with default dates get in; dated users and opening-hours-limited users are refused until the time is set. The browser sets the device clock after login when it is not set. Status shows the clock state, and the event log records "Time not set" / "Time set".
- Opening hours took the day from UTC and the hour from local time; both are local now.
- **Relay timing.** Momentary relays are relocked by a hardware timer instead of the main loop, so a busy loop can no longer stretch an unlock (an admin card that also turned Wi-Fi on held the door about 18 s). Connecting to Wi-Fi no longer stops the loop for up to 15 s (also every 5 min while the router is down). Relay pins get their idle level before becoming outputs, so active-low relays do not pulse at boot.
- **OTA rollback and watchdog.** A new firmware image must run for 60 s and serve the web UI once before it is confirmed; if it restarts before that, the board goes back to the previous image. A main loop stuck for 8 s restarts the board. The event log records "New firmware confirmed".
- **Firmware upload and password change.** Firmware uploads are refused while the admin password is still the factory one. Changing the password now asks for the current password (except the forced first change from `admin`).
- **Wiegand parity.** 26- and 34-bit frames with bad parity are dropped (and logged) instead of being read as a possibly different card. Checked when "Remove parity bits" is on (the default); with it off, frames pass through unchecked as before.
- **Deleting a user** (web UI or MQTT) also removes the user's `.bak` and `.tmp` files; a leftover `.bak` used to bring the user back on the next swipe. At boot, unfinished writes are removed and leftover backups are settled.
- **Relay time** must be 100-30000 ms; other values are refused on save and clamped (with a warning) when an older config is loaded. A negative value used to keep the door unlocked.
- Restoring `config.json` from its backup is now logged as a warning (it was silent).
- With "PIN required", a card read by the RDM6300 of a Wiegand+RDM6300 reader now gets the PIN prompt and its 10 s timeout; it used to leave the reader waiting for a PIN indefinitely. (The "PIN required" + "PIN only" hang is fixed by the PIN change above.)
- The door contact is debounced (50 ms, as the exit button already was), so a bouncing reed switch no longer logs a burst of Door Open / Door Closed events or a false tamper alarm.
- **Flash layout (ESP32 / VOANZO), needs one serial flash.** Two 1.5 MB app slots (were 1.25 MB, 91 % full), about 900 KB LittleFS (was 1.4 MB) and a 64 KB core dump. The serial flash erases users, settings and logs: back up and restore (see the README).
- The icon font is served as woff2 only (the unused woff copy is gone, about 23 KB of flash).
- **Open hotspot warning.** Status shows "Hotspot has no password — anyone nearby can reach the login page" with a link to Wireless Network whenever the running access point is open (always the case for the fallback hotspot). A password stays optional.
- Web page: the Update dialog names the image for this board (`esp32wroom.bin` on the ESP32; it always said `esp32s3.bin`).
- Web page: "Every 30 days" auto restart now means 30 days (it was 18144000 s, 210 days).
- Web page: **user validity dates are whole local days.** "Valid since" is the start and "Valid until" the end of the chosen day in the browser's time zone; the date picker value used to become UTC midnight, so access ended a day early (from 01:00 on the chosen day in the UK). Existing users keep their stored times until edited.
- Web page: Status says "Free storage" (it said "Free SPIFFS"; the filesystem is LittleFS).
- Web page: a newly added relay starts at 3000 ms (it got 300 ms from the page template, too short for most locks); the Activate Time field only accepts 100-30000 ms.
- Web page: the Status heap bar is scaled to the heap size the board reports (it assumed the ESP32-S3).
- Web page: unsaved changes show as "Unsaved changes" with a plain list of what differs from the saved settings (passwords only as "changed"), instead of the whole configuration as raw JSON.
- The Hardware page Test message for a relay without a pin now says "set it under Hardware, then Save & Reboot" (it said "press Save first", which only stages the change).
- Web page (phones): help icons open on tap or keyboard focus and close on the next tap anywhere (they needed hover).
- Web page (phones): only a swipe that starts at the left edge opens the menu, and a left swipe closes it; scrolling a wide table sideways no longer opens it.
- Web page (phones): settings labels sit on their own line above the field instead of a quarter-width column.
- Web page: editing a user no longer makes the whole user table disappear until the page is reloaded.
- Web page: changing a user's UID in Edit moves the user (the old record is removed once the new one is saved); it used to leave the old user able to open the door.
- Web page: Delete keeps a user in the table until the device confirms the removal.
- Web page: a settings page is filled in as soon as it opens; for about half a second its Save button was live over unfilled fields (General then failed silently).

## Unreleased - access-controller hardening

- Fail closed while wall-clock time is untrusted, including admin credentials.
- Bound and validate RDM6300 serial frames; use collision-free PN532 UID encoding. PN532 user IDs now use two hex digits per UID byte, so existing PN532 records must be re-enrolled under their canonical IDs.
- Make config/user writes verified and atomic, with a last-known-good config backup.
- Keep commissioned devices offline and locked on filesystem/config corruption instead of reopening factory enrollment.
- Make MQTT `close` lock momentary relays immediately.
- Reject reader-door and fixed-SPI-pin conflicts; exclude ESP32 GPIO36/39; require pull-up-capable sensor pins.
- Bound keypad PIN input, enforce WebSocket connection expiry, fix legacy timezone signs, and preserve 0-600 second door-open alarms.
- Initialize door/tamper state safely at boot and report save/update failures honestly in the UI.

## [2.0.0] - 2024-11-02

### Bugfixes
Too many to list, but all of the confirmed bugs up to now have been fixed.

#### Breaking changes
- [firmware] Removed build flag for `OFFICIALBOARD` #533 @matjack1
- [firmware] MQTT endpoints have been changed to be more consistent and complete #501 @matjack1

#### Added
- [firmware] Addedd support for software serial to support RDM6300 sensors on custom pins #655 @teodino93
- [firmware] Moved to native Arduino support for timezone and NTP to support daylight saving time #604 @matjack1
- [firmware] Added door name, to send via MQTT access type and door name for setups with multiple doors #598 @matjack1
- [firmware] Added more options for Wiegand readers on which bits to read #582 @matjack1
- [firmware] Added support for MQTT auto-topic with topic postfixed with 6 characters from MAC address #566 @matjack1
- [firmware] Added support to read/write configuration via MQTT #565 @matjack1
- [firmware] Added valid-since date for user validity #562 @matjack1
- [firmware] Added support for pincode only option to open door #551 @matjack1
- [webui] Improved support for websocket reconnection #502 @matjack1
- [firmware] Added opening hours with an hourly granularity #499 @matjack1
- [firmware] Added LED to signal that we are waiting for pincode and beeper support #490 @matjack1
    - beeper for valid, denied or admin access 
- [firmware] Added different pincode for each user after a card swipe #477 @matjack1
- [firmware] Improvements in MQTT including AutoDiscovery for the Home Assistant #449 #559 @xyzroe
- [firmware] Added anti-tamper support #449 @xyzroe
- [firmware] Added pin to give users feedback when access denied #426 @matjack1
- [firmware] Added ability to delete a single user over MQTT via UID #424 @baden02
- [docs] improved MQTT documentation #416 #423 @matjack1 @baden03
- [firmware] added doorbell support #415 @matjack1
- [firmware] improved decoding of Wiegand keypresses #360 @christofkac
- [firmware] added support for multiple relays #318 @frenchie71
- [firmware] optional BSSID for wifi connections #307 @frenchie71
- [firmware] Initial support for Wiegand Keypads @frenchie71
- [firmware] Initial support for OTP (TOTP) @frenchie71
- [webui] Added Download function for log files @frenchie71
- [webui] Log file options on WebUI @frenchie71
- [firmware] Log Maintenance Split, Rollover, View, Delete @frenchie7
- [firmware] Added button to open door and door status pin @nardev

#### Changed
- [firmware] Changed timezone support to add daylight saving management #604 @matjack1
- [firmware] Refactor WiFi connection #495 #497 #536 @matjack1
    - Option to disable access point mode for production usage
    - Automatic retries when connection drops
- [firmware] Refactor configuration #485 @matjack1
- [firmware] Upgrade to ArduinoJSON v6 #483 @matjack1
- [tools] Added Github Actions instead of Travis CI for building esp-rfid and ancillary tools #478 #482 @matjack1
- [firmware] Improved MQTT support #475 #476 #484 #487 #488 @matjack1
    - added queue for message processing to avoid watchdog timeout
    - ACK message on processing, to enable throttling of incoming messages
    - better reconnection on WiFi reconnections
- [firmware] Refactor RFID reading #471 #491 #496 @matjack1
    - separate reading card, reading pincode, processing
    - better support for external feedback, LEDs, beeper
- [tools] updated Gulp scripts for building web UI #414 #473 @matjack1
- [firmware] improved wifi handling #374 #375 @ingeninge
- [firmware] Wi-Fi connection routine is now improved @frenchie71
- [firmware] Log file operations are now more robust @frenchie71

## [1.3.3] Test-Release 2019-06-22
#### Fixed
* PlatformIO **ISR not in IRAM!** Hotfix

## [1.3.1] Test-Release 2019-06-21
#### Added
- [firmware] Support for Door Status tracking with log and mqtt options @nardev
- [firmware] adding mqtt_publish_info, generateUid functions @nardev
- [firmware] MQTT functionality is greatly improved thanks to @marelab 

Reading all user data over MQTT
Sending User data to RFID-DOOR/ESP-RFID over MQTT
Sending door open command over MQTT
Sending door status over MQTT as event
Sending Sync of a RFID-DOOR (IP/Hostname) over MQTT
Configure Sync interval over ESP-RFID GUI
Deleting all User of a ESP-RFID device over MQTT
Sending log event & access data over MQTT

#### Changed
- [firmware] Renaming some variable names @nardev
- [firmware] order of settings in web and hr lines @nardev

#### Fixed
- [webui] Make possible to connect WebUI behind NAT-ed network @Pako2 @abdulhanananwari
- [firmware] Issue #240 "Backup User Data only returns some users" @nardev

## [1.0.2] 2019-01-28

### BREAKING CHANGES (These changes will break your data on device, please make sure made a backup, also you can not use your old settings on this release but only can restore user data)

#### Added
- [firmware] Open/Close Button support @donatmarko
- [firmware] Logging Open/Close Button @donatmarko
- [firmware] the VERSION string is now defined at the beginning of main.cpp @Pako2
- [firmware] #218 Added latching relay support @donatmarko
- [firmware] #189 Flash layout changed to 2MB Firmware / 2MB SPIFFS Data @Pako2
- [firmware] Support for RDM6300 RFID readers (125kHz, UART) #163 @arduino12 / concurrently by @Pako2
- [firmware] debug firmware for debugging purposes
- [tools] executables for tools (no longer need to have node js and gulp for web ui development - **only lightly tested**)
- [firmware] LED_BUILTIN lights up while wifi connected and flashes when it waits for wifi @Pako2
- [webui] IP address choice option in AP mode @Pako2
- [webui] favicon.ico @Pako2
- [tools] websocket emulator can now store new configuration temporarly
- [firmware] log for firmware update #152
- [webui] Expired access attempts logged as "Expired"

#### Fixed
- [firmware] UART Monitor speed @donatmarko
- [firmware] avoid double Serial.begin @Pako2
- [firmware] removing redundant terminating null character  @Pako2
- [firmware] fix the loadconfiguration loop @Pako2
- [firmware] not able to connect MQTT server #157 @fivosg
- [firmware] a MQTT message typo #157 @wamboin23
- [webui] some breaks on web pages
- [webui] usage of !important CSS rule
- [firmware] #191 relay type inversion @Pako2
- [firmware] #190 Increase PN532::WaitReady debug level @Pako2
- [firmware] validuntil is being ignored #151
- [firmware] the boot loop when ssid is empty on configuration file (actually more a workaround than a fix) #154

#### Changed
- [firmware] unify output format debug print of PICC @Pako2
- [firmware] Improve onWsEvent() function @Pako2
- [build] Change release type to a zip file (was tar.gz before)
- [webui] scrollbar on desktop screens (now hidden)
- [webui] sidebar colors (i hope you like it, standart bootstrap color)
- [webui] sanity check for firmware update file #152
- [firmware] lock MFRC522 library to version 1.4.1

## [0.8.1] 2018-09-01
#### Added
- [firmware] Global websocket message to inform ws clients to toggle relay (upcoming client version will use it)
- [webui] incremental id for event log

#### Fixed
- [webui] available flash space calculation
- [webui] #143 duplicate records on User Data backup
- [firmware] #140 MQTT Heartbeat
- [webui] official board's hardware settings did not populate

#### Changed
- [firmware] do not initialize serial output unless we are debugging
- [build] slice main.cpp to multiple parts for better readability
- [webui] Access Type Active to Always
- [firmware] more reliable activation of relay

## [0.8.0]
#### Breaking Changes
- [firmware] Flash partition is changed to 1+3 !!! You need to backup your settings and users before updating to this version
- [firmware] For wiegand readers card id's changed hexadecimal to decimal !!! You need to change hexadecimal values to decimal values on your user backup file

#### Added
- [build] Optimize code for official board
- [firmware] mqtt boot, hearthbeat, access message added

#### Fixed
- [firmware] #128 Do not retain MQTT publishes
- [firmware] Compiller warnings fixed

#### Changed
- [webui] Default wifi type to AP
- [firmware] MQTT Messages are now plain JSON encoded texts
- [build] flash.bat file now asks which firmware to flash

## [0.7.6] - 2018-07-13
#### Fixed
- [firmware] #98 WDT Reset

## [0.7.5] - 2018-06-09
#### Fixed
- [build] BearSSL dependency error with Platformio
- [webui] #115 version numbering
- [firmware] #101 Permanent AP Mode

#### Changed
- [build] Updated PlatformIO configuration file for next PIO release

## [0.7.4] - 2018-04-28
#### Fixed
- [webui] comment out access types
- [firmware] fix a compile warning
- [firmware] change startAP behaviour
- [firmware] publish username to MQTT broker
- [firmware] mqtt username password memory collusion

#### Removed
- [firmware] Modified header

## [0.7.3] - 2018-04-04
#### Added
- [firmware] More debug messages

#### Fixed
- [webui] minor fixes suggested by Codacy
- [webui] get javascript values as real integers

## [0.7.2] - 2018-04-02
#### Fixed
- [webui] MQTT is enabled by default.

## [0.7.1] - 2018-03-30
#### Added
- [firmware] + [webui] Option to use static IP address #89 @nbaglietto
- [firmware] + [webui] Option to hide SSID on AP Mode #89 @nbaglietto
- [webui] Auto focus on login password #94 @pidiet
- [firmware] event log for MQTT

#### Fixed
- [webui] We were checking wrongly if the browser has previously had authentication over /login.
- [webui] MQTT listed disabled even if it is enabled #92 @pidiet

## [0.7.0] - 2018-03-23
#### Added
- [firmware] !!! BREAKING CHANGE !!! 2 MB Flash 2 MB SPIFFS size for future proof firmware updates plase make sure you made a backup before updating to this version. You need to format SPIFFS.
- [firmware] Experimental PN532 RFID Reader Support
- [webui] Try to connect button upon inprogress complete.
- [webui] Restart without saving changes.
- [firmware] Staging framework for platformio

#### Changed
- [webui] Sign in panel now integrated into index.html
- [firmware] Reduced serial outputs.
- [firmware] Switched to Async MQTT Library, needs testing.

#### Fixed
- [firmware] Logs causing Exception 9 because we are delaying async function with NTP sync by WiFi.hostbyname
- [webui] wrong version is shown #80.
- [webui] whole html was shifted with previous css change.

#### Removed
- [firmware] Factory reset via pin

## [0.6.1] - 2018-03-14
#### Added
- [firmware] ICACHE_FLASH_ATTR and ICACHE_RAM_ATTR decorators (did not feel any difference in terms of speed, keeping it anyway).
- [dev tools] Web UI Demo https://bitadvise.com/esp-rfid/
- [dev tools] Websocket emulator access log

#### Changed
- [webui] Always show sidebar on big screens
- [webui] Better versioning.

#### Fixed
- [build] Platformio bug

## [0.6] - 2018-03-11
#### Added
- [firmware] Restart ESP if softAP fails.
- [webui] Colorize access log based on result.

#### Fixed
- [webui] progress bar for factory reset, update, save settings does not initiated correctly.
- [webui] BSSID is missing when first scan.
- [webui] Now firmware internally holds only unix time, made changes on webui to cover that.

#### Changed
- [webui] Completely refactored html loading, we are getting all files at first login, then no request is made to web server which greatly simplifies some functions.
- [webui] + [firmware] Completely refactored Latest Access Log, it's now unlimited Access Log which holds every picc scan. This should fix #60 (at least there is clear log button :) ).
- [webui] Event log table now displays firmware time for early events.
- [webui] before fetching data wait sidebar to dismiss for smooth animation.
- [webui] fade in web content.
- [firmware] Log login remote IP address.

## [0.5.4] - 2018-03-09
#### Added
- [webui] colorize event logs based on severity.
- [webui] progress bar on saving settings.
- [dev tools] event log for websocket emulator

#### Fixed
- [firmware] Fix #75 Scan of wifi returns more columns of the same wifi.
- [webui] Fix #74 #33 completely New user with incorrect validity.
- [webui] New user with incorrect date.
- [webui] Editing user results non parsed values.

#### Changed
- [webui] event table breakpoints.

## [0.5.3] - 2018-03-08
#### Added
- [webui] Firmware Update is now live with latest version check on GitHub.

#### Fixed
- [firmware] Update was possible with an unauthorized HTTP Post.

## [0.5hotfix2] - 2018-03-07
#### Added
- [webui] Factory reset within Web UI.
- [webui] + [firmware] Event logging is now live.

#### Fixed
- [firmware] Can not with default password login on fresh setup.

#### Changed
- [webui] Changes suggested from Codacy.

## [0.5hotfix1] - 2018-03-06
#### Added
- [firmware] **!!!! Breaking Change !!!!** Factory reset on boot if GPIO-16 is LOW or SPIFFS is corrupted. Make changes accordingly.
- [webui] Touch detect on touch enabled devices in order to open/close sidebar on swipe.
- [webui] Logout is now live (this is actually a dirty hack);

#### Fixed
- [dev tools] - Websocket emulator time was static
- [firmware] #68 NTP functions cause Exception 9 and ESP crashes

#### Changed
- [webui] Embarrassing multiple HTM pages now reduced to one.
- [webui] Better representing of device and browser times on NTP settings.
- [webui] Prevent closing restore modal until it is finished.
- [firmware] Refactored NTP.

#### Removed
- [webui] Removed GPIO-16 options due to it is being used for Factory Reset
- [firmware] Drop usage of NTPClientLib.

## [0.5beta] - 2018-03-02
#### Added
- [firmware + webui] Embedded web files
- [firmware + webui] MQTT to main branch.
- [firmware + webui] Access column to logs for the information, if the access was granted or not @romanzava
- [build] Travis CI
- [firmware] Glyphicons redirection for SPIFFS's limited 32 char filename.
- [dev tools] WebSocket emulator for rapid web page development. (This require node.js)
- [build] Gulp script for auto css/js file concat and gzip
- [dev tools] Offline static web page development capability (enter "neo" as admin password for local testing)
- [dev tools] gulp script for PROGMEM web files.

#### Changed
- [webui] New look and feel - refactored Web UI
- [webui] Hardcoded FooTable Add/Edit text
- [webui] Only support woff glyphicons font
- [dev tools] Clean and beautify main.cpp @nardev
- [webui] Minor cosmetic changes
- [webui] Javascript loading moved to end of the html
- [build] more meaningful directories for web files.
- [webui] RSSI percent calculation
- [firmware] Limit printScanResult to 5 best (based on RSSI) networks around (esp becomes unresponsive if there are too many networks)
- [build] pio script where we were trying to modify flashing parameters it was affecting SPIFFS upload too.

#### Fixed
- [firmware + webui] MQTT - UID publish was missing.

#### Removed
- [firmware] Web files no longer contained in SPIFFS
- [firmware] SPIFFS Editor.
- [firmware] Confusion about MFRC533 reader.

## [0.4alpha] - 2018-01-21
#### Added
- Initial Wiegand Reader (RFID Reader) support. - @nardev
- Use secure WebSocket protocol if there is a reverse proxy available. - @thunderace

#### Changed
- Default IDE is now PlatformIO, from now on Arduino IDE support is dropped.
- SPIFFS Editor's password is now same with the administration password -@thunderace
- SPI SS pin is now have a default value 15 when there is no configuration file. - @thunderace

## [0.3beta] - 2017-12-24
#### Fixed
- Partly fixed (We still have a quirk with adding new user, may fixed by library level) [#33](https://github.com/omersiar/esp-rfid/issues/33)

## [0.3beta] - 2017-12-09 (zeraien)
#### Fixed
- Fallback AP now gets SSID ESP-RFID-xxxxxx (last 6 digits of mac).
- Also refactored to remove code duplication, new method startAP(ssid, password=NULL) rather than duplicating AP creation.

## [0.3beta] - 2017-12-09 (zeraien)
#### Added
- Automatically disconnects wifi until an "admin" card is read in by the user. Default is to keep wifi on unless configured otherwise.
- Add automatic restart setting, to lessen risk of memory leaks and crashes.
- The wifi network created will have the same name as the "hostname", in case you have multiple units nearby

#### Changed
- Also some minor tweaks to web interface.

## [0.3beta] - 2017-12-03 (thunderace)
#### Added
- [MQTT support](https://github.com/omersiar/esp-rfid/tree/mqtt) is on another branch.

## [0.3beta] - 2017-10-28
#### Added
- Basic Authentication on WebSocket

#### Changed
- minor cosmetic change

#### Fixed
- WebSocket fails without null pointer on Mac [#17](https://github.com/omersiar/esp-rfid/issues/17)

## [0.3alpha3] - 2017-09-06
#### Added
- New /compiledbin/flash.bat for easy flashing (For Windows Users)
- Sort Latest Log by Date
- 2 second cooldown for RFID Tag scans (to prevent double scans)

#### Changed
- Refactored Wi-Fi Network Scan. Now we are scanning hidden networks too, also additional info is now given to Web UI (Signal Strenght, BSSID of the Network also non used Encryption Type, Channel)
- Scanned Wi-Fi Network List is now sorted by Signal Strenght (RSSI, greater is better)

## [0.3alpha2] - 2017-08-31
#### Added
- Uptime to status
- Tooltips for settings

#### Removed
- Captive Portal

## [0.3alpha1] - 2017-08-28
#### Added
- Support for both Active Low and Active High Relays
- Basic loging (inefficent and limited to last 15 records)

#### Fixed
- #11 Simplified captive portal behaviour for stable AP Mode experience.

## [0.3alpha] - 2017-08-18
#### Added
- Support for jQuery v1.12.4
- Support for Bootstrap Javascript v3.3.7
- Support for Bootstrap Glyphicons
- Support for FooTable v3.1.6

#### Changed
- Refactored picclist command (JSON Array is now more human readable, can be queried page by page, initially 15 records per page due to Mobile Devices limiting maximum WebSocket message lenght, I do not know if this a feature or a bug)
- Restoring User Data is improved (restoring is now done one by one only when the ESP is ready to digest another userfile)
- Backup User Data is improved (thanks to newly optimized userlist command we are getting all the data from ESP page by page)
- Refactored User List (thanks to FooTable user list is now fully searchable, sortable, filterable, editable)
- Refactored framework's required Javascript and CSS files (All files minified and gzipped together, this will reduce requests made to ESP)
- While restoring user data now we are showing a pop-up (bootstrap modal)

#### Misc
- Run a test where 1000! users can be handled (see https://github.com/omersiar/esp-rfid#tests)

## [0.2] - 2017-08-09 We hit the V0.2 thanks to rneurink
#### Added
- BSSID Setting (This will allow to connect specific Access Point if there are more than one AP with the same SSID)
- Available SPIFFS storage [@rneurink](https://github.com/rneurink/esp-rfid/commit/5b962538bbf1c3234c05cea9ec8bf24f81ad6561)

#### Fixed
- Incorrect time were being sent to device (without timezone offset)
- Device Status in AP Mode [@rneurink](https://github.com/rneurink/esp-rfid)
- ESP gets unresponsive when device is in AP Mode (https://github.com/omersiar/esp-rfid/issues/11)

#### Changed
- Colorize progress bars depending on percentage [@rneurink](https://github.com/rneurink/esp-rfid)
- haveAcc to acctype (This will break backward compatibility if you made backup on previous version, there is a workaround that i can share if anyone wants)
- Switched to new NTP Client Library https://github.com/gmag11/NtpClient/

## [0.2rc2] - 2017-08-07
#### Added
- Time Settings
- Hostname Setting
- UID sanity check on Users Page

#### Fixed
- Restoring Users too fast (increased to 200ms) [@rneurink](https://github.com/rneurink/esp-rfid)

#### Changed
- Device Status location
- Bootstrap Version to v3.3.7

#### Removed
- Dropped NTPClient Library Usage (since we have TimeLib)

## [0.2rc1a] - 2017-08-03
#### Added
- New WebSocket command "status" (sends bunch of information to browser)
- Device Statics on Settings Page
- Restoring User Data (restoring large backups can take a while because we are sending user data to ESP one by one and waiting 100ms each time to make sure ESP can handle it)

#### Changed
- Branding (Copyright symbol is dropped, feel free to use this project as you want) See [License](https://github.com/omersiar/esp-rfid/blob/master/LICENSE)

## [0.2rc1] - 2017-08-02
#### Added
- Refresh page after saving settings. [@rneurink](https://github.com/rneurink/esp-rfid)
- Captive Portal for easy first setup. [@rneurink](https://github.com/rneurink/esp-rfid)
- Long-time-missing the "Remove" button. (Initialy we were getting always valid UID but now things were changed)
- Administrator Password setting.
- Basic Backup / Restore facility. (For now we can only restore settings not the Users)

#### Fixed
- Settings Page shows "... WebSocket connecting" message even if the connection was made
- Quirk in Sorting User List

#### Changed
- Config File now is more human readable.

#### Removed
- SPIFFS Update from Web (we will likely be able to update it directly from Internet)

## [0.1a] - 2017-07-14
#### Added
- Now you can select Wi-Fi mode.

#### Fixed
- Some fixes (features) were not included in previous release
- NTPClient wastes CPU time when device is in AP mode. (probably tries to force update time)

## [0.1] - 2017-07-12 - :hurray: We hit the 0.1!
#### Added
- Relay Module configuration in Settings Page (You need to make sure how the relay module reacts when device is restarting or on power-on, make changes accordingly). I may try to make it more universal, but for now it's up to you.
- Relay Test Button
- Ability to Add known PICC to User List (useful to add new PICC to device when device is already deployed)

#### Removed
- We do not need hardware reset anymore this frees a GPIO from MCU. (suggested by @farthinder [#6](https://github.com/omersiar/esp-rfid/issues/6) )

## [0.1rc2] - 2017-07-10 - Release Candidate
#### Added
- User List table now automaticly sorted by Name
- Click on an any element on User List to edit via Add / Update User
- User List actions are instantly happens on the ESP hardware.

#### Fixed
- Javascript functions (As suggested from JSHint and Codacy)

#### Misc
- Run a test where 100 seperate User can be handled (see https://github.com/omersiar/esp-rfid#tests)

## [0.1rc1] - 2017-07-05 - Release Candidate
#### Added
- Simple Firmware Update from settings page
- SPIFFS Update from settings page
- Now you can define a user name (or any label) for each PICC
- Now each PICC can be individually configured for access (before this, every known PICC had an access)

#### Fixed
- Logging In Authorization is now done via Async XMR Request. Browsers does not complain about it being synchronous anymore. (Tested with Chrome and Firefox)

#### Changed
- Inform web user while pages are loading https://www.nngroup.com/articles/response-times-3-important-limits/
- Configuration rutine
- Seperate settings page and Users specific page

#### Removed
- Appending ChipID to hostname

## [0.0.3] - 2017-06-22
#### Added
- RFID Hardware Pin and Gain settings via Web
- New WebSocket commands and better command scheme

#### Fixed
- can not fallback to AP Mode if configuration file is missing/corrupt

#### Changed
- Seperate Javascript file
- Refactor settings page
- Refactor Fall Back to AP Mode behaviour
- Rafactor configuration file structure
- Web page files now have support for mobile devices and as well as PCs

#### Removed
- Jumbotron CSS

## [0.0.2] - 2017-06-10
#### Added
- 'Settings' Menu - (and some snippets)
- Wi-Fi Client Settings can now be configured via Web

#### Changed
- STA - AP Mode behaviour is improved
- Minor changes

## [0.0.1] - 2017-05-10
#### Misc
- Initial public upload
- Code is now heavily commented
