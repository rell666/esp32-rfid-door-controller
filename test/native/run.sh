#!/usr/bin/env bash
# Builds and runs the host-side tests for src/core with sanitizers.
set -euo pipefail
cd "$(dirname "$0")/../.."
AJ=.pio/libdeps/esp32s3/ArduinoJson/src
if [ ! -f "$AJ/ArduinoJson.h" ]; then
	echo "ArduinoJson not found at $AJ - run: pio pkg install -e esp32s3" >&2
	exit 1
fi
out=$(mktemp -d "${TMPDIR:-$HOME/scratch}/native-XXXXXX")
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -Wno-maybe-uninitialized -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all \
	-I src -isystem "$AJ" test/native/tests.cpp -o "$out/tests"
"$out/tests"
