// The settings struct is core::Settings (core/settings.h): parsed from
// config.json and tested on the host. config.esp applies it to the hardware.
#include "core/settings.h"

typedef core::Settings Config;
using core::ReaderConfig;

inline IPAddress toIp(const core::Ip4 &a) { return IPAddress(a.b[0], a.b[1], a.b[2], a.b[3]); }
