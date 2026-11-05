# Contributing to Ironframe RFID

How to build, test and change this firmware.

## Where to work

- The toolchain lives outside the repo: `bash tools/bootstrap.sh` installs the pinned PlatformIO and Espressif QEMU into `~/scratch/2026-10-11-esp-rfid/` (`--check` lists what is missing).
- Install the pre-commit hook once per clone: `bash tools/install-hooks.sh`.

## Layout

| Path | What |
|---|---|
| `src/main.cpp`, `src/*.esp` | Firmware (Arduino on ESP-IDF 4.4): start-up, Wi-Fi, web server and WebSocket, doors, readers, users, logs, MQTT |
| `src/core/` | Plain C++ with no Arduino dependency: settings parsing and checks, pin policy, live settings, Wiegand frames, users, lockouts, relays. Unit-tested on the host |
| `src/websrc/` | The web UI source: `pages/*.htm` (one template per page), `js/*.js`, `css/app.css` + `page-*.css` |
| `src/webh/` | Generated from `src/websrc` by the web builder. Never edit by hand |
| `tools/webfilesbuilder/` | The web builder (gulp) |
| `test/` | Every gate run by `test/all.sh` |
| `docs/evidence/RELEASES.md` | Release records |
| `scripts/` | PlatformIO build hooks: `version.py` (version string), `bins.py` (copies images to `bin/`) |

## Building

```sh
PIO=~/scratch/2026-10-11-esp-rfid/pio-venv/bin/pio
$PIO run -e esp32wroom        # VOANZO board: bin/esp32wroom.bin (Update) + bin/esp32wroom-full.bin (serial, 0x0)
$PIO run -e esp32s3           # ESP32-S3 DevKitC
$PIO run -e esp32wroom-debug  # serial log on (see DEBUGGING.md)
```

The version shown on the device is `IRONFRAME_VERSION` in `src/main.cpp` plus the commit, e.g. `1.7.0 (2e2fa33)`. A build with uncommitted changes reads `-dirty` and must not be installed: commit first. Never commit `bin/*.bin`.

## Changing the web UI

Edit under `src/websrc/`, then rebuild the generated files and commit both:

```sh
cd tools/webfilesbuilder && npm ci && node bin.js
```

- No libraries: plain JavaScript and our own CSS. `test/check-assets.mjs` fails if jQuery, Bootstrap, FooTable or an inline script comes back, or if `src/webh/` is stale.
- A new script must be added to `UI_SCRIPTS` in `tools/webfilesbuilder/gulpfile.js`, or the build fails.
- Controls name their handler with `data-onclick="fn"` (also `data-onchange`, `data-oninput`, `data-onsubmit`), never `onclick=`: the Content-Security-Policy blocks inline script.
- To see the UI without a board, run the end-to-end test (`node test/e2e/run.mjs`); it drives Chromium against the device simulator `test/e2e/device-sim.mjs`. Screenshots land in `test/e2e/shots/`.

## Changing settings

- A setting lives in `src/core/settings.h` and is parsed and checked in `src/core/` (the firmware, the web page's `policy.js` and MQTT `updateconf` all go through the same rules).
- Old stored settings must keep loading: a missing key keeps the old behaviour. Add a native test in `test/native/tests.cpp`; it pins `sizeof(core::Settings)` and the field count, so update those too.
- Say whether the setting applies live or needs a restart (`src/core/livesettings.h`, vectors in `test/vectors/live-settings.json`).
- If MQTT remote admin must not change it, add it to `REMOTE_ADMIN_KEPT` in `src/core/configpolicy.h` and to the list in README-MQTT.md (`test/check-docs.mjs` compares them).

## Before committing

Run every gate on exactly the tree you will commit:

```sh
bash test/all.sh --allow-dirty
```

| Gate | Checks |
|---|---|
| `builds` | Every shipped image builds with no compiler warning in our sources and at least 5 % of its OTA slot free |
| `iram` | The GPIO interrupt paths (Wiegand, exit buttons) stay in IRAM |
| `native` | Host unit tests of `src/core/` |
| `qemu-esp32`, `qemu-esp32-configured`, `qemu-esp32s3` | The images boot in Espressif QEMU, blank and with a VOANZO configuration |
| `assets` | Web UI rules above; `src/webh/` up to date |
| `port` | No ESP8266-only API in the firmware |
| `docs` | README-IRONFRAME.md and README-MQTT.md claims match the code |
| `protocol` | Every WebSocket command the UI sends is handled by the firmware and the simulator |
| `live` | Firmware, UI and simulator agree on which settings apply live |
| `version` | The git version stamp and the release-build refusal |
| `hook` | The pre-commit hook, its installer and the tree id |
| `e2e` | The UI end to end in Chromium against the simulator |

The pre-commit hook refuses the commit unless that run passed on the same tree. Don't run git commands in the clone while `test/all.sh` is running: the `hook` gate compares tree ids and a concurrent git command can fail it.

## Documentation

- User-facing changes go in `CHANGELOG.md` under the next version, with the commit id.
- Wiring, flashing and behaviour go in README-IRONFRAME.md; MQTT in README-MQTT.md; the overview and parts list in README.md.
- Anything that still needs proving on the real board goes in `docs/STATUS.md`.

## Releases

Bump `IRONFRAME_VERSION`, tag `ironframe-<version>`, build with `IRONFRAME_RELEASE=1` on the clean tag, and publish a release with exactly the four files `ironframe-rfid-<version>.bin`, `-full-flash.bin`, `-SHA256SUMS.txt` and `-README.txt`. Record it in `docs/evidence/RELEASES.md`.
