/*
MIT License

Copyright (c) 2018 esp-rfid Community
Copyright (c) 2017 Ömer Şiar Baysal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */
// Ironframe's own release number (based on esp-rfid 2.0.0, MIT licence).
// IRONFRAME_REV is the git commit, added by scripts/version.py at build time.
#define IRONFRAME_VERSION "1.9.1"
#ifndef IRONFRAME_REV
#define IRONFRAME_REV "unknown"
#endif
#ifdef IRONFRAME_ROLLBACK_TEST
#define VERSION IRONFRAME_VERSION " (" IRONFRAME_REV ") rollback-test"
#else
#define VERSION IRONFRAME_VERSION " (" IRONFRAME_REV ")"
#endif

#include "Arduino.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <FS.h>
#include <LittleFS.h>
#include <Update.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WebAuthentication.h>
#include <Ticker.h>
#include <time.h>
#include <mutex>
#include <atomic>
#include <deque>
#include <espMqttClientAsync.h>
#include <Bounce2.h>
#include <esp_random.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <driver/gpio.h>
#include <hal/gpio_ll.h>
#include <esp_mac.h>
#include <esp_partition.h>
#include <esp_ota_ops.h>
#include <esp_task_wdt.h>
#include <esp_core_dump.h>
#include <esp_sntp.h>
#include <Preferences.h>
#include "magicnumbers.h"
#include "config.h"
#include "core/validate.h"
#include "core/adminpass.h"
#include "core/assembler.h"
#include "core/mqttqueue.h"
#include "core/auth.h"
#include "core/secrets.h"
#include "core/firmware.h"
#include "core/wifi.h"
#include "core/wifiidle.h"
#include "core/logfile.h"
#include "core/wiegand.h"
#include "core/relaytimer.h"
#include "core/access.h"
#include "core/feedback.h"
#include "core/pins.h"
#include "core/jsonutil.h"
#include "core/lockout.h"
#include "core/reader.h"
#include "core/door.h"
#include "core/exitbutton.h"
#include "core/userfiles.h"
#include "core/jsonrecover.h"
#include "core/userrecord.h"
#include "core/relays.h"
#include "core/configpolicy.h"
#include "core/livesettings.h"
#include "core/memguard.h"
#include "core/restart.h"
#include "core/wscommand.h"
#include "core/wsalive.h"
#include "core/storagespace.h"
#include "core/userindex.h"

Config config;

// GPIO whitelist for the chip this firmware is built for (core/pins.h)
core::PinSet boardPins()
{
#if CONFIG_IDF_TARGET_ESP32S3
	return core::pinSetEsp32s3();
#else
	return core::pinSetEsp32();
#endif
}

// relay specific variables
bool activateRelay[MAX_NUM_RELAYS] = {false, false, false, false};
core::RelayTimer relayTimers[MAX_NUM_RELAYS];

// Momentary relays are relocked by an esp_timer, not by loop(): a loop()
// held up by a Wi-Fi connect or a flash format must not hold a door open.
// loop() keeps the bookkeeping (RelayTimer, MQTT lock state) and also relocks
// if a timer could not be created. The deadline, set under the spinlock,
// stops a late callback from relocking a relay that was opened again.
static esp_timer_handle_t relayRelockTimer[MAX_NUM_RELAYS] = {};
static core::RelockDeadline relayRelock[MAX_NUM_RELAYS];
static portMUX_TYPE relayMux = portMUX_INITIALIZER_UNLOCKED;

static void relayRelockCallback(void *arg)
{
	int i = (int)(intptr_t)arg;
	portENTER_CRITICAL(&relayMux);
	if (relayRelock[i].due(esp_timer_get_time()))
	{
		if (config.relayPin[i] != 255)
			gpio_set_level((gpio_num_t)config.relayPin[i], config.relayUnlock[i] ? 0 : 1);
	}
	portEXIT_CRITICAL(&relayMux);
}

