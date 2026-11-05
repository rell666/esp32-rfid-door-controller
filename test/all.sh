#!/usr/bin/env bash
# All gates in one command. Fails closed:
#   - refuses a dirty tree unless --allow-dirty (gates before a commit);
#   - records HEAD and the git tree id of the working tree (test/tree-id.sh:
#     what a commit of it would hold, untracked files included), and fails if
#     either changes while the gates run (an edit mid-run would test two
#     different trees);
#   - a gate that cannot run (no Chromium for e2e) is a failure, unless
#     ALLOW_NO_E2E=1, and then the result says PARTIAL, never PASSED.
#
#   bash test/all.sh [--allow-dirty]
# Toolchain (see CONTRIBUTING.md): IFRFID_TOOLS (default ~/scratch/2026-10-11-esp-rfid)
# holds pio-venv/ and qemu/; CHROMIUM may name the browser for e2e.
# Output: one line per gate, logs in $OUT (default ~/scratch/ifrfid-gates-<sha>),
# and a last line "ALL GATES PASSED <sha> [+ uncommitted] tree <tree id>" /
# "PARTIAL ..." / "GATES FAILED ...". A pass is also recorded as
# <git dir>/ifrfid-gates/<tree id> for the pre-commit hook (tools/hooks).
set -u
cd "$(dirname "$0")/.."
allow_dirty=0
[ "${1:-}" = "--allow-dirty" ] && allow_dirty=1

tree_id() { bash test/tree-id.sh; }

head=$(git rev-parse HEAD) || { echo "GATES FAILED: not a git checkout"; exit 2; }
dirty=$(git status --porcelain | wc -l)
if [ "$dirty" -ne 0 ] && [ $allow_dirty -eq 0 ]; then
	git status --short
	echo "GATES FAILED: refusing a dirty tree ($dirty changes); commit first, or pass --allow-dirty for gates before a commit"
	exit 2
fi
tree=$(tree_id) || { echo "GATES FAILED: cannot compute the tree id"; exit 2; }
T=${IFRFID_TOOLS:-$HOME/scratch/2026-10-11-esp-rfid}
PIO=${PIO:-$T/pio-venv/bin/pio}
QEMU=${QEMU:-$T/qemu/qemu/bin/qemu-system-xtensa}
export LD_LIBRARY_PATH="$T/qemu/sdl/usr/lib/x86_64-linux-gnu:$T/qemu/sdl/usr/lib/x86_64-linux-gnu/pulseaudio${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
OUT=${OUT:-$HOME/scratch/ifrfid-gates-${head:0:7}}
mkdir -p "$OUT"
echo "HEAD $head tree $tree dirty $dirty" | tee "$OUT/summary"

failed=0
gate() {
	local name=$1 start=$SECONDS
	shift
	if "$@" >"$OUT/$name.log" 2>&1; then r=PASS; else r=FAIL; failed=1; fi
	echo "$r $name $((SECONDS - start))s" | tee -a "$OUT/summary"
}
gate builds node test/check-builds.mjs "$PIO"
gate iram python3 test/check-iram.py "$PIO"
gate native bash test/native/run.sh
gate qemu-esp32 env TARGET=esp32 QEMU="$QEMU" PIO="$PIO" bash test/qemu/boot-test.sh
gate qemu-esp32-configured env TARGET=esp32 SCENARIO=configured QEMU="$QEMU" PIO="$PIO" bash test/qemu/boot-test.sh
gate qemu-esp32s3 env TARGET=esp32s3 QEMU="$QEMU" PIO="$PIO" bash test/qemu/boot-test.sh
gate assets node test/check-assets.mjs
gate port node test/check-port.mjs
gate docs node test/check-docs.mjs
gate protocol node test/check-protocol.mjs
gate live node test/check-live-settings.mjs
gate version python3 test/check-version.py
gate hook bash test/check-hook.sh
gate hook-installed bash test/check-hook-installed.sh

partial=""
chromium=${CHROMIUM:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)}
if [ -n "$chromium" ] && [ -d test/e2e/node_modules ]; then
	gate e2e env CHROMIUM="$chromium" node test/e2e/run.mjs
elif [ "${ALLOW_NO_E2E:-0}" = 1 ]; then
	partial="e2e not run (no Chromium or test/e2e/node_modules here)"
	echo "SKIP e2e: $partial" | tee -a "$OUT/summary"
else
	echo "FAIL e2e: cannot run (no Chromium or test/e2e/node_modules); run it where it can, or set ALLOW_NO_E2E=1 to record a PARTIAL result" | tee -a "$OUT/summary"
	failed=1
fi

if [ "$(git rev-parse HEAD)" != "$head" ] || [ "$(tree_id)" != "$tree" ]; then
	echo "FAIL tree changed while the gates ran" | tee -a "$OUT/summary"
	failed=1
fi
if [ $failed -ne 0 ]; then
	echo "GATES FAILED $head (logs in $OUT)" | tee -a "$OUT/summary"
	exit 1
fi
if [ -n "$partial" ]; then
	echo "PARTIAL $head: $partial" | tee -a "$OUT/summary"
	exit 3
fi
echo "ALL GATES PASSED $head$([ "$dirty" -ne 0 ] && echo " + uncommitted") tree $tree" | tee -a "$OUT/summary"
rec="$(git rev-parse --git-common-dir)/ifrfid-gates"
mkdir -p "$rec" && cp "$OUT/summary" "$rec/$tree"
