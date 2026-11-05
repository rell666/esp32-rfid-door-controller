#!/usr/bin/env bash
# Builds a release from its tag twice and checks the result (plan 1.9.1 E3,
# review 8 R5-5): run it on the release, not before (it builds the release
# images; the gates do not run it).
#   bash test/check-release.sh <version>              e.g. 1.9.1: tag ironframe-<version>
#   CHECK_ONLY=1 bash test/check-release.sh <commit>   reproducibility of a commit,
#                                                     no release image (IRONFRAME_RELEASE unset)
# A fresh clone of this repo at the ref, built twice (bin/ and .pio/build
# removed between); the two bin/esp32wroom.bin and esp32wroom-full.bin must
# be identical, the image must carry "<version> (<sha7>)", and the release
# files' SHA256SUMS (named by version) are written beside the clone.
# Last line: RELEASE CHECK PASSED <ref> <sha7> | RELEASE CHECK FAILED ...
set -u
ref=${1:?usage: bash test/check-release.sh <version> | CHECK_ONLY=1 ... <commit>}
src=$(cd "$(dirname "$0")/.." && pwd)
T=${IFRFID_TOOLS:-$HOME/scratch/2026-10-11-esp-rfid}
PIO=${PIO:-$T/pio-venv/bin/pio}
work=${WORK:-$HOME/scratch/ifrfid-release-check-$(date +%Y%m%d-%H%M%S)}
fail() { echo "RELEASE CHECK FAILED $ref: $*"; exit 1; }
if [ "${CHECK_ONLY:-0}" = 1 ]; then
	gitref=$ref
	unset IRONFRAME_RELEASE
else
	gitref=ironframe-$ref
	export IRONFRAME_RELEASE=1
fi
mkdir -p "$work" || fail "cannot make $work"
git clone -q "$src" "$work/src" || fail "clone"
cd "$work/src" || fail "no clone"
git -c advice.detachedHead=false checkout -q "$gitref" || fail "no ref $gitref"
sha=$(git rev-parse --short=7 HEAD)
ver=$(sed -n 's/^#define IRONFRAME_VERSION "\(.*\)"/\1/p' src/main.cpp)
[ -n "$ver" ] || fail "no IRONFRAME_VERSION"
for n in 1 2; do
	rm -rf bin .pio/build
	"$PIO" run -e esp32wroom >"$work/build$n.log" 2>&1 || fail "build $n (log $work/build$n.log)"
	mkdir -p "$work/out$n" && cp bin/esp32wroom.bin bin/esp32wroom-full.bin "$work/out$n/" || fail "no images after build $n"
done
for f in esp32wroom.bin esp32wroom-full.bin; do
	cmp -s "$work/out1/$f" "$work/out2/$f" || fail "$f differs between two builds of $sha"
done
strings "$work/out1/esp32wroom.bin" | grep -qx "$ver ($sha)" || fail "the image does not carry \"$ver ($sha)\""
if [ "${CHECK_ONLY:-0}" != 1 ]; then
	cp "$work/out1/esp32wroom.bin" "$work/ironframe-rfid-$ver.bin"
	cp "$work/out1/esp32wroom-full.bin" "$work/ironframe-rfid-$ver-full-flash.bin"
	(cd "$work" && sha256sum "ironframe-rfid-$ver.bin" "ironframe-rfid-$ver-full-flash.bin" >"ironframe-rfid-$ver-SHA256SUMS.txt") || fail "SHA256SUMS"
	echo "release files in $work"
fi
echo "RELEASE CHECK PASSED $ref $sha"
