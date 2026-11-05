#!/usr/bin/env python3
"""Post-link check: the GPIO interrupt paths (Wiegand, exit buttons) stay in IRAM.

The GPIO ISR service is installed with ESP_INTR_FLAG_IRAM (wiegand.esp), so
the handlers run while the flash cache is off (LittleFS writes). A handler, or
anything it calls, that lands in flash crashes the board ("Cache disabled but
cached memory region accessed") the first time a card is read or an exit
button pressed during a write.
IRAM_ATTR on the source is a request; this reads the linked ELF.

For each shipped build it checks that the ISR entry points (wiegandIsrD0/D1,
exitButtonIsr in door.esp)
and the IDF dispatcher that calls them (gpio_intr_service) lie in IRAM, and
follows every direct call (callN) and every callxN whose target was loaded by
l32r from a literal, transitively: each target must be in IRAM or ROM. A
callx it cannot resolve fails the check, except in the IDF dispatcher
(gpio_intr_service, gpio_isr_loop), whose callx is the jump to the registered
handlers checked here. One flash callee is allowed, for the reason in ALLOWED.

Positive controls, so the check cannot pass by finding nothing: the ISRs must
make at least one resolved call, and setupWiegandPort (flash code by design)
must be reported in flash with at least one call into flash.

  python3 test/check-iram.py [path/to/pio]
"""
import os
import re
import struct
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIO = sys.argv[1] if len(sys.argv) > 1 else "pio"
CORE = os.environ.get("PLATFORMIO_CORE_DIR", os.path.expanduser("~/.platformio"))
# env -> (toolchain prefix, internal ROM address range of that chip)
BUILDS = {
    "esp32wroom": ("toolchain-xtensa-esp32/bin/xtensa-esp32-elf-", (0x40000000, 0x40070000)),
    "esp32s3": ("toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-", (0x40000000, 0x40060000)),
}
ISRS = ["_ZL12wiegandIsrD0Pv", "_ZL12wiegandIsrD1Pv", "_ZL13exitButtonIsrPv"]
DISPATCHERS = ["gpio_intr_service", "gpio_isr_loop"]
# (caller, callee in flash) pairs that are never reached from an interrupt,
# and the condition that keeps it so (checked below)
ALLOWED = {
    # IDF 4.4 spinlocks: only a spinlock in external RAM (PSRAM) takes this
    # path. WiegandPort.mux lives in wiegandPorts and ExitIo.mux in exitIo,
    # which must be in internal RAM.
    ("xPortEnterCriticalTimeout", "compare_and_set_extram"): ["wiegandPorts", "_ZL6exitIo"],
}
STORE_OR_BRANCH = re.compile(r"(s(8|16|32)i(\.n)?|s32c1i|s32e|b\w*|j\w*|call\w*|ret\w*|nop\w*|memw|isync|rsync|esync|dsync|wsr|xsr|wer|waiti)$")
FLASH_CONTROL = "_Z16setupWiegandPortihh"

failures = 0


def check(cond, label, detail=""):
    global failures
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else " " + detail))
    if not cond:
        failures += 1


def sections(elf):
    """name -> (addr, size, file offset, flags) from the ELF32 section headers."""
    with open(elf, "rb") as f:
        data = f.read()
    assert data[:4] == b"\x7fELF" and data[4] == 1, "not an ELF32 file"
    shoff, = struct.unpack_from("<I", data, 0x20)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x2E)
    hdrs = [struct.unpack_from("<IIIIIIIIII", data, shoff + i * shentsize) for i in range(shnum)]
    strtab = hdrs[shstrndx]
    out = {}
    for h in hdrs:
        raw = data[strtab[4] + h[0]:]
        name = raw[:raw.index(b"\0")].decode()
        out[name] = (h[3], h[5], h[4], h[2])
    return out, data


