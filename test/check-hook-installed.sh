#!/usr/bin/env bash
# The pre-commit hook is installed in this clone (plan 1.9.1 E2, review 8
# R5-4): nothing else checked it, and a clone without it commits ungated.
# Passes when .git/hooks/pre-commit (or core.hooksPath's) is this repo's
# tools/hooks/pre-commit, as tools/install-hooks.sh links it. CI checks out
# a fresh clone that never commits: gates.yml sets IFRFID_CI=1 and the check
# says so instead of failing.
#   bash test/check-hook-installed.sh
set -u
cd "$(dirname "$0")/.."
if [ "${IFRFID_CI:-0}" = 1 ]; then
	echo "  ok   CI checkout (IFRFID_CI=1): no commits are made here, the hook is not needed"
	echo "HOOK INSTALLED CHECK PASSED"
	exit 0
fi
hook=$(git rev-parse --git-path hooks/pre-commit) || { echo "  FAIL not a git checkout"; exit 1; }
want=$(realpath tools/hooks/pre-commit)
if [ -e "$hook" ] && [ "$(realpath "$hook")" = "$want" ]; then
	echo "  ok   pre-commit hook installed ($hook -> $want)"
	echo "HOOK INSTALLED CHECK PASSED"
	exit 0
fi
echo "  FAIL the pre-commit hook is not installed in this clone ($hook): run bash tools/install-hooks.sh"
exit 1
