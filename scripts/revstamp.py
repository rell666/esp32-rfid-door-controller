# The git stamp built into the firmware, and the release-build check.
# Plain Python (no SCons) so test/check-version.py can run it; scripts/version.py
# calls it at build time.
import os
import re
import subprocess


def _git(project_dir, *args, git="git"):
    return subprocess.check_output([git] + list(args), cwd=project_dir,
                                   stderr=subprocess.DEVNULL).decode().strip()


def rev_stamp(project_dir, git="git"):
    """<sha7>, <sha7>-dirty or unknown.

    Dirty means any change git can see: tracked edits and untracked files that
    are not ignored (a new source file is built in too). unknown when git is
    missing or project_dir is not the top of its own checkout (a copied tree
    inside some other repo would otherwise take that repo's commit)."""
    try:
        top = _git(project_dir, "rev-parse", "--show-toplevel", git=git)
        if os.path.realpath(top) != os.path.realpath(project_dir):
            return "unknown"
        rev = _git(project_dir, "rev-parse", "--short=7", "HEAD", git=git)
        if _git(project_dir, "status", "--porcelain", git=git):
            rev += "-dirty"
        return rev
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def asset_hash(project_dir):
    """12 hex digits of SHA-256 over the compiled web assets (src/webh/*,
    names and contents, sorted): the ETag changes when they do, and two
    builds of one commit give the same image (it used __DATE__ __TIME__)."""
    import hashlib
    h = hashlib.sha256()
    webh = os.path.join(project_dir, "src", "webh")
    for name in sorted(os.listdir(webh)):
        h.update(name.encode() + b"\0")
        with open(os.path.join(webh, name), "rb") as f:
            h.update(f.read())
        h.update(b"\0")
    return h.hexdigest()[:12]


def firmware_version(project_dir):
    with open(os.path.join(project_dir, "src", "main.cpp")) as f:
        m = re.search(r'#define IRONFRAME_VERSION "([^"]+)"', f.read())
    return m.group(1) if m else None


def release_problem(project_dir, rev, version, git="git"):
    """Why a release image must not be built from this tree, or None."""
    if rev == "unknown":
        return "the commit is unknown (no git, or not the top of an ironframe-rfid checkout)"
    if rev.endswith("-dirty"):
        return "the tree has uncommitted or untracked changes (stamp %s)" % rev
    if not version:
        return "IRONFRAME_VERSION not found in src/main.cpp"
    tag = "ironframe-" + version
    try:
        tagged = _git(project_dir, "rev-parse", "--verify", "-q", tag + "^{commit}", git=git)
        head = _git(project_dir, "rev-parse", "HEAD", git=git)
    except (OSError, subprocess.CalledProcessError):
        return "tag %s does not exist (IRONFRAME_VERSION is %s)" % (tag, version)
    if tagged != head:
        return "HEAD is not tag %s (IRONFRAME_VERSION is %s)" % (tag, version)
    return None
