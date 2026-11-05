# Tools

- `webfilesbuilder/`: builds the web UI. The files in `src/websrc/` are minified, combined (one `css/required.css`, one `js/esprfid.js`, one `esprfid.htm` of page templates), gzipped and written as byte arrays to `src/webh/`, which the firmware compiles in. Run it after any change under `src/websrc/`: `cd tools/webfilesbuilder && npm ci && node bin.js`. `node test/check-assets.mjs` fails if `src/webh/` is stale.
- `bootstrap.sh`: installs the pinned toolchain (PlatformIO, Espressif QEMU) outside the repo; `--check` says what is missing.
- `install-hooks.sh` and `hooks/`: the pre-commit hook that refuses a commit unless `test/all.sh` passed on the staged tree.

The UI is tested against the device simulator `test/e2e/device-sim.mjs` (`node test/e2e/run.mjs`); the upstream WebSocket emulator (`tools/wsemulator`) was removed in 2026-10 (it spoke the ESP8266 protocol).
