// A battery-backed real-time clock on I2C (DS3231, or DS1307: both at 0x68,
// the same time registers), so the clock survives a power cut on a site
// with no NTP. Pure helpers: register encoding, the "lost the time" flags,
// UTC epoch conversion. The I2C itself is in clock.esp; tested on the host.
//
// The RTC holds UTC (the time zone is applied by the system, TZ).
#pragma once

#include <cstdint>

namespace core
{

static const int RTC_NONE = 0;
static const int RTC_DS3231 = 1;
static const int RTC_DS1307 = 2;
static const uint8_t RTC_I2C_ADDRESS = 0x68;
static const uint8_t RTC_DEFAULT_SDA = 21;
static const uint8_t RTC_DEFAULT_SCL = 22;
static const uint8_t DS3231_STATUS_REG = 0x0f;
static const uint8_t DS3231_STATUS_OSF = 0x80;   // oscillator stopped: the time is not valid
static const uint8_t DS1307_CLOCK_HALT = 0x80;   // register 0 bit 7: the clock is stopped
static const uint8_t DS3231_CENTURY = 0x80;      // month register bit 7
static const int RTC_YEAR_MIN = 2016;            // as the device's own "time is set" (2016-01-01)
static const int RTC_YEAR_MAX = 2099;

inline int rtcTypeFrom(int type) { return type == RTC_DS3231 || type == RTC_DS1307 ? type : RTC_NONE; }

inline uint8_t bcdToBin(uint8_t v) { return (uint8_t)((v >> 4) * 10 + (v & 0x0f)); }
inline uint8_t binToBcd(uint8_t v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

struct RtcTime
{
	int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
};

// Registers 0x00-0x06 (seconds, minutes, hours, weekday, date, month, year),
// in either chip's layout: 12- or 24-hour mode, the DS3231 century bit.
// The DS1307 clock-halt bit is not part of the seconds.
inline RtcTime rtcDecode(const uint8_t r[7])
{
	RtcTime t;
	t.second = bcdToBin(r[0] & 0x7f);
	t.minute = bcdToBin(r[1] & 0x7f);
	if (r[2] & 0x40) // 12-hour mode: bit 5 is PM
		t.hour = bcdToBin(r[2] & 0x1f) % 12 + ((r[2] & 0x20) ? 12 : 0);
	else
		t.hour = bcdToBin(r[2] & 0x3f);
	t.day = bcdToBin(r[4] & 0x3f);
	t.month = bcdToBin(r[5] & 0x1f);
	t.year = 2000 + bcdToBin(r[6]) + ((r[5] & DS3231_CENTURY) ? 100 : 0);
	return t;
}

// Days since 1970-01-01 of a civil date (proleptic Gregorian).
inline int64_t daysFromCivil(int y, int m, int d)
{
	y -= m <= 2;
	const int64_t era = (y >= 0 ? y : y - 399) / 400;
	const int64_t yoe = y - era * 400;
	const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
	const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
	return era * 146097 + doe - 719468;
}

inline int daysInMonth(int y, int m)
{
	static const int days[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
	bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
	return m == 2 && leap ? 29 : days[m - 1];
}

// A time an RTC that kept running could hold: every field in range and the
// year from 2016 (a chip that lost its battery restarts at 2000-01-01).
inline bool rtcTimeValid(const RtcTime &t)
{
	return t.year >= RTC_YEAR_MIN && t.year <= RTC_YEAR_MAX && t.month >= 1 && t.month <= 12 && t.day >= 1 &&
		   t.day <= daysInMonth(t.year, t.month) && t.hour >= 0 && t.hour <= 23 && t.minute >= 0 && t.minute <= 59 &&
		   t.second >= 0 && t.second <= 59;
}

// The chip says it lost the time: the DS3231's oscillator-stop flag (status
// register 0x0F bit 7), the DS1307's clock-halt bit (register 0 bit 7).
inline bool rtcStopped(int type, const uint8_t r[7], uint8_t ds3231Status)
{
	if (type == RTC_DS3231)
		return (ds3231Status & DS3231_STATUS_OSF) != 0;
	return (r[0] & DS1307_CLOCK_HALT) != 0;
}

inline uint32_t rtcToEpoch(const RtcTime &t)
{
	return (uint32_t)(daysFromCivil(t.year, t.month, t.day) * 86400 + t.hour * 3600 + t.minute * 60 + t.second);
}

inline RtcTime rtcFromEpoch(uint32_t epoch)
{
	RtcTime t;
	int64_t z = epoch / 86400 + 719468;
	int64_t rem = epoch % 86400;
	t.hour = (int)(rem / 3600);
	t.minute = (int)(rem % 3600 / 60);
	t.second = (int)(rem % 60);
	const int64_t era = z / 146097;
	const int64_t doe = z - era * 146097;
	const int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	const int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	const int64_t mp = (5 * doy + 2) / 153;
	t.day = (int)(doy - (153 * mp + 2) / 5 + 1);
	t.month = (int)(mp < 10 ? mp + 3 : mp - 9);
	t.year = (int)(yoe + era * 400 + (t.month <= 2));
	return t;
}

// Registers 0x00-0x06 for t, 24-hour mode, the clock running (DS1307 halt
// bit clear), the century bit for 2100 and later (DS3231). Weekday 1 =
// Sunday, as the chips count it.
inline void rtcEncode(const RtcTime &t, uint8_t out[7])
{
	int64_t days = daysFromCivil(t.year, t.month, t.day);
	out[0] = binToBcd((uint8_t)t.second);
	out[1] = binToBcd((uint8_t)t.minute);
	out[2] = binToBcd((uint8_t)t.hour);
	out[3] = (uint8_t)((days % 7 + 11) % 7 + 1); // 1970-01-01 was a Thursday (5)
	out[4] = binToBcd((uint8_t)t.day);
	out[5] = (uint8_t)(binToBcd((uint8_t)t.month) | (t.year >= 2100 ? DS3231_CENTURY : 0));
	out[6] = binToBcd((uint8_t)(t.year % 100));
}

} // namespace core
