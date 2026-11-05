// reader types (hardware.readertype). Only Wiegand readers are supported:
// upstream's MFRC522 (0), PN532 (2) and RDM6300 (3, 4, 6) were removed
// (2026-10-16). READER_NONE: reader 1 is off (a stored type that is no
// longer supported); a stored Wiegand + RDM6300 (5) loads as Wiegand.

#define READER_NONE 0
#define READER_WIEGAND 1
#define READER_WIEGAND_RDM6300 5

// access log: the outcome of an attempt (permissions are core::ACC_*)
#define ACCESS_GRANTED 1
#define ACCESS_DENIED 0

// Wiegand frame types (bits)
#define WIEGANDTYPE_KEYPRESS4 4
#define WIEGANDTYPE_KEYPRESS8 8
#define WIEGANDTYPE_PICC24 24
#define WIEGANDTYPE_PICC34 34


// hardware defines

#define MAX_NUM_RELAYS 4
#define MAX_READERS 2 // two Wiegand readers

#define LOCKTYPE_MOMENTARY 0
#define LOCKTYPE_CONTINUOUS 1
