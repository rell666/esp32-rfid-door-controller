# Status

**Not yet signed off for a door.** Treat this firmware as bench-tested, and finish your own bench test before it controls a real lock.

## Proven on real hardware

- It boots on the [VOANZO ESP32-WROOM-32E 2-relay board](https://www.amazon.co.uk/dp/B0DS6SB1XB) and on an ESP32 DevKit, and the web UI works.
- 1.9.1 was run on the VOANZO board and reported working well (2026-11-05). That report does not list individual checks, so the list below still stands.
- Both relays click on Test.
- Reader 1 reads cards, and both readers were later reported working.
- An exit button on GPIO13 opens the door.
- Updates over Wi-Fi install on the VOANZO board (checked up to 1.7.0). The changes in 1.8.1 and 1.9.0 were checked on a second ESP32 on the bench.

## Not yet proven on real hardware

- The Wi-Fi fallback, a real lock and the door contacts.
- Most of the door behaviour added in 1.1 and 1.2.
- The itemised bench checks for 1.9.1, the current release. It passes the software gates listed in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Reading the history

This repository is a one-commit public copy of a private project, so a few things point at material that is not published:

- Commit ids in `CHANGELOG.md`, in `docs/evidence/RELEASES.md` and in a release's version string, such as `1.9.1 (7fcd00d)`.
- Mentions of a "ledger" entry (`H27`) or a review finding (`review 8 V3`) in comments and the changelog. These are the project's internal test records and code reviews.

The upstream history is at [esprfid/esp-rfid](https://github.com/esprfid/esp-rfid).
