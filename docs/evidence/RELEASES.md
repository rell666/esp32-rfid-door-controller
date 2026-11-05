# Release evidence

One row per release tag: the commit, the `test/all.sh` run on that commit with
a clean tree (`dirty 0`) if its log survives, and the SHA-256 of the images
of that release (from its SHA256SUMS file; every file was re-hashed on
2026-10-15 and matched it). Images are never kept in git. Gate logs are not
committed, so this table is the record. Commit ids are those of the project's
private history (see docs/STATUS.md).
Backfilled 2026-10-15 (review 5); add a row with each release.

"Gates" is the number of `all.sh` gates that run had (the set grew: iram,
the configured QEMU boot and more were added later). A pass is
`ALL GATES PASSED <commit>` with no `+ uncommitted`.

| Tag | Commit | Clean-tree gate run | Images (SHA-256) |
|---|---|---|---|
| `ironframe-1.0.0` | `853b628` (2026-10-13) | no clean-tree gate log found (images rebuilt from the tag later) | `esp32wroom.bin` `2017370d94bf1a9cba7688d1cdbc51664c9adaacf1223552678a8d01d9ef043a`; `esp32wroom-full.bin` `4e43046df9a3144a4927a2b623add551f43b8ff813fe1e8556ab67a5e463d8d9` |
| `ironframe-1.1.0` | `0e07b9c` (2026-10-14) | ALL GATES PASSED, 8 gates | `esp32wroom.bin` `7ef622aa14a558d1c75d1392c96efbfeb5dd0dac5d6baf89f0df42cfd41eef09`; `esp32wroom-full.bin` `06e5af558d98eee1c77c9307bb5674884fe20257c7efb111520025ee87b5635a`; `esp32wroom-rollbacktest.bin` `c005d360ddd30e9fae4336a1241329792065d784bcce51afa2c2111994b44a98` |
| `ironframe-1.2.0` | `abff35c` (2026-10-14) | ALL GATES PASSED, 9 gates | `esp32wroom.bin` `ae9be9a97f37e74888118367a4bfda8ca5fcd167ce7e92b7cbae2d0a97331aa9`; `esp32wroom-full.bin` `3adaf82fe65db4c538e668ae5f5893dcd5b038fdafa3b411b9c3964c04fe592c`; `esp32wroom-rollbacktest.bin` `b73b03b535dd1f6777527defe8a74085e83df584e28ee3657a9f384c9f8050cc` |
| `ironframe-1.2.1` | `427bc53` (2026-10-14) | ALL GATES PASSED, 9 gates | `esp32wroom.bin` `64732c538ee55afcd9e5ef2d64ec1fa2b0d671355306dbd29ea0d197f06f65ce`; `esp32wroom-full.bin` `4d9b183bcb724b8f06e0a421524ef212d6d8b68a4fabe6f53a8aeca3b7187b14`; `esp32wroom-rollbacktest.bin` `2f4b1088d4dc7c2c4e81da5e9def9748ea05b2cb25fe698dd282ee563ed435b0` |
| `ironframe-1.3.0` | `9d6a4d1` (2026-10-14) | ALL GATES PASSED, 9 gates | `esp32wroom.bin` `0995438131e73df7086fb7b565427b569d1d16b8f316cb3ecd51134b1a5a6fbe`; `esp32wroom-full.bin` `1f1104d615e26f4ccf07c71818c6f9f0148263b07c7cde3081aef470eeef9de8`; `esp32wroom-rollbacktest.bin` `0610e6412a420125bdf8ce1fce67d20dd0b71cc761ae37f3e1389397547e3066` |
| `ironframe-1.3.1` | `b3952dd` (2026-10-14) | ALL GATES PASSED, 9 gates | `ironframe-rfid-1.3.1.bin` `15746769901240c31c56b544675c909035d978bbce8c88a101dbb450cadd3667`; `ironframe-rfid-1.3.1-full-flash.bin` `8016024ef4c700b1e529f31af053ad7f14a9e5a26e4e69b87fc433af21965297`; `esp32wroom-rollbacktest.bin` (not in SHA256SUMS, hashed 2026-10-15) `ce5599a981f23065f1ad7b9b491b2d73e9a9154a73e29f4b7c1779d800786898` |
| `ironframe-1.3.2` | `d90aa86` (2026-10-14) | ALL GATES PASSED, 9 gates | `ironframe-rfid-1.3.2.bin` `d501dc05e060f2f8029f4f840570b34bda5f4798bcfada3c5ddd803b1b52623b`; `ironframe-rfid-1.3.2-full-flash.bin` `1ecaa5ad00b9984cb103b0ac7512ec8f9a56dea17cf95438e1216bb863e669ef`; `esp32wroom-rollbacktest.bin` (not in SHA256SUMS, hashed 2026-10-15) `b1fe8eaa64319627b8dbf5a3c3c7992c1b3f28efe88d57de0634c7d4f166407d` |
| `ironframe-1.4.0` | `830f49d` (2026-10-15) | ALL GATES PASSED, 11 gates | `ironframe-rfid-1.4.0.bin` `40b12ef21f89756bd79f596a4e371f4d4afc606b9480fefd33e3172e63025205`; `ironframe-rfid-1.4.0-full-flash.bin` `f1c8e0a1dc9b959e38869737d0887beac4c677b52d9cca2200f680eb7b3a10b7` |
| `ironframe-1.4.1` | `6f10696` (2026-10-15) | ALL GATES PASSED, 13 gates | `ironframe-rfid-1.4.1.bin` `563583d6a0b77e3707d28a9d7d93783adaf20c9c6be852fc8c519ab8b674ba8e`; `ironframe-rfid-1.4.1-full-flash.bin` `2004558eb07a237cb4ff973f89778f8bf6e1af11364943948a7ff0545454f4f1` |
| `ironframe-1.4.2` | `92b42ce` (2026-10-15) | ALL GATES PASSED, 13 gates | `ironframe-rfid-1.4.2.bin` `3cb32550332235c27bfc156fb2a36362b6f6e5e17ce89cc0d5c61e95e928d85b`; `ironframe-rfid-1.4.2-full-flash.bin` `e31044cd9fc2a142d5eb86f66149a1eb8b744ec760ff5b9daa6d86f9386fe596` |
| `ironframe-1.4.3` | `d541f0e` (2026-10-16) | ALL GATES PASSED, 13 gates | `ironframe-rfid-1.4.3.bin` `992ef4e4ac382d4f9fcbfaa05fad3441f69836442409d9dd82d6de80ee4d8778`; `ironframe-rfid-1.4.3-full-flash.bin` `a507ed4639237da0226bdcf0d6f468be7cfdb35a6bdbfe4690748ef956373b15` |
| `ironframe-1.5.0` | `ede4cc1` (2026-10-16) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.5.0.bin` `762f3f362abcd09b17016b90fce03fba86c59ca570f4e5819cc370224ae28ae3`; `ironframe-rfid-1.5.0-full-flash.bin` `f4edc6c9aee34eae286ada2b438d49901cd362b7b376cf4b8576fee641152163` |
| `ironframe-1.6.0` | `a70c9dd` (2026-10-16) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.6.0.bin` `feebc8d988f252b32ef2eb1182254bc8bc17764a602a0e770373bfcf8fb283f6`; `ironframe-rfid-1.6.0-full-flash.bin` `9880b67b66c6e50ffe53f3eff7c9845d7fdd924fd0dbe7ba912694dd1bbd4a57` |
| `ironframe-1.7.0` | `2e2fa33` (2026-10-16) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.7.0.bin` `d14e708ea738a7033120be0dc3edb14f42cd0604536096d3857076770ced9374`; `ironframe-rfid-1.7.0-full-flash.bin` `f1ba947c0c79b209a3a200a45808ab37a3df63fdd5b972fee897171b64245a4e` |
| `ironframe-1.7.1` | `ddb3645` (2026-10-17) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.7.1.bin` `3a34d252412289810bc26bb4579086539ce9390e723a16d688ead60259512cf0`; `ironframe-rfid-1.7.1-full-flash.bin` `8145859b18d4c41bf36b237c3fa5743ea0b3042a2fe62e0d4dc8135d2adcd84f` |
| `ironframe-1.8.0` | `e19a262` (2026-10-17) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.8.0.bin` `1a4631c753cc215d42b3c80b567b784fe7455c0e3afb03a84f9705c201a90d35`; `ironframe-rfid-1.8.0-full-flash.bin` `3635b2a5bcd208c9046d3da6be5528f1ec77bb334add929fab67d2ea6e48da53` |
| `ironframe-1.8.1` | `d145db7` (2026-10-19) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.8.1.bin` `90ca5d45661fc4a57231a0007590bf7bee2c4d9f93eb11c1659175ea3f2552b1`; `ironframe-rfid-1.8.1-full-flash.bin` `2f460c32c8633ef4da3355d37c26102313ec40b2a3d6b362d9dd08090404caeb` |
| `ironframe-1.9.0` | `7f7c840` (2026-10-19) | ALL GATES PASSED, 14 gates | `ironframe-rfid-1.9.0.bin` `5986e3ddcd479cdf356796c835a8058e8696d151429f1708a106726bcde184bd`; `ironframe-rfid-1.9.0-full-flash.bin` `03eb05f5a51d1465dcb730507384c3da354e6c3c9b5051bde62c826fc020579c` |
| `ironframe-1.9.1` | `7fcd00d` (2026-10-26) | ALL GATES PASSED, 15 gates; images built twice from a fresh clone of the tag and byte-identical (`test/check-release.sh`) | `ironframe-rfid-1.9.1.bin` `19b6a0d45022b302aef618f7aba2f14570a2853a6ec569175e94585e6cb2bc0c`; `ironframe-rfid-1.9.1-full-flash.bin` `d0dde3e2e1c4b871895f5b195d2f1c56e603f508f6b3a6e70c889c6807ff39a6` |

Notes:

- is overwritten by the next run on
  the same commit, so for 1.2.0 and 1.4.0 it now holds a later run with
  uncommitted changes; the clean run is the log named above.
- From 1.3.1 the release files are named by version
  (`ironframe-rfid-<version>.bin` = `bin/esp32wroom.bin`); before that the
  archive keeps the build names.
