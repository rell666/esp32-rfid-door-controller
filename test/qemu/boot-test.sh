#!/usr/bin/env bash
# Boots the firmware in Espressif's QEMU (machine esp32s3) and checks that it
# finishes setup() and keeps running loop() without a panic or reboot.
#
# Limits of the emulator with this ESP-IDF 4.4 based core, so NOT covered here:
#  - WiFi: there is no radio; the esp32s3-qemu build skips WiFi bring-up
#    (QEMU_NO_WIFI) and starts only the TCP/IP stack.
#  - Flash (S3 only): LittleFS can neither format the emulated S3 flash nor
#    mount a valid image written into it, so that run exercises the
#    "filesystem unusable" path instead. On the
#    original ESP32 the flash works and format + remount are checked.
#
# SCENARIO=configured boots a commissioned device instead of a blank one: a
# LittleFS image holding test/qemu/voanzo-config.json (the VOANZO two-door
# preset with exit buttons) is built with PlatformIO's mklittlefs and written
# at the spiffs partition's offset, and setup() must load and apply it. A
# third boot then finds config.json damaged: the exit buttons must still be
# attached from the NVS copy the first two boots stored, and the relays held
# locked. A fourth asks for a restart and checks it goes through the restart
# gate (core/restart.h) within its 30 s grace.
#
#   TARGET=esp32s3|esp32 [SCENARIO=blank|configured] QEMU=/path/to/qemu-system-xtensa bash test/qemu/boot-test.sh
# QEMU builds: https://github.com/espressif/qemu/releases (qemu-xtensa-softmmu-*).
set -euo pipefail
cd "$(dirname "$0")/../.."
QEMU=${QEMU:-qemu-system-xtensa}
PIO=${PIO:-pio}
RUN_SECONDS=${RUN_SECONDS:-30}
TARGET=${TARGET:-esp32s3}
SCENARIO=${SCENARIO:-blank}
case "$TARGET" in
	esp32s3) ENV=esp32s3-qemu; MACHINE=esp32s3; FLASH_MB=16 ;; # IDF 4.4 does not recognise QEMU's 8 MB S3 chip
	esp32) ENV=esp32wroom-qemu; MACHINE=esp32; FLASH_MB=4 ;;
	*) echo "unknown TARGET $TARGET" >&2; exit 2 ;;
esac
case "$SCENARIO" in
	blank) ;;
	configured)
		# the S3 model cannot read a valid LittleFS image either ("Corrupted
		# dir pair", measured 2026-10-15), so there is nothing to configure
		[ "$TARGET" = esp32 ] || { echo "SCENARIO=configured needs TARGET=esp32" >&2; exit 2; }
		MKLITTLEFS=${MKLITTLEFS:-${PLATFORMIO_CORE_DIR:-$HOME/.platformio}/packages/tool-mklittlefs/mklittlefs}
		[ -x "$MKLITTLEFS" ] || { echo "mklittlefs not found at $MKLITTLEFS (bash tools/bootstrap.sh installs it)" >&2; exit 2; }
		;;
	*) echo "unknown SCENARIO $SCENARIO" >&2; exit 2 ;;
esac

"$PIO" run -e "$ENV" >/dev/null
work=$(mktemp -d "${HOME}/scratch/qemu-boot-XXXXXX")
trap 'rm -rf "$work"' EXIT
# Pad with 0xFF (erased flash) so LittleFS sees a blank partition.
python3 - "$work/flash.bin" "bin/$ENV-full.bin" "$FLASH_MB" <<'PY'
import sys
img = open(sys.argv[2], "rb").read()
open(sys.argv[1], "wb").write(img + b"\xff" * (int(sys.argv[3]) * 1024 * 1024 - len(img)))
PY
# spiffs (LittleFS) partition of the ESP32 table: "offset size"
spiffs_partition() {
	python3 - partitions-esp32wroom.csv <<'PY'
import sys
for line in open(sys.argv[1]):
    f = [x.strip() for x in line.split("#")[0].split(",")]
    if len(f) >= 5 and f[0] == "spiffs":
        print(int(f[3], 0), int(f[4], 0))
        sys.exit(0)
sys.exit("no spiffs partition in the table")
PY
}
# write file $1 into the flash image at byte offset $2
write_at() {
	python3 - "$work/flash.bin" "$1" "$2" <<'PY'
import sys
img = bytearray(open(sys.argv[1], "rb").read())
data = open(sys.argv[2], "rb").read()
at = int(sys.argv[3])
img[at:at + len(data)] = data
open(sys.argv[1], "wb").write(img)
PY
}
# a LittleFS image of directory $1 written over the spiffs partition
write_fs() {
	read -r fs_offset fs_size <<<"$(spiffs_partition)"
	# page and block size as PlatformIO's buildfs uses for the ESP32
	"$MKLITTLEFS" -c "$1" -p 256 -b 4096 -s "$fs_size" "$work/fs.bin" >/dev/null
	write_at "$work/fs.bin" "$fs_offset"
}
if [ "$SCENARIO" = configured ]; then
	mkdir "$work/fs"
	cp test/qemu/voanzo-config.json "$work/fs/config.json"
	write_fs "$work/fs"
