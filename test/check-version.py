#!/usr/bin/env python3
# Checks the firmware's git stamp and the release-build refusal
# (scripts/revstamp.py, used by scripts/version.py) on throwaway git repos.
import os
import shutil
import subprocess
import sys
import tempfile

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True  # no scripts/__pycache__ left in the tree
sys.path.insert(0, os.path.join(repo, "scripts"))
import revstamp  # noqa: E402

failures = 0


def check(cond, label, detail=""):
    global failures
    print(("  ok  " if cond else "  FAIL") + " " + label + ("" if cond else " " + str(detail)))
    if not cond:
        failures += 1


def git(d, *args):
    return subprocess.check_output(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main",
                                    "-c", "tag.gpgSign=false", "-c", "commit.gpgSign=false"] + list(args),
                                   cwd=d, stderr=subprocess.STDOUT).decode().strip()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


base = tempfile.mkdtemp(prefix="ifrfid-version-", dir=os.environ.get("TMPDIR") or os.path.expanduser("~/scratch"))
try:
    d = os.path.join(base, "repo")
    os.makedirs(d)
    git(d, "init", "-q")
    write(os.path.join(d, "src/main.cpp"), '#define IRONFRAME_VERSION "9.9.9"\n')
    write(os.path.join(d, ".gitignore"), "bin/\n")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "one")
    sha = git(d, "rev-parse", "--short=7", "HEAD")

    clean = revstamp.rev_stamp(d)
    check(clean == sha, "clean tree: the commit", clean)
    write(os.path.join(d, "bin/esp32wroom.bin"), "x")
    check(revstamp.rev_stamp(d) == sha, "an ignored file (bin/) is not dirty")
    write(os.path.join(d, "src/new.cpp"), "int x;\n")
    check(revstamp.rev_stamp(d) == sha + "-dirty", "an untracked file is dirty", revstamp.rev_stamp(d))
    os.remove(os.path.join(d, "src/new.cpp"))
    write(os.path.join(d, "src/main.cpp"), '#define IRONFRAME_VERSION "9.9.9"\n// edit\n')
    check(revstamp.rev_stamp(d) == sha + "-dirty", "a tracked edit is dirty")
    git(d, "checkout", "-q", "--", "src/main.cpp")

    check(revstamp.rev_stamp(os.path.join(d, "src")) == "unknown", "not the top of the checkout (a tree copied inside another repo): unknown")
    plain = os.path.join(base, "plain")
    os.makedirs(plain)
    check(revstamp.rev_stamp(plain, git=os.path.join(base, "no-such-git")) == "unknown", "no git: unknown")

    version = revstamp.firmware_version(d)
    check(version == "9.9.9", "IRONFRAME_VERSION read from src/main.cpp", version)
    check("does not exist" in (revstamp.release_problem(d, clean, version) or ""), "release: refused without the tag")
    git(d, "tag", "-a", "-m", "r", "ironframe-9.9.9")
    check(revstamp.release_problem(d, revstamp.rev_stamp(d), version) is None, "release: clean tree at its tag is accepted",
          revstamp.release_problem(d, revstamp.rev_stamp(d), version))
    check(revstamp.release_problem(d, sha + "-dirty", version) is not None, "release: a -dirty stamp is refused")
    check(revstamp.release_problem(d, "unknown", version) is not None, "release: an unknown stamp is refused")
    check(revstamp.release_problem(d, sha, "9.9.8") is not None, "release: IRONFRAME_VERSION not matching the tag is refused")
    write(os.path.join(d, "x.txt"), "x")
    git(d, "add", "x.txt")
    git(d, "commit", "-q", "-m", "two")
    check("not tag" in (revstamp.release_problem(d, revstamp.rev_stamp(d), version) or ""), "release: a commit after the tag is refused")

    # the asset hash: the same for the same files, different when one changes
    write(os.path.join(d, "src/webh/a.gz.h"), "one")
    h1 = revstamp.asset_hash(d)
    check(len(h1) == 12 and h1 == revstamp.asset_hash(d), "asset hash: 12 hex digits, the same twice", h1)
    write(os.path.join(d, "src/webh/a.gz.h"), "two")
    check(revstamp.asset_hash(d) != h1, "asset hash: changes with an asset")
    # nothing in the firmware is stamped with the build time (plan 1.9.1 E3)
    stamped = []
    for root, _, files in os.walk(os.path.join(repo, "src")):
        for f in files:
            if f.endswith((".esp", ".cpp", ".h")) and "webh" not in root:
                text = open(os.path.join(root, f), errors="replace").read()
                if "__DATE__" in text or "__TIME__" in text:
                    stamped.append(f)
    check(not stamped, "no __DATE__/__TIME__ in the firmware: two builds of a commit are identical", stamped)
    check("ASSET_HASH" in open(os.path.join(repo, "scripts/version.py")).read(), "the build defines ASSET_HASH")

    # the build script refuses a release build (fails closed) rather than just warn
    vs = open(os.path.join(repo, "scripts/version.py")).read()
    check('os.environ.get("IRONFRAME_RELEASE") == "1"' in vs and "env.Exit(1)" in vs and "release_problem" in vs,
          "scripts/version.py stops a release build on a problem")
finally:
    shutil.rmtree(base, ignore_errors=True)

print("%d failures" % failures)
sys.exit(1 if failures else 0)
