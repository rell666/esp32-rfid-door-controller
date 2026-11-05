#!/usr/bin/env bash
# Checks the pre-commit hook (tools/hooks/pre-commit), its installer and the
# tree id all.sh records (test/tree-id.sh), on a throwaway git repo.
set -u
src=$(cd "$(dirname "$0")/.." && pwd)
base=$(mktemp -d "${TMPDIR:-$HOME/scratch}/ifrfid-hook-XXXXXX")
trap 'rm -rf "$base"' EXIT
failures=0
check() { if [ "$1" = 0 ]; then echo "  ok   $2"; else echo "  FAIL $2"; failures=$((failures + 1)); fi; }
g() { git -c user.name=t -c user.email=t@t -c commit.gpgSign=false "$@"; }

r=$base/repo
mkdir -p "$r/test" "$r/tools/hooks"
cp "$src/test/tree-id.sh" "$r/test/"
cp "$src/tools/hooks/pre-commit" "$r/tools/hooks/"
cp "$src/tools/install-hooks.sh" "$r/tools/"
cp "$src/test/check-hook-installed.sh" "$r/test/"
cd "$r"
git init -q
echo "ignored/" >.gitignore
echo one >a.txt
g add -A && g commit -q -m base
IFRFID_CI=0 bash test/check-hook-installed.sh >/dev/null 2>&1; [ $? -ne 0 ]; check $? "hook-installed gate fails in a clone without the hook"
IFRFID_CI=1 bash test/check-hook-installed.sh >/dev/null 2>&1; check $? "hook-installed gate passes in CI (IFRFID_CI=1) without it"
out=$(bash tools/install-hooks.sh); check $? "installer installs the hook ($out)"
IFRFID_CI=0 bash test/check-hook-installed.sh >/dev/null 2>&1; check $? "hook-installed gate passes once the hook is installed"
out=$(bash tools/install-hooks.sh); [ "$out" = "pre-commit: already installed" ]; check $? "installer run twice: already installed"
gates=$(sed -n 's/^REQUIRED_GATES="\(.*\)"$/\1/p' tools/hooks/pre-commit)
pass() { echo "HEAD $(git rev-parse HEAD) tree $1"; for x in $gates; do [ "$x" = "${2:-}" ] || echo "PASS $x 1s"; done; echo "ALL GATES PASSED $(git rev-parse HEAD) + uncommitted tree $1"; }
rec=$(git rev-parse --git-common-dir)/ifrfid-gates
mkdir -p "$rec"

echo two >a.txt
mkdir -p ignored && echo x >ignored/junk
t=$(bash test/tree-id.sh)
g add -A
[ "$(bash test/tree-id.sh)" = "$t" ]; check $? "tree id is the same staged or not"
[ "$(git write-tree)" = "$t" ]; check $? "tree id == git write-tree of the same changes staged (ignored files left out)"
g commit -q -m two 2>/dev/null; [ $? -ne 0 ]; check $? "no gate record: commit refused"
{ echo "HEAD x"; echo "GATES FAILED $(git rev-parse HEAD)"; } >"$rec/$t"
g commit -q -m two 2>/dev/null; [ $? -ne 0 ]; check $? "a failed run's record: commit refused"
pass 0123456789abcdef0123456789abcdef01234567 >"$rec/0123456789abcdef0123456789abcdef01234567"
g commit -q -m two 2>/dev/null; [ $? -ne 0 ]; check $? "a pass for another tree: commit refused"
{ echo "HEAD x"; echo "ALL GATES PASSED $(git rev-parse HEAD) + uncommitted tree $t"; } >"$rec/$t"
g commit -q -m two 2>/dev/null; [ $? -ne 0 ]; check $? "a record with the last line only (no PASS lines): commit refused"
pass "$t" e2e >"$rec/$t"
g commit -q -m two 2>/dev/null; [ $? -ne 0 ]; check $? "a record missing one gate's PASS line: commit refused"
pass "$t" >"$rec/$t"
g commit -q -m two 2>/dev/null; check $? "a pass for this exact tree: commit accepted"

echo three >a.txt
echo new >b.txt
t=$(bash test/tree-id.sh)
pass "$t" >"$rec/$t"
g add a.txt
[ "$(git write-tree)" != "$t" ]; check $? "an untracked file the gates saw changes the tree id"
g commit -q -m three 2>/dev/null; [ $? -ne 0 ]; check $? "committing part of what the gates tested: refused"
g commit -q --no-verify -m three 2>/dev/null; check $? "--no-verify bypasses the hook"

rm .git/hooks/pre-commit && echo '#!/bin/sh' >.git/hooks/pre-commit
bash tools/install-hooks.sh >/dev/null 2>&1; [ $? -ne 0 ]; check $? "installer refuses to replace a different hook"

# the hook's gate list is all.sh's
allsh=$(sed -n 's/^[[:space:]]*gate \([a-z0-9-]*\) .*/\1/p' "$src/test/all.sh" | sort | tr '\n' ' ')
hookl=$(echo $gates | tr ' ' '\n' | sort | tr '\n' ' ')
[ -n "$gates" ] && [ "$allsh" = "$hookl" ]; check $? "the hook requires exactly all.sh's gates ($hookl)"

echo "$failures failures"
[ $failures -eq 0 ]
