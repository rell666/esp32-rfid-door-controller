# Ironframe RFID (esp-rfid for ESP32-S3)

This is an Ironframe-branded fork of [esp-rfid](https://github.com/esprfid/esp-rfid) (MIT) 2.0.0. It runs on the **ESP32-S3** and on the **original ESP32**, including the VOANZO / LC-Tech 2-relay board (two doors with two standalone Wiegand readers, see [below](#two-doors-voanzo-esp32-2-relay-board--two-standalone-wiegand-readers)), fixes the log corruption and slow-UI problems found in a review on 2026-10-11, and closes a set of security holes. The web UI is Ironframe's own since 1.5.0: phone first, with the Ironframe logo and palette, and no library (upstream's jQuery, Bootstrap and FooTable are gone).

> **Hardware status:** compiled and tested with host unit tests, a headless-browser UI test, Espressif QEMU and static checks. It was also flashed successfully to a spare original-ESP32 DevKit and the web UI was verified on 2026-10-12. The target VOANZO board was flashed on 2026-10-13/14: it boots, the first-boot fixes are verified and both relays click on Test, it was updated over the air to 1.2.1 on 2026-10-14 and to 1.4.3 and then 1.7.0 on 2026-10-16 (1.9.1 was run on it on 2026-11-05 and reported working well, with no individual checks listed; 1.8.1's and 1.9.0's changes were checked on a second ESP32 on the bench; the pages and behaviour described here are 1.9.1's), reader 1 reads cards and an exit button on GPIO13 opens the door, and both readers were later reported working. **The Wi-Fi fallback, a real lock and the door contacts are not yet hardware-validated, and neither is most of the 1.1/1.2 door behaviour.** Complete that bench test before it goes on a door. See [docs/STATUS.md](docs/STATUS.md).

## Hardware

Two builds:

| Build | Board | Images |
|---|---|---|
| `esp32s3` | ESP32-S3-DevKitC-1 or compatible | `bin/esp32s3.bin`, `bin/esp32s3-full.bin` |
| `esp32wroom` | Original ESP32 (WROOM-32/32E), e.g. the VOANZO 2-relay board | `bin/esp32wroom.bin`, `bin/esp32wroom-full.bin` |

### ESP32-S3

Target board: **ESP32-S3-DevKitC-1** or compatible (N8, N8R8, N16R8). PlatformIO environment `esp32s3`, partition table `default_8MB.csv`, about 1.5 MB LittleFS.

The ESP32-S3 is **not 5 V tolerant**. Wiegand readers usually drive 5 V signals. Put a level shifter or a resistor divider (for example 10 k / 20 k) on every reader data line.

### Default pins (ESP32-S3)

| Function | GPIO | Notes |
|---|---|---|
| Wiegand D0 | 4 | through level shifter |
| Wiegand D1 | 5 | through level shifter |
| Relay 1 | 21 | drive a relay module / transistor, not a coil directly |

On a new ESP32-S3 board the page starts from built-in settings: an unlock time of 400 ms (too short for a real lock: set 3000-5000 ms and prove it on the lock) and **When the relay is on, the door is: Locked**. An RTC module needs two free pins chosen on the Time page: its default SDA, GPIO 21, is Relay 1's pin, and its default SCL, GPIO 22, does not exist on the S3.

The UI only offers safe pins: 1, 2, 4-18, 21, 38-42, 47, 48. These are never offered:

- 0, 3, 45, 46: strapping pins
- 19, 20: native USB, which is also the serial console
- 26-32: SPI flash
- 33-37: octal PSRAM on R8 modules

If a stored configuration names an unusable pin, the firmware refuses the whole configuration at start-up ("Unsafe GPIO configuration refused", `core::checkConfigPins`) rather than drive the flash pins: the board fails secure as for damaged settings (see **Recovery**). A save naming one is refused.

## Two doors: VOANZO ESP32 2-relay board + two standalone Wiegand readers

The exact intended board is the VOANZO **ESP32 2 Channel Relay Module**, Amazon UK ASIN [`B0DS6SB1XB`](https://www.amazon.co.uk/dp/B0DS6SB1XB). It is the LC-Tech / "ESP32 Relay x2" family ([ESPHome device page](https://devices.esphome.io/devices/esp32-relay-x2)); the available circuit drawing is labelled **ESP32 Relay X2 / `303E32DC210`** ([schematic PDF](https://www.pollin.de/media/30/a0/7b/1773061524/D811723-D.pdf?ts=1773061524)). Check the delivered PCB markings and header labels before relying on the drawing, because the Amazon listing does not state a PCB revision.

- ESP32-WROOM-32E.
- Two 10 A relays with COM/NO/NC terminals: **relay 1 on GPIO16** (outermost), **relay 2 on GPIO17**, both active high.
- LED on GPIO23 and the BOOT button on GPIO0.
- Mounting: a 3D-printed plate holds it on a 35 mm DIN rail in a panel (`hardware/din-plate/`: the STL, the script that makes it, print settings).
- Headers for the other GPIOs, labelled on the back of the board.
- Power: the Amazon listing says DC 5-60 V; ESPHome documents a 7-30 VDC terminal and a separate regulated 5 V terminal. A shared 12 V or 24 V supply is practical, but fuse the controller/readers separately from each lock and suppress lock-coil transients.

Each reader is bound to one door. A card at reader 1 can only open door 1, and only if that user has door 1 access; reader 2 works the same way for door 2. Per-door access is set in the user editor (**Users**, then tap a user): one **Access** field per door, labelled with the door's name. On a fresh device flashed with `esp32wroom`, the Doors & Readers page is pre-filled with the wiring below. Check it, then **Save**.

### Wiring (the preset)

| Reader wire (usual colour; check the label on your reader) | Reader 1 / door 1 | Reader 2 / door 2 |
|---|---|---|
| +12 V (red) | 12 V supply | 12 V supply |
| GND (black) | supply GND **and** board GND | same |
| D0 (green), 5 V, through the level shifter (below) | GPIO 34 | GPIO 32 |
| D1 (white), 5 V, through the level shifter (below) | GPIO 35 | GPIO 33 |
| LED (blue or brown), through the driver below | GPIO 25 | GPIO 27 |
| BEEP / buzzer (yellow), through the driver below | GPIO 26 | GPIO 14 |
| Lock | relay 1 (GPIO 16) | relay 2 (GPIO 17) |

- **Data lines need external conditioning.** The relay-board schematic takes the header GPIOs directly to the ESP32; it does not add Wiegand level conversion. Do not wire D0/D1 straight in. The preferred interface for the four data wires is a four-channel open-drain 5 V-to-3.3 V level shifter: HV to 5 V, LV to 3V3, common GND, with pull-ups fitted on both sides. An opto-isolated Wiegand receiver is better for long/noisy cable runs.
- **GPIO34/35 have no internal pull-ups.** The firmware requests `INPUT_PULLUP`, but the ESP32 hardware cannot provide one on those pins. Reader 1 therefore depends entirely on the external interface for a stable idle-high level. GPIO32/33 do have internal pull-ups, but these are weak and are not 5 V protection; use the same interface for reader 2.
- **A resistor divider is conditional, not universal.** If a powered reader measures about 5 V on D0/D1 while idle, 10 kΩ from the reader wire to the GPIO and 20 kΩ from GPIO to GND gives about 3.3 V. If the line floats, use an open-drain level shifter or a 3.3 V pull-up receiver instead. If it idles above 5 V, use an appropriately rated isolated/transistor interface. Measure the reader before connecting it. A level-shifter module that already includes pull-ups does not need separate pull-up resistors.
- **All of these are on one header:** the 2×10 along the board's outer edge, next to the ESP32 module's left side. One 20-way ribbon and one IDC20 screw-terminal breakout carry every reader line, plus GND, 3V3 and 5V. Rows (two pins each, as printed on the back of the board):

  | Row | Pins | Use |
  |---|---|---|
  | 1 | GND · 3V3 | ground · 3.3 V for the level shifter |
  | 2 | EN · SVP (36) | **leave EN unconnected** (it resets the board) |
  | 3 | SVN (39) · G34 | — · reader 1 D0 |
  | 4 | G35 · G32 | reader 1 D1 · reader 2 D0 |
  | 5 | G33 · G25 | reader 2 D1 · reader 1 LED |
  | 6 | G26 · G27 | reader 1 buzzer · reader 2 LED |
  | 7 | G14 · G12 | reader 2 buzzer · **never connect G12** |
  | 8 | G13 · SD2 | spare (exit button) · **flash pin, never connect** |
  | 9 | SD3 · CMD | **flash pins, never connect** |
  | 10 | 5V · GND | 5 V for the level shifter and ULN driver · ground |

  Which terminal of the breakout each pin lands on depends on which way the ribbon goes in, so check with a meter once it's plugged in.
- **GPIO 36/39 (SVP/SVN) are left unused and are not offered by the UI**: an ESP32 chip erratum can suppress their interrupts while Wi-Fi sleeps, corrupting card reads.
- **Never use GPIO 12 for a reader.** A Wiegand line idles high, and GPIO 12 high at power-on selects 1.8 V flash, so the ESP32 won't start. The UI doesn't offer GPIO 12, and GPIO 0/2/5/15 are left out for the same boot-strapping reason. GPIO34/35 are offered for reader data only because they are input-only; their missing internal pull-ups make the external level-shifter/pull-up interface mandatory. GPIO36/39 are excluded.
- **Onboard status LED.** The board LED is GPIO23. The fresh two-door preset currently leaves the Wi-Fi LED disabled (`255`); select GPIO23 manually if that indication is wanted.

### Reader LED and buzzer

On these readers the LED and BEEP wires are inputs. The reader turns its LED green, or sounds its buzzer, while that wire is pulled to GND. They are usually pulled up to 5 V inside the reader, so don't connect them straight to an ESP32 pin. Use one of these per wire:

- **NPN transistor (recommended, "Active high"):** GPIO → 1 kΩ → base of a BC547 / 2N2222; emitter to GND; collector to the reader's LED or BEEP wire; **and 10 kΩ from the base to GND**. The firmware only drives these pins once the settings have loaded at start-up (never while the settings are damaged or refused); until then the pin floats, and without the pull-down the transistor can turn on and light the LED or sound the buzzer.
- **Diode ("Active low"):** a 1N4148 with its cathode (band) on the GPIO and anode on the reader wire. The ESP32 pin pulls the line low through the diode; when the pin is high the diode blocks the reader's 5 V. A floating pin sinks no current, so this needs no extra resistor.

Choose the matching **LED/buzzer drive** on the Doors & Readers page. What the reader does:

| Event | LED | Buzzer |
|---|---|---|
| Granted | green for 2 s | 1 short beep |
| Admin card | green for 2 s | 2 beeps |
| Denied, unknown, expired or wrong PIN | — | 3 beeps |
| Card read, PIN now required | — | 1 click |

The board-level beeper and LED pins (Doors & Readers, under **Status lights, beeper and doorbell pins**) still work as before, if fitted.

### Reader setup

- Most "standalone" keypad readers ship as a self-contained controller with their own relay and user memory. **Switch the reader to Wiegand output (reader / controller-slave) mode** as its manual describes, usually by entering programming mode with the master code. Choose 26-bit or 34-bit output; both are decoded.
- Keypad PINs need the reader to send keys as 4-bit or 8-bit Wiegand. `*` is ENTER and `#` is ESC. Enable "Require pin code after RFID card" (off by default; it applies to every reader) or "Allow pin code only" as wanted. With a PIN required, only the card's stored PIN opens (never its card number), and a card whose user has no PIN is refused, admin cards included (event log: "Card refused: PIN required, user has no PIN"; until 1.4.0 it opened with the card alone). A keypad-only user is enrolled with the PIN as both the UID and the Pin code; card numbers typed on the keypad do not open the door. Nor does the reverse: since 1.9.1 a card whose number is a keypad-only user's UID is refused as an unknown card (it counts toward the unknown-card alarm); up to 1.9.0 it opened as that user with no PIN (review 8 V2).
- The Status page's **Wiegand noise** row shows, for each running Wiegand reader since the last restart, what its decoder threw away: glitches (edges too close together to be bits), bad frames (no card or key length, or a corrupt 8-bit key), parity errors (26/34-bit, with parity removal on; also an event-log warning) and frames lost (more than the controller could take; also a warning). Counts that keep rising while nobody uses the reader point at the wiring: cable length, missing pull-ups on GPIO34/35, D0/D1 crosstalk.
- Card numbers are stored exactly as upstream esp-rfid stored them (hex by default, parity bits removed), so existing user backups still match.

### The Doors & Readers page

It was called Hardware Settings until 1.5.0.

1. **Setup:** how many **Doors** (one relay each) and how many **Readers** (1 or 2; reader 2 is always Wiegand).
2. **One card per door:** its name, relay pin (with **Test**), relay type, lock type, **When the relay is on, the door is**, unlock time, sensor and exit button, and the reader(s) that open it, each reader in its own card with its type and pins. Change a reader's **opens** setting and its card moves to that door. Reader 1 set to "every door the user may use" gets its own card above the doors.
3. **Common to all doors:** **User ID storage mode** (the card number format), PIN options, **Remove parity bits**, LED/buzzer drive and the left-open alarm; the board-level LEDs, beeper and doorbell pins are folded under **Status lights, beeper and doorbell pins**.

A banner above **Save** says why the settings cannot be saved yet (a pin used twice, a pin the board does not have), as you change them. Since 1.7 every pin clash is also marked on its fields: each one is outlined in red with a line under it saying what else uses the GPIO ("GPIO 21 is also RTC SDA"), the reader or door card holding it shows **Pin clash** in its title, and each pin menu marks the GPIOs already in use ("GPIO-21 — in use: Relay 1"). The RTC module's pins on the Time page count too, both ways.

A line under Setup says how the readers and doors are arranged.

### One door, a reader each side (in/out)

Set **Doors** to 1 and **Readers** to 2: both readers open door 1, and the page sets reader 1 to **In** and reader 2 to **Out** (change them under **Reader 1 side** / **Reader 2 side**). Both sides unlock the door; the side is not enforced. Every scan at a reader with a side is logged with it: the Access Log has an **In/Out** column, the event log says `reader 1 (in)`, and MQTT access messages carry `"direction":"in"` or `"out"`. Wire reader 2 to the reader 2 pins exactly as for two doors.

### Door contacts and exit buttons

Each door can have its own contact (closed to GND when the door is shut) and its own exit button (to GND): **Door sensor pin** and **Exit button pin** in that door's panel on the Doors & Readers page. A contact logs Door Open / Door Closed, a door opened while its lock was not released ("Door was tampered!"; an opening within 3 s of the lock relocking is still a normal entry), and a door left open longer than **Door left-open alarm** (one setting for all doors); over MQTT door 1 reports on `io/door` and `io/tamper`, door n on `io/door<n>` and `io/tamper<n>`. An exit button opens its own door.

Wiring an exit button: a **normally-open** button **between the pin and GND**. Never connect it to 5 V (the ESP32 is a 3.3 V part); the firmware turns on the pin's internal pull-up and opens the door when the pin is pulled to GND (30 ms debounce). The pin is watched by an interrupt, so a press made while the controller is busy (writing a saved user, sending a user list) still opens the door, a moment later, even if the button was already let go. On the VOANZO board **GPIO13** (2x10 header row 8, left; never its neighbour SD2) is the free pin for it; a second button needs GPIO 4, 18, 19, 21 or 22 where the board brings one out (21 and 22 are the RTC module's default pins: with an RTC fitted use 4, 18 or 19). Not GPIO 34/35/36/39 (no pull-up) or 12 (boot). Choose the pin in that door's panel, then use **Save & Reboot** from the unsaved-changes bar: **Save** on the page only stages it, and buttons and contacts are set up when the board starts. For a long cable that triggers by itself, add 10 kΩ from the pin to 3.3 V. A press is logged as "Button" in the Access Log. Each door's exit button and relay settings are also kept in NVS (stored at every settings save and every normal start) and the buttons are set up from that copy first thing at power-up, so an exit button still opens its door when the stored configuration is damaged or refused. BOOT-hold recovery keeps that copy; the menu's **Factory Reset** erases it (since 1.4.2), so a reset board drives no old relay pins and its exit buttons do nothing until it is set up again.

### Doorbell

Wired like an exit button: a **normally-open** button **between the pin and GND** (never 5 V), on the **Doorbell** pin in the settings common to all doors; the firmware turns on the pin's internal pull-up and the bell rings while the pin is pulled to GND (30 ms debounce). Not GPIO 34/35/36/39 (no pull-up) or 12 (boot); add 10 kΩ from the pin to 3.3 V for a long cable. A press logs "Doorbell ringing" and sends `io/doorbell` ON over MQTT, then OFF when released. Until 1.4.0 the input was read the other way round, so an idle button read as ringing.

### Locks

- **Fail-secure strike** (locked when unpowered): 12 V+ → relay COM, relay **NO** → strike +, strike − → 12 V GND, and **When the relay is on, the door is: Unlocked**.
- **Maglock on NO** (the new-board default since 1.7): 12 V+ → relay COM, relay **NO** → maglock +, maglock − → 12 V GND, and set the door's **When the relay is on, the door is** to **Locked**. The relay is on all the time the door is locked and switches off for the unlock time. This is **fail-released**, and means exactly this: whenever the controller is not driving the relay, the magnet lets go and the door opens. Every restart (Save & Reboot, Update, a watchdog reset, a brown-out) releases it for about 0.5-2 s until the firmware drives the relay again, and cutting the controller's power opens the door until the power comes back. Both relay coils are on all the time their doors are locked (about 70-90 mA each, so 140-180 mA for two doors, from the board's supply). The fire-alarm relay below still cuts the magnet on its own.
- **Maglock on NC**: 12 V+ → relay COM, relay **NC** → maglock +, and **When the relay is on, the door is: Unlocked**; the relay switches on to release. The magnet then keeps holding while the controller is dead, restarting or without power (only the maglock's own supply, the fire-alarm relay or a break-glass unit releases it). Boards set up before 1.7 behave this way: stored settings without the setting are Unlocked.
- **Relay type** is the pin level that switches the board's relay on (the VOANZO board: Active High); leave it at that. What the door does when the relay is on is the setting above.
- **A maglock needs a hard-wired emergency release that does not depend on this controller.** The controller can hang, lose its settings or be mid-update, and its exit button then may not work. Wire the maglock's power through a contact that the fire alarm opens (for example a relay driven by the fire alarm that cuts the maglock's power), so the door releases whatever the controller does. Also fit a green break-glass unit (emergency door release) on the escape side that cuts the maglock's power directly; UK escape routes usually need one. Confirm both with whoever signs off the fire safety of the door.
- Put a flyback diode (1N4007, band to +) across any DC lock coil, at the lock.
- **Unlock time** is how long the relay stays switched, in **milliseconds**. The fresh board preset starts both doors at 3000 ms (upstream's 400 ms was too short to work a real lock); adjust within about 3000-5000 ms and prove the timing on the actual lock.

### Flashing the VOANZO board

The board has no USB port. Flashing goes through its 6-pin serial header. That header is **not** in FTDI order, so read the labels.

1. Use a USB-serial adapter with **3.3 V UART logic** (e.g. CP2102): TX to the board's RX, RX to TX, and GND to GND. The six-pin header's power pin is **5 V**, not 3.3 V: power the board from its own DC input or feed that pin from a regulated 5 V source. Do not feed 3.3 V into the header's 5 V pin.
2. Hold **BOOT** (IO0), tap **RESET** (or power-cycle), then release **BOOT**.
3. Flash:

   ```sh
   esptool.py --chip esp32 --port /dev/ttyUSB0 write_flash --erase-all 0x0 bin/esp32wroom-full.bin
   ```

   Or `pio run -e esp32wroom -t upload --upload-port /dev/ttyUSB0`.
4. Reset. After that, update over WiFi from the UI with `bin/esp32wroom.bin` (on the GitHub Releases page it is `ironframe-rfid-<version>.bin`; serial flashing uses `ironframe-rfid-<version>-full-flash.bin`). Update refuses a full-flash image, an image for the other chip or one larger than the update slot, and says why (since 1.4.0).

The 4 MB flash holds two 1.5 MB app slots (for OTA with rollback), about 900 KB of LittleFS and a 64 KB core dump (`partitions-esp32wroom.csv`). The app uses about 75 % of its slot (measured by `test/check-builds.mjs`). The logs take at most 512 KB and give way when free space runs low.

**Moving from 1.0 (1.25 MB slots) to this layout** cannot be done through Update: it needs one serial flash of `bin/esp32wroom-full.bin` at `0x0` **with the whole chip erased first** (`--erase-all`), which **erases LittleFS and NVS** (users, settings, logs, the commissioned flag). Without the erase, old filesystem data stays where the new LittleFS partition starts (the new partition lies inside the old one, and the image only covers the first 1.2 MB): the firmware then refuses to format storage it does not recognise (fail-secure), marks the configuration damaged and turns Wi-Fi off (see **Recovery** below). Back up first (Backup & Restore: users and settings), flash, then restore. Settings backups hold `********` instead of passwords: set the admin password again (the device asks), and re-enter the hotspot, Wi-Fi and MQTT passwords if they were used.

**Recovery.** If the storage cannot be read (a damaged filesystem, a configuration with unsafe pins, or old data from a flash without `--erase-all`), the board fails secure: the relays stay locked, the readers are off and Wi-Fi is off. Exit buttons still open their doors, from the copy kept in NVS (see **Door contacts and exit buttons**); this copy outlives a recovery erase (both kinds below) until new settings are saved. To recover it in place, power it up normally, then **hold BOOT for 10 seconds**. If the filesystem mounts (a damaged or refused configuration), the board erases its **settings only** (`config.json` and its `.bak`/`.tmp`) and keeps the users, the logs and the NVS copies of the relay and exit-button settings; it then restarts into the setup hotspot (`IRONFRAME-RFID-xxxxxx`, password `ironframe-setup`, see **First boot**) with the factory admin password, as a new board would: restore a settings backup from there. Until 1.4.1 it formatted the whole filesystem, users included. If the filesystem does not mount at all (damaged, or old data from a flash without `--erase-all`), formatting it is the only way back: settings, users and logs are erased, so restore both backups. The event log says which happened ("BOOT held: settings erased, users kept", or "...the filesystem could not be used, so it was formatted..."). Both keep the NVS relay and exit-button copies. BOOT does nothing on a working board. Holding BOOT *while* powering up still enters the ESP32's serial loader, as before.

**Factory Reset** (its own entry in the menu, on a working board) formats the filesystem (settings, users, logs) and also erases the commissioned state, the keypad lockouts and the NVS exit-button copy, so no exit button opens a door until the board is set up again (until 1.4.1 a reset board went on opening on the old exit buttons). It keeps the NVS copy of the relay pins and their locked levels, so the relays stay driven locked from power-up instead of floating; the next settings the board loads replace it. (1.4.2 to 1.5.0 erased that copy too, leaving a reset board's relay pins undriven.) A factory reset or recovery format that a power cut interrupts is finished at the next boot, as the same kind.

## Flashing

### Blank board (first time)

Build output lands in `bin/`:

- `bin/esp32s3-full.bin`: bootloader, partition table and app merged. Flash it at offset `0x0`.
- `bin/esp32s3.bin`: the app only. Use this for updates through the web UI.

```sh
pio run -e esp32s3                     # build: bin/esp32s3.bin + bin/esp32s3-full.bin
pio run -e esp32s3 -t upload           # flash over USB
# or, without PlatformIO:
esptool.py --chip esp32s3 --port /dev/ttyACM0 write_flash 0x0 bin/esp32s3-full.bin
```

If the board does not enter the bootloader by itself, hold **BOOT**, tap **RESET**, then release **BOOT**. The `esp32s3-debug` environment prints a serial log over native USB at 115200 baud.

### Later updates

The version is Ironframe's own (`IRONFRAME_VERSION` in `src/main.cpp`) followed by the git commit the image was built from, e.g. `1.7.0 (2e2fa33)`, as shown on the Status page and sent as the MQTT `sw` field. `scripts/version.py` adds the commit at build time; a build with uncommitted changes or untracked files reads `-dirty`, and one without a usable git checkout `unknown`; neither may be installed. Build only after committing. Release images are built with `IRONFRAME_RELEASE=1`, which refuses to build unless the tree is clean and HEAD is the tag `ironframe-<IRONFRAME_VERSION>`. Read the running version without logging in: `curl -s -D - -o /dev/null http://192.168.4.1/favicon.svg | grep -i etag` (a GET: the web server answers `HEAD`, i.e. `curl -I`, with 404).

Use **Update Firmware** in the menu and upload `bin/esp32s3.bin`. Upstream esp-rfid release files are ESP8266 builds and will not run on this board.

### Rebuilding the web UI

`src/webh/*.gz.h` are generated from `src/websrc`. After changing anything under `src/websrc`:

```sh
cd tools/webfilesbuilder && npm ci && node bin.js
```

The web UI uses no library (since 1.5.0; until 1.4.3 it was jQuery, Bootstrap 3 and FooTable): plain JavaScript, native `<dialog>`s, and one stylesheet of our own, `src/websrc/css/app.css` (the design: phone first, a tab bar on phones and a sidebar from 900 px wide) plus four page stylesheets (`page-hardware.css`, `page-logs.css`, `page-settings.css`, `page-users.css`), concatenated into the served `css/required.css`. `node test/check-assets.mjs` fails if a library, a Bootstrap class or an inline script comes back. Each page is a `<template>` in its own file, `src/websrc/pages/<page>.htm`, served together as `esprfid.htm`. The UI's scripts are in `src/websrc/js/`: `state.js` (shared state), `policy.js` (the device's settings checks, run before a save), `ui.js` (messages, confirmations, progress overlay), `transport.js` (sign-in and the WebSocket), `settings.js` (staging and the review), one file per page, and `main.js`. The builder concatenates them, in the order of `UI_SCRIPTS` in `tools/webfilesbuilder/gulpfile.js`, into the one served `js/esprfid.js`; a script missing from that list fails the build. A control names its handler with `data-onclick="fn"` (also `data-onchange`, `data-oninput`, `data-onsubmit`; `data-arg` passes one argument, `value` the control's value), never an inline `onclick=`: the Content-Security-Policy blocks inline script.

## First boot

1. The reader starts its setup hotspot `IRONFRAME-RFID-xxxxxx` with the password `ironframe-setup` (since 1.8; it was open). Join it and browse to `http://192.168.4.1`. The password is a public factory default printed here, not a secret: it keeps the hotspot from being an open network, and the admin password (next step) guards the pages. The setup hotspot closes after 15 minutes with nobody connected (no device joined, no page open; event log "Setup hotspot closed"); switch the reader off and on to open it again. The first settings save keeps the hotspot's name and this password unless you change them on the Wireless Network page.
2. Sign in with the factory password `admin`. The UI then **forces a new admin password** (8-64 characters). Until one is set, the device refuses every command except status, time and reading its masked config. The new password is stored at once (in NVS until the first settings save moves it into `config.json`), so a restart before that save does not bring back `admin`.
3. Configure WiFi, hardware and users, then **Save & Reboot**. Until the first save no relay is driven: **Test** on the Doors & Readers page reports that the relay has no pin yet.

### How many users

**At most 200 users** (after 1.8.0). A new user above that is refused, from the Users page, a backup restore or MQTT `adduser`, with "The user limit (200) is reached"; editing an existing user still works. Every user is a file in one folder, and finding a card's file scans that folder, so lookups slow down as users are added: on the bench, 18 ms for the first user, 0.37 s with 500 users and 0.56 s with 776, and the store filled at about 720. A reader updated with more than 200 users keeps them all, but takes no new ones until it is under the limit.

New users are also refused while less than 64 KB of storage is free ("Storage is nearly full"), and nothing is written with less than 16 KB free. LittleFS does not fail cleanly when it is completely full: up to 1.8.0 a full store crashed the reader, and it then crashed on every start (bench 2026-10-18).

### Saving settings: with or without a restart

A settings page's **Save** stages its values; the amber bar then opens the review of every change, and its button says what will happen (since 1.5.0):

- **Save**: every change can be applied while the reader runs. The reader stores the settings and uses them at once, with no restart and no new sign-in: door names, unlock times, the left-open alarm, the PIN rules, card number format and parity, which door each reader opens and its in/out side, opening hours, logging, the time zone, and the MQTT message options (sync interval, MQTT logging, remote admin, door control, card number in MQTT), and **Turn Wi-Fi off when nobody is connected** with its minutes. They are applied between two reader passes, and not while someone is part-way through entering a PIN (`src/core/livesettings.h`).
- **Save & Reboot**: anything else restarts the reader, as before: every pin, reader and relay type, lock type, number of doors and readers, Wi-Fi and network, hostname, the MQTT connection and Home Assistant discovery, auto restart, the NTP server and the NTP sync interval (SNTP takes it before it starts), the RTC module, and each door's **When the relay is on, the door is**. Also the first save, and a save while the stored settings are damaged.

The event log says "Settings applied without a restart" and which settings.

### Turning Wi-Fi off when nobody is connected

**Turn Wi-Fi off when nobody is connected** (Wireless Network page, Power saving; since 1.8) is a tick box, **off by default**: unticked, Wi-Fi stays on as before. Ticked, Wi-Fi turns off once nobody has been connected for **Turn Wi-Fi off after** minutes (1-1440, default 15). "Connected" means a phone or laptop joined to the reader's hotspot, or a signed-in page like the settings pages open; the count starts again whenever someone connects. It applies in every mode: on your network, as a hotspot and as the fallback hotspot. The event log says "WiFi off: nobody connected for N min".

While Wi-Fi is off, MQTT (Home Assistant) and NTP time stop and the pages cannot be reached; the doors, readers, exit buttons and logs keep working. To turn Wi-Fi back on, **scan an admin card** or **switch the reader off and on** (Wi-Fi is always on at power-up). There is no wake button.

It replaces **WiFi Timeout** (`network.offtime`, until 1.7), which counted only the time the reader was connected to a router, so a hotspot install never turned off. An updated reader converts a stored WiFi Timeout once, at its first start: a timeout of N seconds becomes the box ticked with N/60 minutes rounded up (event log: "WiFi Timeout replaced by Turn Wi-Fi off when nobody is connected"); none stays unticked.

### Clock (hotspot-only installs)

The board has no battery clock of its own, so without an RTC module (below) it loses the time at every power cut, and on its own hotspot there is no NTP. Until the time is set again (an admin signs in from a browser, which sends its clock automatically, or NTP answers):

- **admins** and **Always** users whose dates are the defaults (valid since 1970, valid until 2038-01-01) still get in;
- users with their own **Valid since / Valid until** dates, and Always users when the opening hours close any hour of the week, are refused with "Clock not set".

Status shows **Clock: Not set** and the event log records "Time not set" at boot and "Time set" when it comes back. Setting the time from the browser (Time page) on a clock that is already set logs "Time changed from the browser" with the old and new time (UTC) and the browser's address. Opening hours use local time (the time zone on the Time page) for both the day and the hour.

### RTC module (keeps the time through a power cut)

Since 1.7 a real-time clock module with its own coin cell keeps the time while the board is off: **Time → Real-time clock (RTC)**.

- **Module:** a DS3231 (recommended: accurate to about a minute a year) or a DS1307, both at I2C address 0x68.
- **Wiring (VOANZO board):** module VCC → **3.3 V** (never 5 V: the module's pull-ups would put 5 V on the ESP32's pins), GND → GND, **SDA → GPIO21**, **SCL → GPIO22** (the defaults; any other free output pin can be chosen on the Time page; on the ESP32-S3 two other pins must be, see **ESP32-S3**). Keep the wires short.
- **Coin cell:** the common ZS-042 DS3231 board charges its cell: fit a rechargeable **LIR2032**, or remove its charging resistor and fit a CR2032.
- Choose the module type, then **Save & Reboot**. At start the reader reads the module once. A good time sets the clock at once: Status shows **Clock: Set** and the Event Log "Time set from RTC". A module that lost the time (flat or missing cell) logs "RTC lost the time (battery?)" and the clock stays not set until NTP or a browser sets it. No answer logs "RTC not found on SDA 21 / SCL 22" and the reader carries on as without one. The Time page shows which.
- The reader writes the module whenever the time comes from NTP (every sync) or from a browser, and does not read it again until the next start. Which wins: NTP, then a time set from a browser, then the module at start. A clock set from the module counts as set, so signing in does not overwrite it with the browser's time.
- Its pins count in the pin checks: Doors & Readers and the Time page mark a clash and Save refuses it.

### Moving from an ESP8266 esp-rfid

- Restore the settings backup and the user backup through **Backup & Restore**. The user backup format is unchanged.
- **Re-select every GPIO.** ESP8266 pin numbers do not carry over.
- Settings backups made by this firmware **do not contain passwords**. They hold `********` placeholders. Re-enter the Wi-Fi, fallback hotspot and MQTT passwords after restoring onto a new device. The admin password stays the one set on the device: a restore never changes it.
- **Backup Settings** saves the settings stored on the device, not changes staged on the page and not yet saved (until 1.4.2 it saved the page's copy, unsaved changes included). With changes staged it says so: Save & Reboot first to back them up.

## What changed

### Two Wiegand readers, one door each (2026-10-11)

- The upstream Wiegand library kept its state in statics, so a board could only have one reader. It is replaced by a per-reader decoder (`src/core/wiegand.h` with interrupt glue in `src/wiegand.esp`). The arithmetic is kept bit for bit, so card numbers don't change; tests rebuild 26- and 34-bit frames with real parity bits.
- `rfid.esp` keeps one session per reader: cool-down, PIN entry, LED and buzzer. A per-reader access decision (`src/core/access.h`) opens only the door that reader is bound to. "Every permitted door" remains for single-reader setups; reader 1 with no stored door defaults to door 1 when there are two or more doors.
- **Fixed an upstream bug that broke door 2:** the hardware page saved relay 2-4 settings as strings (`"16"`), ArduinoJson 6 reads those as 0, and relay 2 ended up on GPIO 0. The UI now saves numbers, and the firmware reads both forms.
- Original-ESP32 build (`esp32wroom`). Each chip has its own safe-pin list (`src/core/pins.h`); the firmware enforces it and the UI builds its pin menus from it. Saving a configuration that uses a pin twice, or an input-only pin as an output, is refused.
- The access log and MQTT access events record which door was used.
- **Logging** (Log Settings page) turns writing the Event Log and the Access Log to flash on or off. It defaults to on, including for configs saved before the setting existed. When off, nothing new is written; existing logs stay viewable and deletable. MQTT event and access messages are configured separately on the MQTT page. With **MQTT logging** on, events go over MQTT instead of the Event Log, except while the broker cannot be reached: then they are written to the Event Log (if Logging is on) rather than lost (since 1.4.0).

### Port to ESP32-S3

- ESP32 Arduino core (`espressif32@6.10.0`) with LittleFS, `ESP32Async/ESPAsyncWebServer` + `AsyncTCP`. Readers are Wiegand only: upstream's MFRC522, PN532 and RDM6300 support was removed in 1.6.0 (2026-10-16). A stored config with one of those loads with reader 1 off and a warning (Wiegand + RDM6300 keeps its Wiegand reader); a save, a restored old backup or MQTT `updateconf` must name a Wiegand reader.
- ESP32 WiFi events and mDNS (`http://<hostname>.local`). WiFi scans are polled from `loop()`.
- **Lock to this access point** (Wireless Network page, client mode) is a visible checkbox, off by default. Off, the device joins any access point of the network (the saved BSSID is empty); on, it joins only the BSSID shown, which a scanned network fills in. Until 1.4.1 choosing a scanned network filled the BSSID field unasked, so the device joined only that one access point and stayed off Wi-Fi when it was down or replaced.
- The async web, MQTT and WiFi callbacks run on other FreeRTOS tasks. They now only queue work; `loop()` does it. This affects WebSocket commands, MQTT commands and log writes, all of which use mutex-guarded queues.
- Clients are addressed by WebSocket id, so a browser that disconnects mid-request can't leave a dangling pointer.
- `bin/esp32s3-full.bin` is produced for first-time flashing.
- WiFi now starts **before** the web server. On ESP32 the TCP/IP stack only comes up with WiFi, and upstream's ESP8266 order (web server first) asserts in lwIP (`tcpip_api_call`) and boot-loops. Found with the QEMU boot test.

### Logs (why they "kept messing up")

| Upstream defect | Fix |
|---|---|
| One global read offset (`lastPos`) shared by both logs and every browser tab, so pages overlapped, repeated or skipped | Stateless paging: the browser sends `pos`, the device returns `nextpos` and `eof` (`src/core/logfile.h`) |
| The browser re-sent every page request on a 10 s timer whether or not it had been answered, so duplicate pages were appended | One outstanding request; stale or duplicate answers are ignored (`src/websrc/js/transport.js`) |
| A fixed 2 KB page buffer silently dropped lines that didn't fit | The page stops early and resumes at the dropped line; no entry is lost |
| Logs grew until the filesystem was full, then lines were cut half-written | Rotation at 64 KB, keeping 3 rotated files; free-space guard; one write per line |
| Lines written from several tasks at once interleaved | Single writer: callers queue lines and `loop()` writes them |

### Speed (why the UI was slow)

| Upstream | Now |
|---|---|
| 10 log lines per round trip; a 600-line log took 60 | 50 per round trip: **12** |
| 10 users per round trip; 300 users took 30 | 50 per round trip: **6** |
| ~640 KB of UI re-downloaded on every visit | ETag revalidation (`304`); the UI downloads once per firmware build |
| `listStats()` removed every modal backdrop on each refresh | Only touches the restore dialog |

(The round-trip counts are measured by `test/e2e/run.mjs` against the simulator. The upstream counts are calculated from upstream's page sizes.)

### Security

| Issue | Fix |
|---|---|
| `getconf` sent WiFi, MQTT and admin passwords to the browser (and to MQTT) | Masked as `********`. On save, a masked value keeps the stored one (`src/core/secrets.h`) |
| Basic auth over plain HTTP; any page the admin visited could open the WebSocket using cached credentials | Digest `/login` issues a 128-bit session token. Nonces are single use, so a captured login can't be replayed, and Basic is refused. The WebSocket needs `?token=`, `/update` needs `X-Session-Token`, and a foreign `Origin` is refused |
| Logout only forgot the token in the browser | Logout revokes the token on the device and closes every WebSocket opened with it (since 1.4.0; before, only its own). A password change closes every open WebSocket |
| Log entries, user names and scanned SSIDs were rendered as HTML (FooTable `.append`, `innerHTML`). One MQTT message with a bad `door` value planted a script that ran when the admin opened the Event Log | Every table cell is escaped at render time; status and scan values use `textContent`; the bad `door` value is no longer logged |
| No Content-Security-Policy: an injected `<script>` or `onerror=` would run in the admin's session | The pages are served with a Content-Security-Policy (since 1.4.0): scripts, styles, fonts, images and connections from the device only, no inline script, no framing. The UI's controls name their handler in `data-on<event>` attributes instead of inline `onclick=` (bound in `main.js`). e2e runs the whole UI under the policy and checks that an injected handler is blocked |
| `/update` kept its state in globals: an unauthenticated upload could break a running update and block every later one until reboot | Upload state is per request; a dropped upload is aborted |
| No limit on password guessing | 5 failures in 5 minutes block that IP for 5 minutes. 20 failures in 5 minutes from any mix of IPs refuse every login for 1 minute, doubling to 15 while it goes on, so cycling addresses does not help (`core::LoginLimiter`). Someone guessing can therefore keep the admin out of the web UI for a while; cards, PINs and signed-in sessions keep working |
| A wrong PIN only cost the 2 s reader cool-down | 5 wrong PINs at one reader's keypad make that reader refuse every PIN for 30 s, doubling to 15 min. Wrong PINs add up and one is forgiven per hour (a leaky bucket), so a guesser cannot pace below a reset window: any steady rate above one an hour eventually locks, while a slip now and then never does (until 1.4.1 the count restarted after 10 min without a failure, so 4 wrong PINs every 10 min, about 576 a day, never locked). A lockout leaves 4 wrong PINs in the bucket, draining from when it ends, so one more wrong PIN within the hour locks again for twice as long: someone guessing on gets about one try per 15-minute lockout, at most 99 a day (until 1.4.1 every lockout bought 5 more, about 480 a day). Once the bucket has drained empty, 4 hours after a lockout without another, the next lockout is 30 s again and the full 5 are back, so an owner who mistyped the evening before is not locked the next morning. A correct PIN does not reset it (it did until 1.3.2, so anyone with one PIN could keep guessing others). The lockout start is an event-log warning and an MQTT `alarm` message. One per reader (one for the whole device until 1.4.0, so wrong PINs outside also locked card+PIN at the inside reader), kept in NVS, so a power cycle does not clear it (`core::PinLockout`). **PIN-only entries** (digits with no card, tried against every PIN-only user) also add up across all readers since 1.9: 5 wrong ones lock PIN-only entry at every reader by the same rules, while cards and card+PIN keep working ("PIN-only locked out"); and a new keypad-only user needs a PIN of at least 6 digits in the user editor (a stored shorter one keeps working until it is changed; 2026-10-19) |
| An unknown card only cost the 2 s reader cool-down (about 1,800 guesses an hour) | 10 unknown cards at one reader raise an alarm: an event-log warning ("Unknown cards at reader") and an MQTT `alarm` message. **Valid cards always open** (2026-10-16): from 1.4.0 to 1.4.2 the 10 unknown cards made that reader refuse every card, valid ones too, for 30 s doubling to 15 min, so anyone with a few cheap tags could keep a door shut to its users. Unknown cards add up as wrong PINs do, one forgiven per 30 min; after an alarm it stays quiet for 30 s doubling to 15 min, so a guesser trying cards raises an alarm about every 15 min. After an unknown card the reader ignores every card for 5 s, 10 s while unknown cards keep coming (another within a minute), so trying card numbers runs at about 360 an hour instead of 1,800; a valid card used straight after an unknown one waits out that pause, and valid cards never lengthen it (since 1.9, 2026-10-19). Still act on the alarm. One per reader (`core::CardAlarm`, `READER_UNKNOWN_COOLDOWN_MS`); not kept across a restart |
| A user record that could not be read for lack of memory was taken as no record: a valid card was refused as Unknown and counted toward the unknown-card lockout (a PIN as a wrong PIN) | The lookup tells "not there" from "could not read" (`core::Lookup::Busy`, since 1.4.1). The card or PIN is refused with the denied beep and LED, the event log says "Card not checked: not enough memory, try again", the Access Log shows it denied, MQTT access events carry `"access":"Busy"` (`isKnown` `false`: it could not be told), and neither the keypad lockout nor the unknown-card alarm counts it; the next try reads the record again |
| Typed PINs were logged and published: a PIN-only user's uid is the PIN, every MQTT access event carried `pincode`, and Home Assistant discovery made a PinCode sensor; until 1.4.0 MQTT `getuserlist` sent each stored user file whole, PIN included (and `.bak`/`.tmp` copies) | A PIN-only entry is logged and published as `keypad` with the user's name; no MQTT payload carries a PIN (`getuserlist` sends `haspin` instead, a PIN-only user as uid `keypad`, records only: `core::publicUserRecord`), and the PinCode entity is removed on the next discovery |
| Factory password `admin` usable forever | A password change is forced (also for short passwords carried over from upstream); passwords must be 8-64 characters and not `admin` |
| The admin password was stored in `config.json` as typed | Only its HTTP Digest hash is stored (since 1.4.2): HA1 = MD5(`admin:ironframe-rfid:<password>`), the value the Digest login is checked against, so the device never needs the password itself (`core/adminpass.h`). A password from 1.4.1 or earlier is hashed at the first start, `config.json` rewritten and its `.bak`, which still held the old text, removed, logged as "Admin password now stored as a digest hash"; so is one set before the first settings save, held in NVS. Whether the factory password must still be changed is a stored flag, not read from the password. The 8-64 character rule is checked before hashing. The hash is masked in `getconf` like the other passwords. It is not a strong hash: anyone who reads it out of flash can sign in with it (Digest needs only HA1) and can try to guess the password offline, so a long password still matters (see **Residual risks**) |
| An open session (a browser left signed in) could replace the admin password | Change Password asks for the current one, and a settings save, restore or MQTT `updateconf` always keeps the password in force (`core::applyConfigPolicy`) |
| Change Password sent the current and the new password in clear over `ws://` (review 6), so anyone watching the network had them | The page sends neither: the new password's digest hash goes encrypted under the current one and the session token, with a proof of the current password (`core::openPasswordChange`). The forced first change proves the password just signed in with. The device can no longer see the new password, so the 8-64 length rule is the page's (it reports the length) and the device refuses only the factory one. Signing in itself was already Digest |
| No Host check: a page on another site whose name the attacker points at the reader (DNS rebinding) could talk to it from the admin's browser; a `/login` flood from one address evicted all 8 login nonces, so nobody else could sign in | A request or WebSocket whose Host is not the reader's IP, hotspot address, 192.168.4.1, host name or `<name>.local` gets 421; one address holds at most 2 live nonces (`core::hostAllowed`, `core::NonceStore`) |
| An AP passphrase of 1-7 characters silently gave an open network | Refused on save; an old config gets a loud warning at boot |
| `numrelays` above 4 overflowed the relay arrays | Clamped to 1-4 on load and save |
| WebSocket fragments copied past a buffer sized from the first frame; NUL over-read; NULL `command` crash | Bounded reassembly (16 KB cap, `core::MessageAssembler`), NULL check |
| MQTT payloads copied into a fixed 2 KB global without bounds; leaked message on missing `cmd` | Bounded (4 KB) reassembly, parsed in `loop()` |
| MQTT `open`/`close` with `door: 9` wrote past `activateRelay[4]` | Index validated against the configured relay count |
| Any broker client could `adduser`, `deletusers`, `updateconf`, `getconf`, `getuserlist` | These need **MQTT remote admin**, which is off by default |
| With remote admin on, anyone who could publish to the command topic could turn on door control, move the device to another broker or topic, change the Wi-Fi, turn off the PIN requirement, rewire relays and readers, and enrol an admin card | Since 1.4.2 `updateconf` keeps the stored values of those settings (Wi-Fi, admin password, broker and topic, remote admin, door control, PIN rules, reader type and blocks, relay count, every pin, relay and lock types and times, the held-open time; `core::keepRemoteAdminKept`), names them in its acknowledgment (`ignored`) and the event log, and `adduser` refuses access 99. The exact list is in `README-MQTT.md` (Remote admin) |
| Any broker client that knew the device's IP (which it publishes itself) could open the doors with `opendoor`/`open` | Door commands need **MQTT door control**, off by default (since 1.4.0); with it off they are ignored (logged once until restart) and Home Assistant discovery announces no lock entities (nor, with it on, for a relay with no pin). A door command queued before an MQTT reconnect, or more than 5 s old when the device gets to it, is dropped and logged, so a stale unlock never runs late |
| Log commands took any filename (read or delete `config.json`); user ids became paths | Log names are whitelisted; uids must be 1-32 alphanumerics (`src/core/validate.h`) |
| User records were stored as sent (WebSocket `userfile`, MQTT `adduser`): any access value, PIN or date, `command`/`cmd`/`doorip` too, names long enough to break the user list page; a `validuntil` sent as text read as 0 (expired) | The device checks each record (`core::checkUserRecord`): access 0, 1 or 99 per door; PIN empty or 4-12 digits; valid since/until a number or decimal text (valid until required); name at most 64 bytes (32 accented letters). It stores only those keys, numbers as numbers, the uid in lower case (as every reader reports it). A refused record gets the reason in the user editor (MQTT: an event-log warning). Since 1.4.0 |
| Changing a user's UID in the editor saved the new record, then sent a separate `remove` for the old one: a link dropped in between left the old card valid | One WebSocket `userfile` command carries the old UID as `replaces` (since 1.4.1): the device stores the new record and removes the old one in the same handler, and if the old one cannot be removed it undoes the new one (putting back a record it overwrote) and refuses, so the editor shows "Could not remove the old UID, so nothing was changed" |
| jQuery 1.12.4 / Bootstrap 3.3.7 (known XSS CVEs) | ~~jQuery 3.7.1 / Bootstrap 3.4.1~~ No library at all since 1.5.0: plain JavaScript and our own stylesheet, so no third-party UI code is served (`test/check-assets.mjs`) |
| `sprintf` overflow building the MQTT auto-topic | Bounded `snprintf` |

Other fixes:

- The beeper shared the relay's timer, so a denied-access beep shortened the door release.
- A user restore only restored door 1 permissions.
- After a quick WiFi reconnect, MQTT waited 60 s before reconnecting.
- Restoring a settings backup now warns that passwords aren't included.
- Heap bar scaled for 40 KB.

### Residual risks (not fixed: know these before deploying)

- **No TLS.** The ESP32 async web server doesn't serve HTTPS. Digest auth keeps the password off the wire and nonces can't be replayed, but someone sniffing the LAN can still capture a session token from the WebSocket URL. Keep the reader on a trusted VLAN. A captured sign-in can also be guessed offline at MD5 speed (a graphics card tries billions a second), so use an admin passphrase of 12 characters or more, for example four random words (review 7). A session ends after 12 hours unused and, since 1.9, 24 hours after sign-in however busy (since 1.9.1 "unused" means no message from any page of that session, and its open pages are closed when it ends; up to 1.9.0 a page's connection closed 12 hours after it opened, used or not, so the 24-hour limit was never reached: review 8 V20). Since 1.9 a captured session token is also not enough for the worst: a firmware update, a factory reset and any change to the network or MQTT settings need the admin password as well (the page proves it to a one-use challenge from the reader; it keeps the password's hash in memory after sign-in and asks for the password after a reload), so it cannot install other firmware or move the reader to someone else's broker. Since 1.9.1 the same goes for everything that opens a door, enrols a credential or erases the record (review 8): **Test**, **Restart**, removing a user, a user save that adds a user, gives admin access or sets, changes or removes a PIN (a name, the dates or a role 0/1 on a stored user need only the session), a backup restore, clearing a log, logging on or off, moving a clock that is already set (a lost clock is set from the browser with the session alone), and any change on Doors & Readers (pins, relays, relay times, exit buttons, the PIN rules).
- **The MQTT broker is part of the lock** when MQTT door control is on. Anyone who can publish to `<topic>/cmd` with the device's IP can then open doors. Use broker authentication and ACLs.
- **Card UIDs are cloneable.** Wiegand card numbers (EM4100, Mifare and the like) are identifiers, not secrets. Add a PIN for sensitive doors. MQTT access messages carry only the last 4 characters of the card number unless **Card number in MQTT** is set to Full (since 1.4.2; see `README-MQTT.md`); the web pages and the remote-admin user list show it whole.
- **Firmware updates are not signed.** A logged-in admin can upload any image.
- **Flash is not encrypted and boot is not secured.** The Wi-Fi and MQTT passwords and every PIN are stored in plain text in flash, the admin password as its Digest hash (since 1.4.2), which is enough to sign in with, and the serial header takes any image: anyone who can open the enclosure for a few minutes can read them or reflash the board. Flash encryption and secure boot are not used; turning them on burns eFuses on the chip and cannot be undone.
- **Low memory restarts the reader, only when idle** (since 1.8). Three card reads in a row refused for lack of memory (event "Not enough memory to read a user record"), or the largest free memory block under 8192 bytes for 10 minutes, make the reader restart once nothing is in progress: no reader part-way through a card or PIN, every door locked with no open pulse, no Update or settings apply running. Never within an hour of any start, so at most once an hour. Since 1.9.1 it no longer waits for ever: after an hour of waiting it restarts however busy (one door held open by a Continuous lock kept it waiting indefinitely while the other door refused every card as Busy, review 8 V5); the event log names what held it ("Low-memory restart waiting: door 1 is unlocked"). The event log says "Restarting: low memory (largest block N bytes)" and why, first. A restart releases a maglock for about 0.5-2 s (ledger H22.4). The 8192 bytes come from the code's allocations (8 KB settings documents, 1 KB per card lookup), not from the board: the hourly "Memory" event records its real figures (`src/core/memguard.h`).
- **Every restart waits for the doors** (since 1.9.1). Save & Reboot, Restart, the end of a firmware update, MQTT `updateconf` and the factory reset used to restart at once, cutting a PIN entry short and releasing a maglock on NO mid-pulse (review 8 V3). They now wait until nothing is in progress, as the low-memory and scheduled restarts do (no reader part-way through a card or PIN, every door locked, no update or settings apply running), but at most 30 s: then the reader restarts anyway. The event log says what it waited for ("Restart waiting: door 2 is unlocked") and how long ("System is going to reboot (Restart from the web page) | idle after 120 ms"). A restart still releases a maglock for about 0.5-2 s (ledger H22.4).
- **The fallback access point has its own password.** When WiFi fails (or is lost for 5 minutes) and fallback is on, the device opens the `IRONFRAME-RFID-xxxxxx` hotspot with the **Fallback hotspot password** (Wireless Network page, 8-63 characters). Without one the hotspot does not open (logged at start-up); up to 1.4.2 it opened with no password, so jamming the router for 5 minutes gave anyone nearby an open network to the admin page. A new, unconfigured board opens its setup hotspot for commissioning, with the documented setup password `ironframe-setup` (open until 1.7) and behind the factory admin password that must be changed first; it closes after 15 minutes with nobody connected. It keeps retrying the configured network every two minutes (not while someone is connected to the AP) and closes the AP once it connects. A commissioned device with a damaged filesystem/configuration does **not** enter this mode; it stays offline and locked for physical recovery (see **Recovery** above). It does not open the setup hotspot either: kept that way on purpose (2026-10-17), since a damaged board staying offline is the fail-secure choice.

## Tests

`bash tools/bootstrap.sh` installs the toolchain the checks need (PlatformIO, Espressif QEMU with its SDL libraries, the Node packages; versions pinned, Ubuntu 24.04 x86-64), and `--check` reports what is missing. `bash test/all.sh` runs every check below in one go. It refuses a dirty tree (pass `--allow-dirty` for the gates before a commit), records the commit and the git tree id of the working tree (`test/tree-id.sh`), fails if they change while it runs, and counts a check that cannot run (e2e without Chromium or `test/e2e/node_modules`) as a failure; `ALLOW_NO_E2E=1` turns that into a `PARTIAL` result, never a pass.

| Check | Command | Where |
|---|---|---|
| Host unit tests for `src/core` (ASan + UBSan), including the shared settings-policy vectors `test/vectors/config-policy.json` | `bash test/native/run.sh` | any Linux with g++ |
| UI end-to-end in headless Chromium against `test/e2e/device-sim.mjs` | `cd test/e2e && npm ci && cd ../.. && node test/e2e/run.mjs` | needs a Chromium (`CHROMIUM=` or the Playwright cache) |
| No ESP8266-only API left; no 32-bit `millis()` timing in Ironframe's own sources; every output's level written before `pinMode(OUTPUT)` | `node test/check-port.mjs` | |
| Every command the UI sends is handled by the firmware's command table and by the simulator | `node test/check-protocol.mjs` | |
| The settings saved without a restart are the same list in the firmware, the page and the simulator (`test/vectors/live-settings.json`, also run by the native tests) | `node test/check-live-settings.mjs` | |
| The build's git stamp: `-dirty` for tracked edits and untracked files, `unknown` without a usable checkout; a release build (`IRONFRAME_RELEASE=1`) refuses either, and a HEAD that is not tag `ironframe-<IRONFRAME_VERSION>` | `python3 test/check-version.py` | needs git |
| The pre-commit hook (`tools/hooks/pre-commit`, installed by `bash tools/install-hooks.sh`) refuses a commit unless `test/all.sh` passed on exactly the staged tree, with a PASS line for every gate (since 1.9.1); `--no-verify` is the only bypass. A clone without the hook fails the gates (`test/check-hook-installed.sh`; CI sets `IFRFID_CI=1`) | `bash test/check-hook.sh`, `bash test/check-hook-installed.sh` | needs git |
| Web assets fresh, no UI library or Bootstrap class, no inline script, theme present | `node test/check-assets.mjs` | needs `tools/webfilesbuilder/node_modules` |
| The install docs agree with the firmware and the UI preset (pins, relay timing, warnings) and README-MQTT lists exactly the settings MQTT remote admin keeps | `node test/check-docs.mjs` | |
| Both firmwares build, no project warnings, ESP32 app fits its OTA slot with 5 % spare | `node test/check-builds.mjs` | needs PlatformIO |
| The GPIO interrupt paths (Wiegand readers, exit buttons) are in IRAM in the linked images: the ISRs and the IDF GPIO dispatcher, and everything they call (followed through the disassembly), are in IRAM or ROM; controls show it finds calls and spots flash code | `python3 test/check-iram.py` | needs PlatformIO (its xtensa `nm`/`objdump`) |
| Boots in Espressif QEMU, `setup()` completes, `loop()` runs with flat heap, no panic, over two boots | `TARGET=esp32 QEMU=.../qemu-system-xtensa bash test/qemu/boot-test.sh` (and `TARGET=esp32s3`) | QEMU from espressif/qemu releases. No WiFi in the emulator. Flash writes (format + remount) are covered on `esp32` only; the S3 model can't write flash with this IDF 4.4 core. The ESP32 model sometimes trips the stock bootloader's watchdog before the app starts; the test reports that and fails only on resets after the app has started. |
| A commissioned device boots: `config.json` (the VOANZO two-door preset with exit buttons) loads, `applySettings()` runs, both Wiegand readers start, both doors get their relay and exit button, no relay energised, no error, `loop()` runs, over two boots; the second also first drives both relays locked and attaches both exit buttons from the NVS copy the first stored. A third boot with `config.json` damaged: the settings are refused, both relays are driven locked and both exit buttons attached (by interrupt) from the NVS copy alone, no relay is energised, `loop()` runs. What is checked is what the firmware drives and attaches (its log); QEMU does not model the pin levels. | `TARGET=esp32 SCENARIO=configured QEMU=... bash test/qemu/boot-test.sh` | ESP32 only: the image is built with PlatformIO's `mklittlefs` from `test/qemu/voanzo-config.json`. The S3 model cannot read it either (LittleFS reports a corrupted directory on a valid image). |

The simulator re-implements the firmware's HTTP and WebSocket protocol in Node. The UI test therefore proves the browser side and the protocol contract. On the firmware side the reader session (`core/reader.h`), settings loading (`core/settings.h`), the save policy, the relay loop and the momentary relock deadline (`core/relaytimer.h`) run in the native tests; the command table is checked against the UI and the simulator (`check-protocol`). The remaining glue is covered by compilation and the QEMU boot, **not** by running on a device.
