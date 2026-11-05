// Builds every shipped firmware (original ESP32 and ESP32-S3), and fails on
// any compiler warning in the project's own sources, a failed build, or an app
// image that leaves less than 5% of its OTA slot free. The slot size is read
// from the partition table the build actually produced (partitions.bin).
//
//   node test/check-builds.mjs [path/to/pio]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pio = process.argv[2] || "pio";
const ENVS = ["esp32wroom", "esp32s3"];
let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${cond ? "" : " " + detail}`);
  if (!cond) failures++;
};

// ESP-IDF partition table: 32-byte entries, magic 0xAA50.
function partitions(partitionsBin) {
  const b = fs.readFileSync(partitionsBin);
  const out = [];
  for (let off = 0; off + 32 <= b.length; off += 32) {
    if (b.readUInt16LE(off) !== 0x50aa) break;
    out.push({ type: b[off + 2], subtype: b[off + 3], offset: b.readUInt32LE(off + 4), size: b.readUInt32LE(off + 8),
      name: b.toString("latin1", off + 12, off + 28).replace(/\0.*$/, "") });
  }
  return out;
}
function otaSlotSize(partitionsBin) {
  const p = partitions(partitionsBin).find((e) => e.type === 0 && (e.subtype === 0x10 || e.subtype === 0x00)); // ota_0 or factory
  return p ? p.size : 0;
}

// The VOANZO layout (partitions-esp32wroom.csv), as flashed to the board.
const WROOM_LAYOUT = [
  { name: "nvs", offset: 0x9000, size: 0x5000 },
  { name: "otadata", offset: 0xe000, size: 0x2000 },
  { name: "app0", offset: 0x10000, size: 0x180000 },
  { name: "app1", offset: 0x190000, size: 0x180000 },
  { name: "spiffs", offset: 0x310000, size: 0xe0000 },
  { name: "coredump", offset: 0x3f0000, size: 0x10000 },
];

for (const env of ENVS) {
  fs.rmSync(path.join(repo, ".pio", "build", env, "src"), { recursive: true, force: true });
  const r = spawnSync(pio, ["run", "-e", env], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  const warnings = out.split("\n").filter((l) => /^src\/.*warning/.test(l));
  check(r.status === 0 && /\[SUCCESS\]/.test(out), `${env}: builds`, out.split("\n").filter((l) => /error/.test(l)).slice(0, 5).join(" | "));
  check(warnings.length === 0, `${env}: no warnings in project sources (-Wall -Wextra)`, warnings.slice(0, 5).join(" | "));
  const app = path.join(repo, ".pio", "build", env, "firmware.bin");
  const parts = path.join(repo, ".pio", "build", env, "partitions.bin");
  if (fs.existsSync(app) && fs.existsSync(parts)) {
    const size = fs.statSync(app).size, slot = otaSlotSize(parts);
    const pct = (100 * size / slot).toFixed(1);
    console.log(`        ${env}: app ${size} bytes in a ${slot}-byte slot (${pct}%)`);
    check(slot > 0 && size <= slot * 0.95, `${env}: app leaves >= 5% of its OTA slot free`, `${pct}%`);
  } else {
    check(false, `${env}: firmware.bin and partitions.bin exist`);
  }
  if (env === "esp32wroom" && fs.existsSync(parts)) {
    const got = partitions(parts).map(({ name, offset, size }) => ({ name, offset, size }));
    check(JSON.stringify(got) === JSON.stringify(WROOM_LAYOUT), "esp32wroom: partition table is the 1.5 MB / 1.5 MB / ~900 KB layout",
      JSON.stringify(got));
    const full = path.join(repo, "bin", "esp32wroom-full.bin");
    if (fs.existsSync(full)) {
      const table = fs.readFileSync(parts);
      const atOffset = fs.readFileSync(full).subarray(0x8000, 0x8000 + table.length);
      check(atOffset.equals(table), "esp32wroom-full.bin carries this partition table at 0x8000");
      const ota = fs.readFileSync(full).subarray(0xe000, 0xe020);
      check(ota.readUInt32LE(0) === 1 && ota.readUInt32LE(0x18) === 0xffffffff, "esp32wroom-full.bin otadata boots app0 in the UNDEFINED state (no rollback on first boot)");
    }
  }
  for (const f of [`bin/${env}.bin`, `bin/${env}-full.bin`]) {
    check(fs.existsSync(path.join(repo, f)) && fs.statSync(path.join(repo, f)).mtimeMs > Date.now() - 15 * 60 * 1000, `${f} written by this build`);
  }
}

if (failures === 0) {
  console.log("BUILDS CHECK PASSED");
  process.exit(0);
}
process.exit(1);