// Energise relay i and relock it after ms milliseconds.
void relayPulse(int i, unsigned long ms)
{
	if (relayRelockTimer[i] == nullptr)
	{
		esp_timer_create_args_t args = {};
		args.callback = relayRelockCallback;
		args.arg = (void *)(intptr_t)i;
		args.dispatch_method = ESP_TIMER_TASK;
		args.name = "relock";
		if (esp_timer_create(&args, &relayRelockTimer[i]) != ESP_OK)
			relayRelockTimer[i] = nullptr;
	}
	if (relayRelockTimer[i] != nullptr)
		esp_timer_stop(relayRelockTimer[i]); // ESP_ERR_INVALID_STATE when idle: fine
	portENTER_CRITICAL(&relayMux);
	relayRelock[i].arm(esp_timer_get_time(), ms);
	gpio_set_level((gpio_num_t)config.relayPin[i], config.relayUnlock[i] ? 1 : 0);
	portEXIT_CRITICAL(&relayMux);
	if (relayRelockTimer[i] != nullptr)
		esp_timer_start_once(relayRelockTimer[i], (uint64_t)ms * 1000);
}

// Forget a pending relock (the relay is being locked now by the caller).
void relayCancelPulse(int i)
{
	if (relayRelockTimer[i] != nullptr)
		esp_timer_stop(relayRelockTimer[i]);
	portENTER_CRITICAL(&relayMux);
	relayRelock[i].cancel();
	portEXIT_CRITICAL(&relayMux);
}

// the web UI, built from src/websrc (tools/webfilesbuilder)
#include "webh/required.css.gz.h"
#include "webh/esprfid.js.gz.h"
#include "webh/esprfid.htm.gz.h"
#include "webh/index.html.gz.h"
#include "webh/ironframe-logo.svg.gz.h"

// MQTT: espMqttClient (bertmelis, maintained; AsyncMqttClient 0.9.0 had no
// release since July 2021 and was not safe to publish from two tasks), the
// AsyncTCP variant, as the web server. Every publish goes through mqttSend()
// (mqtt.esp).
espMqttClientAsync mqttClient;
Ticker wifiReconnectTimer;

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// Authentication state (see core/auth.h)
core::LoginLimiter loginLimiter;
core::SessionStore sessions;
std::mutex authMutex; // touched from the async_tcp task and loop()

#define LEDoff HIGH
#define LEDon LOW

#define BEEPERoff HIGH
#define BEEPERon LOW

// Milliseconds since boot, 64-bit. Arduino's millis() is 32-bit: it wraps
// after 49.7 days, and deadlines kept on it went wrong after 24.8 (the readers
// stopped deciding). Every timer in this firmware uses this instead.
static inline uint64_t uptimeMs() { return (uint64_t)(esp_timer_get_time() / 1000); }

// Variables for whole scope
uint64_t currentMillis = 0; // uptimeMs() at the start of this loop() pass
std::atomic<bool> doEnableWifi{false};
bool configDamaged = false;
bool deviceConfigured = false; // settings loaded at start-up (Status: the setup card when not)
bool storageMounted = false; // LittleFS mounted in setup(); BOOT-hold recovery then keeps the users
volatile bool formatreq = false;
unsigned long nextbeat = 0;
// Every software restart goes through requestRestart() (core/restart.h): it
// waits for nothing to be in progress, at most core::RestartGate::GRACE_MS.
// Any task may ask; loop() acts. The first reason asked is kept.
static std::atomic<const char *> restartAsked{nullptr};
static std::atomic<bool> factoryResetAsked{false};
void requestRestart(const char *reason)
{
	const char *none = nullptr;
	restartAsked.compare_exchange_strong(none, reason);
}
// The web page's factory reset: through the same gate, then formatreq.
void requestFactoryReset()
{
	factoryResetAsked = true;
	requestRestart("factory reset");
}
bool restartRequested() { return restartAsked.load() != nullptr; }
unsigned long uptimeSeconds = 0;
uint64_t wifiPinBlink = 0;
// Set from WiFi/MQTT event callbacks (other FreeRTOS tasks), acted on in loop()
std::atomic<bool> mqttConnectRequested{false};
std::atomic<bool> mqttDisconnectRequested{false};
std::atomic<uint32_t> mqttRetryAtS{0}; // uptime second of the next MQTT connect attempt; 0 = none
std::atomic<bool> mdnsStartRequested{false};
volatile bool wifiScanRequested = false;
// The access point this board is running has no password (Status warns).
// The fallback and setup hotspots always have a password; a configured
// one is open when its password is empty. Set in wifi.esp.
bool apOpen = false;
// The fallback access point (IRONFRAME-RFID-xxxxxx) is up. Kept apart from
// config.accessPointMode, the configured mode: when fallback set that flag,
// an admin card's enableWifi() restarted the AP with the home network's
// SSID and password.
bool fallbackApUp = false;
// A board with no settings runs the setup hotspot (core::SETUP_HOTSPOT_PASSWORD)
// and closes it when nobody has used it for 15 minutes. Set in wifi.esp.
bool setupHotspot = false;
// Low memory: card lookups report here (rfid.esp); memoryGuardLoop() restarts
// the board when it is idle (core/memguard.h).
core::MemGuard memGuard;

