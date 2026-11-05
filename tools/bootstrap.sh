#!/usr/bin/env bash
# Builds the toolchain that test/all.sh needs, outside the repo, so another
# machine (or a rebuilt one) can run every gate. Versions are pinned to the
# ones the gates were proven with; what is already installed is kept.
#
#   bash tools/bootstrap.sh            install what is missing
#   bash tools/bootstrap.sh --check    report only; exit 1 if anything is missing
#
# IFRFID_TOOLS (default ~/scratch/2026-10-11-esp-rfid, the path CONTRIBUTING.md and
# test/all.sh use) receives pio-venv/ and qemu/. Written for Ubuntu 24.04 on
# x86-64: Espressif's QEMU links SDL even when run headless, and the SDL
# libraries are that release's packages, unpacked next to it (no root).
set -euo pipefail
cd "$(dirname "$0")/.."

T=${IFRFID_TOOLS:-$HOME/scratch/2026-10-11-esp-rfid}
PIO_VERSION=6.2.0
MKLITTLEFS_VERSION=1.203.210628
QEMU_TAG=esp-develop-9.2.2-20260417
QEMU_ASSET=qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-linux-gnu.tar.xz
QEMU_SHA256=0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35
QEMU_VERSION="esp_develop_9.2.2_20260417"
# QEMU's SDL dependency chain, as Ubuntu 24.04 names the packages
SDL_DEBS="libsdl2-2.0-0 libasound2t64 libasyncns0 libdecor-0-0 libflac12t64 libmp3lame0 libmpg123-0t64 libogg0 libopus0 libpulse0 libsamplerate0 libsndfile1 libvorbis0a libvorbisenc2 libxss1"

check=0
[ "${1:-}" = "--check" ] && check=1
missing=0
ok() { echo "  ok    $1"; }
todo() {
	echo "  MISS  $1"
	missing=1
}
need() { command -v "$1" >/dev/null 2>&1 || { echo "needs $1 ($2)"; exit 1; }; }

UV=$(command -v uv || ls "$HOME/.local/bin/uv" 2>/dev/null || true)
[ -n "$UV" ] || need python3 "for the PlatformIO venv (or install uv)"
need node "for the asset builder and the e2e"
need npm "for the asset builder and the e2e"
need curl "to fetch QEMU"
need sha256sum "to verify QEMU"
mkdir -p "$T"

# 1. PlatformIO (and, through it, the espressif32 platform and the libraries)
PIO=$T/pio-venv/bin/pio
if [ -x "$PIO" ] && "$PIO" --version | grep -q "version $PIO_VERSION"; then
	ok "PlatformIO $PIO_VERSION ($PIO)"
elif [ $check = 1 ]; then
	todo "PlatformIO $PIO_VERSION in $T/pio-venv"
else
	if [ -n "$UV" ]; then
		# uv brings its own Python (Ubuntu's python3 has no venv module by default)
		"$UV" venv -q --python 3.11 "$T/pio-venv"
		"$UV" pip install -q --python "$T/pio-venv/bin/python" "platformio==$PIO_VERSION"
	else
		python3 -m venv "$T/pio-venv"
		"$T/pio-venv/bin/pip" install -q "platformio==$PIO_VERSION"
	fi
	ok "PlatformIO $PIO_VERSION installed"
fi
if [ -f .pio/libdeps/esp32s3/ArduinoJson/src/ArduinoJson.h ] && [ -d .pio/libdeps/esp32wroom ]; then
	ok "platform and libraries (.pio/libdeps)"
elif [ $check = 1 ]; then
	todo "platform and libraries: $PIO pkg install -e esp32s3 -e esp32wroom"
else
	"$PIO" pkg install -e esp32s3 -e esp32wroom
	ok "platform and libraries installed"
fi

# mklittlefs builds the configured-device image for the QEMU boot test; the
# version is the one the espressif32 platform pins for its own buildfs
MKLITTLEFS=${PLATFORMIO_CORE_DIR:-$HOME/.platformio}/packages/tool-mklittlefs/mklittlefs
if [ -x "$MKLITTLEFS" ]; then
	ok "mklittlefs ($MKLITTLEFS)"
elif [ $check = 1 ]; then
	todo "mklittlefs: $PIO pkg install -g -t platformio/tool-mklittlefs@$MKLITTLEFS_VERSION"
else
	"$PIO" pkg install -g -t "platformio/tool-mklittlefs@$MKLITTLEFS_VERSION"
	ok "mklittlefs installed"
fi

# 2. Espressif QEMU, verified against the pinned checksum
Q=$T/qemu
QBIN=$Q/qemu/bin/qemu-system-xtensa
SDL=$Q/sdl/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH="$SDL:$SDL/pulseaudio${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ -x "$QBIN" ]; then
	ok "QEMU binary ($QBIN)"
elif [ $check = 1 ]; then
	todo "QEMU $QEMU_TAG in $Q"
else
	mkdir -p "$Q"
	curl -fsSL -o "$Q/q.tar.xz" "https://github.com/espressif/qemu/releases/download/$QEMU_TAG/$QEMU_ASSET"
	echo "$QEMU_SHA256  $Q/q.tar.xz" | sha256sum -c --quiet || { echo "QEMU download does not match the pinned checksum"; exit 1; }
	tar xJf "$Q/q.tar.xz" -C "$Q"
	ok "QEMU $QEMU_TAG installed"
fi
if [ -f "$SDL/libSDL2-2.0.so.0" ]; then
	ok "SDL libraries for QEMU ($SDL)"
elif [ $check = 1 ]; then
	todo "SDL libraries for QEMU in $Q/sdl"
else
	need apt-get "to download the SDL packages (Ubuntu 24.04)"
	need dpkg "to unpack the SDL packages"
	(cd "$Q" && apt-get download $SDL_DEBS)
	for d in "$Q"/*.deb; do dpkg -x "$d" "$Q/sdl"; done
	ok "SDL libraries unpacked"
fi
if [ -x "$QBIN" ] && [ -f "$SDL/libSDL2-2.0.so.0" ]; then
	if "$QBIN" --version | grep -q "$QEMU_VERSION"; then ok "QEMU runs: $("$QBIN" --version | head -1)"; else todo "QEMU does not run or is not $QEMU_VERSION"; fi
fi

# 3. Node packages: the asset builder and the e2e (lockfiles in the repo)
for dir in tools/webfilesbuilder test/e2e; do
	if [ -d "$dir/node_modules" ]; then
		ok "$dir/node_modules"
	elif [ $check = 1 ]; then
		todo "$dir/node_modules: (cd $dir && npm ci)"
	else
		(cd "$dir" && npm ci --no-audit --no-fund)
		ok "$dir/node_modules installed"
	fi
done

# 4. A Chromium for the e2e (test/all.sh looks for chromium, chromium-browser,
# google-chrome, or CHROMIUM=...)
if [ -n "${CHROMIUM:-}" ] || command -v chromium >/dev/null || command -v chromium-browser >/dev/null || command -v google-chrome >/dev/null; then
	ok "Chromium"
else
	todo "Chromium: install one (apt install chromium-browser) or set CHROMIUM=/path/to/chrome"
fi

if [ $missing = 1 ]; then
	echo "BOOTSTRAP INCOMPLETE"
	exit 1
fi
echo "TOOLCHAIN READY ($T): run bash test/all.sh"