def main():
    for env, (prefix, rom) in BUILDS.items():
        print(f"{env}:")
        build = subprocess.run([PIO, "run", "-e", env], cwd=REPO, capture_output=True, text=True)
        if build.returncode != 0:
            check(False, f"{env} builds", build.stdout[-2000:] + build.stderr[-2000:])
            continue
        elf = os.path.join(REPO, ".pio", "build", env, "firmware.elf")
        nm = os.path.join(CORE, "packages", prefix + "nm")
        objdump = os.path.join(CORE, "packages", prefix + "objdump")
        secs, data = sections(elf)
        # executable IRAM: .iram0.vectors and .iram0.text (SHF_EXECINSTR = 4)
        iram = [(a, a + s) for n, (a, s, _, fl) in secs.items() if n.startswith(".iram0.") and fl & 4 and s > 0]
        check(len(iram) >= 2, "IRAM text sections found", str(secs.keys()))

        def in_iram(a):
            return any(lo <= a < hi for lo, hi in iram)

        def in_rom(a):
            return rom[0] <= a < rom[1]

        def word_at(addr):
            for a, s, off, _ in secs.values():
                if a <= addr < a + s and off:
                    return struct.unpack_from("<I", data, off + addr - a)[0]
            return None

        syms = {}
        by_addr = {}
        for line in subprocess.run([nm, "-S", elf], capture_output=True, text=True, check=True).stdout.splitlines():
            p = line.split()
            if len(p) == 4 and p[2].lower() == "t":
                addr, size = int(p[0], 16), int(p[1], 16)
                syms[p[3]] = (addr, size)
                by_addr.setdefault(addr, (p[3], size))

        def calls(name):
            """[(target or None, instruction)] for the calls in a function."""
            addr, size = syms[name]
            out = subprocess.run([objdump, "-d", f"--start-address={addr:#x}", f"--stop-address={addr + size:#x}", elf],
                                 capture_output=True, text=True, check=True).stdout
            loaded = {}
            found = []
            for line in out.splitlines():
                m = re.match(r"\s*[0-9a-f]+:\s+[0-9a-f]+\s+(\S+)\s*(.*)", line)
                if not m:
                    continue
                op, args = m.group(1), m.group(2)
                if op == "l32r":
                    r = re.match(r"(a\d+), ([0-9a-f]+)", args)
                    if r:
                        loaded[r.group(1)] = word_at(int(r.group(2), 16))
                        continue
                if not STORE_OR_BRANCH.match(op):
                    # any other instruction writes its first operand: forget what l32r put there
                    loaded.pop(args.split(",")[0].strip(), None)
                elif re.fullmatch(r"call(0|4|8|12)", op):
                    found.append((int(args.split()[0], 16), line.strip()))
                elif re.fullmatch(r"callx(0|4|8|12)", op):
                    found.append((loaded.get(args.strip()), line.strip()))
            return found

        for name in ISRS + DISPATCHERS:
            check(name in syms, f"{name} found in the ELF")
        if not all(n in syms for n in ISRS + DISPATCHERS):
            continue
        objects = {}
        for line in subprocess.run([nm, elf], capture_output=True, text=True, check=True).stdout.splitlines():
            p = line.split()
            if len(p) == 3:
                objects[p[2]] = int(p[0], 16)
        dram = [(a, a + s) for n, (a, s, _, _) in secs.items() if n.startswith(".dram0.") and s > 0]
        for (_, _), objs in ALLOWED.items():
            for obj in objs:
                check(obj in objects and any(lo <= objects[obj] < hi for lo, hi in dram), f"{obj} is in internal RAM (.dram0)")

        # walk the call graph from the interrupt path
        seen, todo, resolved = set(), list(ISRS + DISPATCHERS), 0
        isr_calls = 0
        while todo:
            name = todo.pop()
            if name in seen:
                continue
            seen.add(name)
            addr, _ = syms[name]
            if not in_iram(addr):
                check(False, f"{name} at {addr:#x} is in IRAM")
                continue
            for target, insn in calls(name):
                if target is None:
                    if name not in DISPATCHERS:
                        check(False, f"{name}: indirect call with an unknown target", insn)
                    continue
                resolved += 1
                if name in ISRS:
                    isr_calls += 1
                if in_rom(target):
                    continue
                if not in_iram(target):
                    callee = by_addr.get(target, ("?", 0))[0]
                    if (name, callee) in ALLOWED:
                        continue
                    check(False, f"{name} calls {callee} at {target:#x}, outside IRAM and ROM", insn)
                    continue
                if target in by_addr:
                    todo.append(by_addr[target][0])
        check(True, f"interrupt path in IRAM: {len(seen)} functions, {resolved} calls followed")
        check(isr_calls > 0, "control: the ISRs make calls the check can resolve")

        # control: a function known to be in flash is reported as such
        fa, _ = syms.get(FLASH_CONTROL, (0, 0))
        check(FLASH_CONTROL in syms and not in_iram(fa), f"control: {FLASH_CONTROL} reported in flash")
        if FLASH_CONTROL in syms:
            flash_calls = [t for t, _ in calls(FLASH_CONTROL) if t is not None and not in_iram(t) and not in_rom(t)]
            check(len(flash_calls) > 0, f"control: {FLASH_CONTROL} calls into flash are detected")

    if failures:
        print(f"IRAM CHECK FAILED ({failures})")
        return 1
    print("IRAM CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