fi

boot() {
	timeout "$RUN_SECONDS" "$QEMU" -nographic -machine "$MACHINE" \
		-drive file="$work/flash.bin",if=mtd,format=raw 2>&1 || true
}
first=$(boot)
second=$(boot) # same flash again: must mount the filesystem formatted on the first boot

echo "$first" | sed -n '1,40p'
echo "---- second boot (tail) ----"
echo "$second" | tail -8

fail=0
expect() { if echo "$1" | grep -q "$2"; then echo "  ok   $3"; else echo "  FAIL $3"; fail=1; fi; }
reject() { if echo "$1" | grep -q "$2"; then echo "  FAIL $3"; fail=1; else echo "  ok   $3"; fi; }
expect "$first" "Ironframe RFID (esp-rfid) v" "first boot: firmware banner"
expect "$first" "System setup completed, running" "first boot: setup() completed"
reject "$first" "assert failed\|Guru Meditation\|abort()\|Backtrace:" "first boot: no panic"
# The app must start exactly once and never reset after that (every ROM prints
# one "rst:0x.." line per reset). Resets BEFORE the app banner happen inside
# the stock ESP-IDF 4.4 second-stage bootloader: QEMU's ESP32 model trips the
# bootloader watchdog on about one cold boot in three (measured 2026-10-11,
# before any of this firmware runs), so they are reported, not failed.
app_resets() {
	local banners after
	banners=$(echo "$1" | grep -c 'Ironframe RFID (esp-rfid) v')
	after=$(echo "$1" | sed -n '/Ironframe RFID (esp-rfid) v/,$p' | grep -c 'rst:0x')
	echo "$banners $after"
}
for run in first second; do
	out=${!run}
	read -r banners after <<<"$(app_resets "$out")"
	early=$(echo "$out" | sed '/Ironframe RFID (esp-rfid) v/,$d' | grep -c 'rst:0x')
	[ "$early" -gt 1 ] && echo "  note $run boot: $((early - 1)) reset(s) inside the bootloader before the app started (emulator)"
	if [ "$banners" = 1 ] && [ "$after" = 0 ]; then echo "  ok   $run boot: app started once, no reset in ${RUN_SECONDS}s"; else echo "  FAIL $run boot: app started $banners times, $after reset(s) after start"; fail=1; fi
done
expect "$first" "LOOP ALIVE" "first boot: loop() still running at the end"
# loop() reports every 5 s (emulated); the emulator build's loop watchdog
# allows 30 s (QEMU is slow, ledger H27.10), so a stall shorter than that is
# caught here: at least 2 reports in a boot (the second boot starts slower)
alive_reports() { echo "$1" | grep -c "LOOP ALIVE"; }
for run in first second; do
	n=$(alive_reports "${!run}")
	if [ "$n" -ge 2 ]; then echo "  ok   $run boot: loop() reported $n times"; else echo "  FAIL $run boot: loop() reported only $n times"; fail=1; fi
