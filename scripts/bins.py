Import("env")
import os
import shutil
import subprocess

# After a build, copy the OTA image (web UI "Update" page) to bin/<name>.bin
# and write bin/<name>-full.bin: bootloader + partition table + app merged
# into one image to flash at offset 0x0 on a blank board.
# <name> comes from custom_bin_name in platformio.ini.

NAME = env.GetProjectOption("custom_bin_name")
CHIP = env.BoardConfig().get("build.mcu")  # esp32 / esp32s3


def after_build(source, target, env):
    build_dir = env.subst("$BUILD_DIR")
    app = os.path.join(build_dir, "firmware.bin")
    os.makedirs("bin", exist_ok=True)
    shutil.copy(app, os.path.join("bin", NAME + ".bin"))

    esptool = os.path.join(env.PioPlatform().get_package_dir("tool-esptoolpy"), "esptool.py")
    images = []
    for offset, image in env.get("FLASH_EXTRA_IMAGES", []):
        images += [offset, env.subst(image)]
    images += [env.subst("$ESP32_APP_OFFSET"), app]
    cmd = [env.subst("$PYTHONEXE"), esptool, "--chip", CHIP, "merge_bin",
           "-o", os.path.join("bin", NAME + "-full.bin"),
           "--flash_mode", env.subst("${__get_board_flash_mode(__env__)}"),
           "--flash_size", env.BoardConfig().get("upload.flash_size", "4MB")] + images
    subprocess.check_call(cmd)


env.AddPostAction("buildprog", after_build)