bool firmwareUpdateRunning(); // webserver.esp
bool liveSettingsPending();   // config.esp
bool relayLockedNow(int i);   // below, beside relayBank()

// storage.esp: declared here for its default argument (the definition has none)
bool readJsonFileRecover(const char *path, JsonDocument &doc, bool *noMemory = nullptr);

#include "clock.esp"
#include "led.esp"
#include "beeper.esp"
#include "log.esp"
#include "storage.esp" // userIndex, userIndexLoop()
#include "system.esp"
#include "mqtt.esp"
#include "wsResponses.esp"
#include "wiegand.esp"
#include "rfid.esp"
#include "wifi.esp"
#include "config.esp"
#include "websocket.esp"
#include "webserver.esp"
#include "door.esp"
#include "doorbell.esp"

// core::relayLoop on the real pins (core/relays.h)
struct FirmwareRelayIo
{
	int read(int pin) { return digitalRead(pin); }
	void write(int pin, int level) { digitalWrite(pin, level); }
	void pulse(int relay, unsigned long ms) { relayPulse(relay, ms); }
	void report(int relay, bool unlocked)
	{
		mqttPublishIo("lock" + String(relay), unlocked ? "UNLOCKED" : "LOCKED");
#ifdef DEBUG
		Serial.printf("relay %d %s\n", relay, unlocked ? "energised" : "released");
#endif
	}
};

core::RelayBankView relayBank()
{
	return core::relayBankOf(config);
}

// Relay i has a pin and is locked now (core::relayLockedAt). Used by
// mqtt.esp and door.esp; it was a static in mqtt.esp (review 8 R1-2).
bool relayLockedNow(int i)
{
	core::RelayBankView b = relayBank();
	return core::relayHasPin(b, i) && core::relayLockedAt(b, i, digitalRead(b.pin[i]));
}