done
expect "$second" "System setup completed, running" "second boot: setup() completed"
reject "$second" "assert failed\|Guru Meditation\|abort()\|Backtrace:" "second boot: no panic"
if [ "$SCENARIO" = configured ]; then
	# both boots load config.json; the second also starts with the relay and
	# exit-button copy the first stored in NVS (lockRelaysAtBoot,
	# setupExitButtonsAtBoot), which config.json then replaces
	for run in first second; do
		out=${!run}
		expect "$out" "Configuration done" "$run boot: config.json loaded and applySettings() ran"
		reject "$out" "Missing or invalid config file\|configuration refused\|Filesystem formatted\|Filesystem unavailable" "$run boot: configuration neither missing, refused nor reformatted"
		reject "$out" "\[ ERRO \]" "$run boot: no error logged"
		expect "$out" "Reader 1: Wiegand D0 34 D1 35 started" "$run boot: reader 1 started"
		expect "$out" "Reader 2: Wiegand D0 32 D1 33 started" "$run boot: reader 2 started"
		reject "$out" "Wiegand reader not started\|GPIO interrupt service unavailable" "$run boot: no reader refused"
		expect "$out" "Door 1: relay GPIO 16, exit button GPIO 13" "$run boot: door 1 relay and exit button"
		expect "$out" "Door 2: relay GPIO 17, exit button GPIO 4" "$run boot: door 2 relay and exit button"
		reject "$out" "energised" "$run boot: no relay energised"
		# door 1 has no rhold (settings from before 1.7: relay on = unlocked),
		# door 2 is set to Locked (rhold 1: relay on while locked, maglock on NO)
		expect "$out" "Relay GPIO 16 locked (LOW), relay off while locked" "$run boot: relay 1 driven to its locked level, LOW (no rhold: unlocked when on)"
		# a DS3231 is set on GPIO21/22 and nothing is on the bus: logged, no panic
		expect "$out" "RTC not found on SDA 21 / SCL 22" "$run boot: the RTC set but absent is reported, the boot carries on"
		expect "$out" "Relay GPIO 17 locked (HIGH), relay on while locked" "$run boot: relay 2 driven to its locked level, HIGH (rhold 1: locked when on)"
	done
	# voanzo-config.json holds the admin password in clear, as 1.4.1 stored
	# it: the first boot replaces it with its hash, once (core/adminpass.h)
	expect "$first" "Admin password now stored as a digest hash" "first boot: admin password in clear rewritten as its hash"
	reject "$second" "Admin password now stored as a digest hash" "second boot: already a hash, not rewritten again"
	expect "$second" "LOOP ALIVE" "second boot: loop() still running at the end"
	expect "$second" "Relay GPIO 16 driven locked (LOW) from NVS" "second boot: relay 1 locked from the NVS copy before config.json"
	expect "$second" "Relay GPIO 17 driven locked (HIGH) from NVS" "second boot: relay 2 (rhold 1) locked, relay on, from the NVS copy before config.json"
	expect "$second" "Door 1: exit button GPIO 13 attached from NVS (interrupt), relay GPIO 16" "second boot: door 1 exit button attached from the NVS copy before config.json"
	expect "$second" "Door 2: exit button GPIO 4 attached from NVS (interrupt), relay GPIO 17" "second boot: door 2 exit button attached from the NVS copy before config.json"

	# Third boot: config.json is damaged (no .bak), as after a bad save or a
	# corrupted flash. The settings are refused, so setupDoors() never runs:
	# the exit buttons and relays come from the NVS copy alone, and the
	# relays must stay locked (README "Physical recovery").
	rm -rf "$work/fs" && mkdir "$work/fs"
	head -c 300 test/qemu/voanzo-config.json > "$work/fs/config.json"
	write_fs "$work/fs"
	third=$(boot)
	echo "---- third boot: damaged config.json (tail) ----"
	echo "$third" | tail -8
	expect "$third" "Missing or invalid config file" "third boot: damaged config.json refused"
	reject "$third" "Configuration done" "third boot: and no settings applied"
	expect "$third" "Door 1: exit button GPIO 13 attached from NVS (interrupt), relay GPIO 16" "third boot: door 1 exit button attached from the NVS copy"
	expect "$third" "Door 2: exit button GPIO 4 attached from NVS (interrupt), relay GPIO 17" "third boot: door 2 exit button attached from the NVS copy"
	reject "$third" "Filesystem formatted" "third boot: filesystem not reformatted"
	reject "$third" "assert failed\|Guru Meditation\|abort()\|Backtrace:" "third boot: no panic"
	# the VOANZO relays are active high: locked = LOW for door 1, HIGH for
	# door 2 (rhold 1: relay on while locked). Every later change of
	# a relay goes through relayLoop, which prints "relay <n> energised".
	expect "$third" "Relay GPIO 16 driven locked (LOW) from NVS" "third boot: relay 1 driven locked from the NVS copy"
	expect "$third" "Relay GPIO 17 driven locked (HIGH) from NVS" "third boot: relay 2 (rhold 1) driven locked, relay on, from the NVS copy"
	reject "$third" "energised" "third boot: no relay energised"
	expect "$third" "LOOP ALIVE" "third boot: loop() still running at the end"
	# the damaged-storage path through setupWifi(): the TCP/IP stack started
	# without the radio, so the web server did not assert (ledger H27.3)
	reject "$third" "Invalid mbox" "third boot: no lwIP assert from the web server (damaged storage)"

	# Fourth boot (plan 1.9.1 B3): a restart asked 2 s after boot (the
	# /qemu-restart-test file, QEMU builds only) goes through the one restart
	# gate: it happens once nothing is in progress, or 30 s after it was
	# asked however busy, and the app starts again (once: the file is gone).
	rm -rf "$work/fs" && mkdir "$work/fs"
	cp test/qemu/voanzo-config.json "$work/fs/config.json"
	: > "$work/fs/qemu-restart-test"
	write_fs "$work/fs"
	fourth=$(RUN_SECONDS=80 boot)
	echo "---- fourth boot: a restart asked through the gate (tail) ----"
	echo "$fourth" | grep -E "restart asked|Restart waiting|going to reboot|Ironframe RFID \(esp-rfid\) v" | head -8
	expect "$fourth" "\[ TEST \] restart asked" "fourth boot: the test asked for a restart"
	expect "$fourth" "System is going to reboot (QEMU restart test)" "fourth boot: the restart went through the gate"
	waited=$(echo "$fourth" | sed -n 's/.*going to reboot (QEMU restart test) | \(idle\|forced\) after \([0-9]*\) ms.*/\2/p' | head -1)
	if [ -n "$waited" ] && [ "$waited" -le 31000 ]; then echo "  ok   fourth boot: restarted ${waited} ms after it was asked (at most the 30 s grace)"; else echo "  FAIL fourth boot: restart wait '${waited}' ms (want <= 31000)"; fail=1; fi
	read -r banners _ <<<"$(app_resets "$fourth")"
	if [ "$banners" = 2 ]; then echo "  ok   fourth boot: the app started again after the restart, once"; else echo "  FAIL fourth boot: app started $banners times (want 2)"; fail=1; fi
	reject "$fourth" "assert failed\|Guru Meditation\|abort()\|Backtrace:" "fourth boot: no panic"
	expect "$(echo "$fourth" | sed -n '/going to reboot (QEMU restart test)/,$p')" "System setup completed, running" "fourth boot: setup() completed again after the restart"
