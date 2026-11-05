Import("env")
import os
import sys

# Stamp the firmware with the commit it was built from, so the running board
# reports its exact source (Status page, MQTT "sw", serial banner). A build
# with any change git can see (untracked files too) is marked -dirty, one
# without a usable git checkout "unknown": never ship either.
# IRONFRAME_RELEASE=1 (release images) refuses both, and a HEAD that is not
# tag ironframe-<IRONFRAME_VERSION>; the logic is in revstamp.py.

project = env.subst("$PROJECT_DIR")
sys.dont_write_bytecode = True  # a scripts/__pycache__ would itself make the tree dirty
sys.path.insert(0, os.path.join(project, "scripts"))
import revstamp  # noqa: E402

rev = revstamp.rev_stamp(project)
if os.environ.get("IRONFRAME_RELEASE") == "1":
    problem = revstamp.release_problem(project, rev, revstamp.firmware_version(project))
    if problem:
        sys.stderr.write("IRONFRAME_RELEASE: refusing to build a release image: %s\n" % problem)
        env.Exit(1)
    print("IRONFRAME_RELEASE: building release image %s (%s)" % (revstamp.firmware_version(project), rev))

env.Append(CPPDEFINES=[("IRONFRAME_REV", env.StringifyMacro(rev))])
# the web assets' ETag: their hash, not the build time (plan 1.9.1 E3)
env.Append(CPPDEFINES=[("ASSET_HASH", env.StringifyMacro(revstamp.asset_hash(project)))])