void setup()
{
	// Before anything else: until the configuration is read the relay pins
	// would float (see core::packRelayBoot).
	lockRelaysAtBoot();
	setupExitButtonsAtBoot(); // door.esp: works whatever happens to config.json
	// Loop watchdog: a loop() stuck for LOOP_WDT_SECONDS restarts the board
	// (and, for a new image not yet confirmed, rolls back the update).
	esp_task_wdt_init(LOOP_WDT_SECONDS, true);
	enableLoopWDT();
#ifdef DEBUG
	Serial.begin(115200);
	delay(500);
	Serial.println();
	Serial.print(F("[ INFO ] Ironframe RFID (esp-rfid) v"));
	Serial.println(VERSION);
	Serial.printf("[ INFO ] Chip %s rev %d, %u MHz, flash %u bytes, PSRAM %u bytes\n",
				  ESP.getChipModel(), ESP.getChipRevision(), ESP.getCpuFreqMHz(),
				  ESP.getFlashChipSize(), ESP.getPsramSize());
	logBootRelays();
	logBootExitButtons();
#endif

	logResetReason();
	logRecovery();
	if (uint8_t pending = factoryResetPending())
	{
		// interrupted by a power cut: finish it, as the kind it was
		factoryReset(pending == 2 ? core::ResetKind::Factory : core::ResetKind::Recovery);
		writeEvent("WARN", "sys", "Factory reset finished after a restart", "");
	}
	bool fsReady = LittleFS.begin(false);
	if (!fsReady)
	{
		if (commissionedState() || !filesystemLooksBlank())
		{
			configDamaged = true; // fail secure: never erase non-blank or commissioned storage
#ifdef DEBUG
			Serial.println(F("[ ERRO ] Filesystem unavailable with non-blank or commissioned storage"));
#endif
		}
		else
		{
			disableLoopWDT(); // erasing the partition takes longer than the watchdog
			bool formatted = LittleFS.format();
			enableLoopWDT();
			if (formatted && LittleFS.begin(false))
			{
				fsReady = true; // blank factory device only
				writeEvent("WARN", "sys", "Filesystem formatted", "factory blank device");
			}
		}
	}
	storageMounted = fsReady;
	if (fsReady && !LittleFS.exists("/P"))
	{
		LittleFS.mkdir("/P");
	}
	if (fsReady)
		sweepUserFiles();

	bool configured = false;
	configured = fsReady && loadConfiguration();
	deviceConfigured = configured;
	if (!configured && !configDamaged)
	{
		char pending[core::HA1_HEX + 1];
		if (pendingAdminHa1(pending))
		{
			strcpy(config.adminHa1, pending);
			config.adminMustChange = false;
		}
	}
	restorePinLockout();
	if (configured)
		setupRtc(); // clock.esp: read once, before the time-not-set warning below
	setupMqtt();
	// WiFi first: on ESP32 it brings up the TCP/IP stack, and starting the
	// async web server before that asserts in lwIP (upstream's ESP8266 order
	// boot-loops an ESP32).
#ifdef QEMU_NO_WIFI
	// Espressif's QEMU has no WiFi radio: bring up only the TCP/IP stack so the
	// rest of setup() and loop() can be exercised (test/qemu/boot-test.sh).
	// Damaged storage takes the real path: it starts no radio, and it is the
	// one that left the board restarting forever (ledger H27.3), which the
	// emulator never reached while it skipped setupWifi().
	if (configDamaged)
		setupWifi(configured);
	else
		esp_netif_init();
#else
	setupWifi(configured);
#endif
	setupWebServer();
	writeEvent("INFO", "sys", "System setup completed, running", "");
	if (!deviceClock.trusted)
		writeEvent("WARN", "sys", "Time not set", "dated and opening-hours users are refused until an admin logs in from a browser or NTP answers");
}

// Once an hour, record free memory, the largest block that can still be
// allocated (falls when memory fragments) and the lowest free memory since
// boot, so a slow leak shows in the Event Log over weeks of uptime.
#define MEMORY_LOG_EVERY_MS (60ULL * 60 * 1000)

