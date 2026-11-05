#!/usr/bin/env bash
# Prints the git tree id of the working tree as it is now: tracked files with
# their edits plus untracked files that are not ignored, staged or not. It is
# the id `git write-tree` gives once all of that is staged, so a commit of
# exactly this tree has it (the pre-commit hook compares the two). Writes
# blobs to the object store and nothing else; the real index is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
idx=$(mktemp "${TMPDIR:-$HOME/scratch}/ifrfid-index-XXXXXX")
trap 'rm -f "$idx"' EXIT
# start from the real index (its stat cache keeps this fast); none yet: a fresh one
cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || rm -f "$idx"
GIT_INDEX_FILE=$idx git add -A . >/dev/null
GIT_INDEX_FILE=$idx git write-tree