elif [ "$TARGET" = esp32 ]; then
	# QEMU's ESP32 flash is writable with this core (the S3 one is not), so the
	# filesystem path is covered too: format once, then mount what was written
	expect "$first" "Filesystem formatted" "first boot: blank LittleFS partition formatted"
	reject "$second" "Filesystem formatted" "second boot: filesystem from the first boot mounted, not reformatted"

	# Third boot: the LittleFS partition holds data that is not a filesystem,
	# as after a serial flash of a new partition layout without --erase-all
	# (H10). The firmware must refuse to format it (fail secure), keep
	# running, and not panic.
	read -r fs_offset _ <<<"$(spiffs_partition)"
	python3 -c 'import sys; open(sys.argv[1], "wb").write(bytes((i * 37 + 11) & 0xFF for i in range(64 * 1024)))' "$work/junk.bin"
	write_at "$work/junk.bin" "$fs_offset"
	third=$(boot)
	echo "---- third boot: foreign data in the LittleFS partition (tail) ----"
	echo "$third" | tail -8
	expect "$third" "Filesystem unavailable with non-blank" "third boot: foreign data in the LittleFS partition is refused"
	reject "$third" "Filesystem formatted" "third boot: and not formatted (fail secure)"
	reject "$third" "assert failed\|Guru Meditation\|abort()\|Backtrace:" "third boot: no panic"
	expect "$third" "LOOP ALIVE" "third boot: loop() keeps running (BOOT recovery stays possible)"
fi

if [ $fail = 0 ]; then echo "QEMU BOOT TEST PASSED ($TARGET, $SCENARIO)"; exit 0; fi
# keep both full boot logs (the work dir is deleted on exit): an intermittent
# failure is otherwise gone with only the tail printed above
keep="${HOME}/scratch/qemu-boot-fail-$TARGET-$SCENARIO-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$keep" && echo "$first" > "$keep/first.log" && echo "$second" > "$keep/second.log" && echo "${third:-}" > "$keep/third.log" && echo "${fourth:-}" > "$keep/fourth.log"
echo "  full boot logs kept in $keep"
exit 1