void logMemory()
{
	static uint64_t lastLogged = 0;
	if (currentMillis - lastLogged < MEMORY_LOG_EVERY_MS)
		return;
	lastLogged = currentMillis;
	char data[96];
	snprintf(data, sizeof(data), "free %u, largest block %u, lowest free %u bytes, up %lu h",
			 (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap(),
			 (unsigned)ESP.getMinFreeHeap(), uptimeSeconds / 3600);
	writeEvent("INFO", "sys", "Memory", data);
}

// What a restart would cut short now (nullptr: nothing): a reader part-way
// through a card or PIN, a door open (a pulse, a request, or held at its
// unlock level), a firmware upload, a settings apply waiting, a factory
// reset under way. For the log ("Restart waiting: ...").
static const char *restartBlocker()
{
	static char why[64];
	for (int i = 0; i < MAX_READERS; i++)
		if (!rfidReaders[i].session.idle())
		{
			snprintf(why, sizeof(why), "reader %d is part-way through a card or PIN", i + 1);
			return why;
		}
	core::RelayBankView bank = relayBank();
	for (int i = 0; i < bank.count; i++)
	{
		if (!core::relayHasPin(bank, i))
			continue;
		if (activateRelay[i] || relayTimers[i].running() || !core::relayLockedAt(bank, i, digitalRead(bank.pin[i])))
		{
			snprintf(why, sizeof(why), "door %d is unlocked", i + 1);
			return why;
		}
	}
	if (firmwareUpdateRunning())
		return "a firmware update is running";
	if (liveSettingsPending())
		return "settings are being applied";
	if (formatreq)
		return "a factory reset is under way";
	return nullptr;
}

static bool idleForRestart() { return restartBlocker() == nullptr; }

// Once a minute, sample the largest free block; restart when core::MemGuard
// asks for it and the board is idle. The reason goes to the event log first
// (rebootNow() flushes it), so the Event Log shows why it restarted.
void memoryGuardLoop()
{
	static uint64_t nextSample = 0;
	static bool asked = false;
	if (currentMillis >= nextSample)
	{
		nextSample = currentMillis + 60000;
		memGuard.sample(ESP.getMaxAllocHeap());
	}
	if (asked)
		return;
	// the door pins are read only while a restart is wanted
	const char *busy = memGuard.wanted(currentMillis) != nullptr ? restartBlocker() : nullptr;
	static bool waitLogged = false;
	const char *why = memGuard.restartReason(currentMillis, memGuard.wanted(currentMillis) != nullptr && busy == nullptr);
	if (why == nullptr)
	{
		if (busy != nullptr && !waitLogged)
		{
			waitLogged = true; // once: which door held it off
			writeEvent("WARN", "sys", String("Low-memory restart waiting: ") + busy, "restarts anyway after an hour");
		}
		if (memGuard.wanted(currentMillis) == nullptr)
			waitLogged = false;
		return;
	}
	asked = true;
	writeEvent("WARN", "sys", String("Restarting: low memory (largest block ") + (unsigned)ESP.getMaxAllocHeap() + " bytes)",
			   busy ? String(why) + "; waited an hour, still busy: " + busy : String(why));
	requestRestart("low memory");
}

void rebootNow();

// The one place a software restart happens (requestRestart above): once
// idle, or GRACE_MS after it was asked, logging once what it waits for.
static void restartLoop()
{
	static core::RestartGate gate;
	static bool waitLogged = false;
	const char *reason = restartAsked.load();
	if (reason == nullptr)
		return;
	gate.ask(currentMillis);
	const char *busy = restartBlocker();
	if (!gate.due(currentMillis, busy == nullptr))
	{
		if (!waitLogged)
		{
			waitLogged = true;
			writeEvent("INFO", "sys", String("Restart waiting: ") + busy, reason);
		}
		return;
	}
	unsigned waited = (unsigned)(currentMillis - gate.askedAt());
	if (factoryResetAsked.load())
	{
		writeEvent("WARN", "sys", String("Factory reset now (") + reason + ")", busy ? String("forced after ") + waited + " ms: " + busy : String("idle after ") + waited + " ms");
		formatreq = true; // acted on at the top of the next pass
		restartAsked = nullptr;
		return;
	}
	writeEvent("INFO", "sys", String("System is going to reboot (") + reason + ")", busy ? String("forced after ") + waited + " ms: " + busy : String("idle after ") + waited + " ms");
	rebootNow();
}

void rebootNow()
{
	flushLogQueue(true);
	ws.closeAll();
	delay(200);
	LittleFS.end();
	ESP.restart();
}

void loop()
{
	currentMillis = uptimeMs();
	uptimeSeconds = (unsigned long)(currentMillis / 1000);

	clockLoop();
	recoveryButtonLoop();

	exitButtonLoop();
	ledWifiStatus();
	ledAccessDeniedOff();
	beeperBeep();
	doorStatus();
	doorbellStatus();

	liveSettingsLoop(); // config.esp: a save applied without a restart, between reader passes
	rfidLoop(); // each reader keeps its own cool-down
	userIndexLoop(); // storage.esp: the RAM user list, one file a pass until built

	FirmwareRelayIo relayIo;
	core::relayLoop(relayIo, relayBank(), activateRelay, relayTimers, uptimeMs());
	if (formatreq)
	{
#ifdef DEBUG
		Serial.println(F("[ WARN ] Factory reset initiated..."));
#endif
		ws.enable(false);
		ws.closeAll();
		delay(200);
		LittleFS.end();
		factoryReset(core::ResetKind::Factory); // the web page's: the boot copies go too
		ESP.restart();
	}

	// idleForRestart() only once due: it reads the door pins
	if (!restartRequested() && config.autoRestartIntervalSeconds > 0 && uptimeSeconds > config.autoRestartIntervalSeconds &&
		core::autoRestartNow(uptimeSeconds, config.autoRestartIntervalSeconds, idleForRestart()))
	{
		writeEvent("WARN", "sys", "Auto restarting...", "");
		requestRestart("scheduled restart");
	}

	restartLoop();

	// Wi-Fi idle-off (Network page, opt-in): off once nobody has been
	// connected for the set minutes, in every mode (router, hotspot, fallback
	// hotspot); an admin card or a power cycle turns it back on. The setup
	// hotspot of a board with no settings always closes after 15 minutes
	// (core/wifiidle.h).
	static core::IdleOff wifiIdle;
	core::IdleRule idle = core::idleRule(setupHotspot, config.wifiIdleOff, config.wifiIdleMinutes);
	if (wifiIdle.tick(currentMillis, idle.enabled && WiFi.getMode() != WIFI_OFF, idle.minutes, wifiAnyoneConnected()))
	{
		if (setupHotspot)
			writeEvent("INFO", "wifi", String("Setup hotspot closed: nobody connected for ") + idle.minutes + " min", "a power cycle opens it again");
		else
			writeEvent("INFO", "wifi", String("WiFi off: nobody connected for ") + idle.minutes + " min", "an admin card or a power cycle turns it back on");
		disableWifi();
	}

	// don't try connecting to WiFi when waiting for pincode
	// (upstream also required activateRelay[0], which the relay loop above has
	// always cleared by now, so this never ran)
	if (doEnableWifi.load() && !anyReaderWaitingForPin())
	{
		doEnableWifi.store(false);
		if (core::shouldEnableWifi(WiFi.getMode() == WIFI_OFF, config.accessPointMode, WiFi.isConnected()))
		{
			enableWifi();
			writeEvent("INFO", "wifi", "Enabling WiFi", "");
		}
	}
	staConnectLoop();
	staLinkLoop();
	wifiFallbackLoop();
	if (mdnsStartRequested.exchange(false))
		startMdns();

	confirmFirmwareLoop();
	mqttLoop();
	if (config.mqttEnabled && mqttClient.connected())
	{
		if ((unsigned)deviceClock.epoch > nextbeat)
		{
			mqttPublishHeartbeat(deviceClock.epoch, uptimeSeconds);
			nextbeat = (unsigned)deviceClock.epoch + config.mqttInterval;
		}
		processMqttQueue();
	}

	processWsQueue();
	processWifiScan();
	flushLogQueue();

	// expire silent sessions and clean unused websockets
	expireWsClients();
	ws.cleanupClients();

	delay(1); // let the idle task run; nothing above needs a tighter loop

#ifdef IRONFRAME_ROLLBACK_TEST
	// Deliberately broken image for the board's rollback test: it serves the
	// UI for 20 s, then loop() hangs, the watchdog restarts the board before
	// the image is confirmed, and the bootloader boots the previous image.
	if (currentMillis > 20000)
		for (;;)
			delay(100);
#endif

	logMemory();
	memoryGuardLoop();

#ifdef QEMU_NO_WIFI
	// test/qemu/boot-test.sh: a /qemu-restart-test file asks for a restart
	// 2 s after boot through the gate above (and is removed first, so the
	// next boot runs normally)
	static int qemuRestartTest = -1;
	if (qemuRestartTest < 0)
	{
		qemuRestartTest = storageMounted && LittleFS.exists("/qemu-restart-test") ? 1 : 0;
		if (qemuRestartTest)
			LittleFS.remove("/qemu-restart-test");
	}
	if (qemuRestartTest == 1 && currentMillis >= 2000)
	{
		qemuRestartTest = 0;
		Serial.println(F("[ TEST ] restart asked"));
		requestRestart("QEMU restart test");
	}
	static uint64_t lastAlive = 0;
	if (currentMillis - lastAlive >= 5000)
	{
		lastAlive = currentMillis;
		Serial.printf("[ TEST ] LOOP ALIVE uptime=%lus heap=%u\n", uptimeSeconds, ESP.getFreeHeap());
	}
#endif
}
