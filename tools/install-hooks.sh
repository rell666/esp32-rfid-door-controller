#!/usr/bin/env bash
# Installs the repo's git hooks (tools/hooks/*) into this clone as symlinks, so
# they follow the checked-out version. Refuses to replace a different hook.
set -euo pipefail
cd "$(dirname "$0")/.."
hooks=$(git rev-parse --git-path hooks)
mkdir -p "$hooks"
for h in tools/hooks/*; do
	name=$(basename "$h")
	target=$(realpath "$h")
	if [ -e "$hooks/$name" ] || [ -L "$hooks/$name" ]; then
		if [ "$(realpath "$hooks/$name")" = "$target" ]; then
			echo "$name: already installed"
			continue
		fi
		echo "$name: $hooks/$name exists and is not ours; move it away first" >&2
		exit 1
	fi
	ln -s "$target" "$hooks/$name"
	echo "$name: installed"
done
