# Debugging

## First look: the board's own logs

Most problems show up without a serial cable:

- **Status page:** firmware version, uptime, **Last restart** (the reset reason: power-on, software restart, watchdog, brown-out or crash; "(crash dump stored)" when there is one), free memory, Wi-Fi, the RTC, and **Wiegand noise** per reader.
- **Logs → Event Log:** start-ups and their reason, settings refused, Wi-Fi changes, rolled-back updates, reader warnings, lockouts.
- **Logs → Access Log:** every card, PIN, exit button and remote open, with the reader and door.

| Symptom | Look at |
|---|---|
| A reader does nothing | Event Log for "reader 1 off" (a removed reader type was stored; since 1.6.0 only Wiegand); Doors & Readers for the reader's pins; the wiring and level shifter (README-IRONFRAME.md) |
| Cards read wrong or not at all | Status → Wiegand noise. Counts rising with nobody at the reader mean wiring: cable length, missing pull-ups on GPIO34/35, D0/D1 crosstalk |
| Board restarts by itself | Status → Last restart (and "Started after" in the Event Log). Brown-out = power supply; watchdog or crash = firmware (read the crash dump below) |
| An update didn't stick | Event Log "A firmware update was rolled back": the new image didn't keep running and the old one was restored |
| Settings "refused" and Wi-Fi off | The stored configuration is damaged or names an unsafe pin. Hold BOOT for 10 s to recover (README-IRONFRAME.md, **Recovery**) |
| Exit button does nothing | Its pin is set up at start-up: use **Save & Reboot**, not just Save. Button between pin and GND |

## Serial log

Release images write no log to serial (only the ESP32's own boot messages). Build a debug image to see the start-up and runtime log:

```sh
PIO=~/scratch/2026-10-11-esp-rfid/pio-venv/bin/pio
$PIO run -e esp32wroom-debug          # VOANZO board: bin/esp32wroom-debug*.bin
$PIO run -e esp32s3-debug             # ESP32-S3: log on native USB
```

- **VOANZO board:** the log is on UART0, the 6-pin serial header, at **115200** baud. Wire a 3.3 V USB-serial adapter as for flashing (adapter TX → board RX, RX → TX, GND → GND; leave IO0 unconnected and the adapter's VCC off).
- **ESP32-S3:** the log is on the native USB port (`/dev/ttyACM*`).

```sh
$PIO device monitor -e esp32wroom-debug -p /dev/ttyUSB0 -f esp32_exception_decoder
```

The `esp32_exception_decoder` filter turns a crash backtrace into file and line numbers. It needs the ELF of the exact image running (`.pio/build/<env>/firmware.elf` from the same build).

## Crash dumps

When the firmware crashes, the ESP32 writes a core dump to its `coredump` partition (`0x3F0000`, 64 KB on the VOANZO layout). After the restart the Status page shows "(crash dump stored)" and the Event Log says "A crash dump is stored in flash". Read it over the serial header:

```sh
esptool.py --chip esp32 --port /dev/ttyUSB0 read_flash 0x3F0000 0x10000 coredump.bin
espcoredump.py info_corefile --core coredump.bin --core-format raw .pio/build/esp32wroom/firmware.elf
```

`espcoredump.py` comes with ESP-IDF (`pip install esp-coredump` also provides it as `esp-coredump`). It needs the ELF of the image that crashed. Release archives keep only the `.bin` files, so rebuild that release's tag (`git checkout ironframe-<version>`, then `IRONFRAME_RELEASE=1 $PIO run -e esp32wroom`) with the pinned toolchain; the tool warns if the ELF does not match the image.

## Without hardware

- **QEMU:** `TARGET=esp32 QEMU=<qemu-system-xtensa> PIO=<pio> bash test/qemu/boot-test.sh` (both live under `~/scratch/2026-10-11-esp-rfid/`) boots the image in Espressif's QEMU and checks the start-up log; `SCENARIO=configured` boots with the VOANZO configuration in `test/qemu/voanzo-config.json`. Its log shows the same serial output as a debug build.
- **Web UI:** `node test/e2e/run.mjs` runs the UI in Chromium against `test/e2e/device-sim.mjs`.
- **Core logic:** `bash test/native/run.sh` runs the host unit tests of `src/core/`.

## Reading the version without logging in

```sh
curl -s -D - -o /dev/null http://<board>/favicon.svg | grep -i etag
```

(A GET: the server answers `HEAD` with 404.)
