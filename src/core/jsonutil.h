// Reading integers from config JSON that older UIs stored as strings.
// (Upstream's hardware page saved relay 2-4 pins as "16", which ArduinoJson 6
// reads as 0 - the second door's relay ended up on GPIO0.)
#pragma once

#include <ArduinoJson.h>

namespace core
{

inline int jsonInt(JsonVariantConst v, int fallback)
{
	if (v.is<int>())
		return v.as<int>();
	if (v.is<float>())
		return (int)v.as<float>();
	if (v.is<bool>())
		return v.as<bool>() ? 1 : 0;
	const char *s = v.as<const char *>();
	if (s == nullptr || *s == '\0')
		return fallback;
	bool neg = false;
	if (*s == '-')
	{
		neg = true;
		s++;
	}
	if (*s == '\0')
		return fallback;
	long n = 0;
	for (; *s; s++)
	{
		if (*s < '0' || *s > '9')
			return fallback;
		n = n * 10 + (*s - '0');
		if (n > 1000000L)
			return fallback;
	}
	return (int)(neg ? -n : n);
}

} // namespace core
