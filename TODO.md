# TODO — Rheem EcoNet v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-16): login (e-mail + password, user
      token in memory, one new login on a refused token, 5 min between two
      logins at most, a refused password never retried by itself),
      `getUserDataForApp` every 30 min (5 min while live is down), backoff,
      429 with Retry-After (15 min at least); live updates and commands over
      the ClearBlade MQTT broker (TLS 1884, our own reconnection 10 s → 5 min);
      water heaters (mode, setpoint, hot water, heating, valve read only,
      tank/compressor health, daily energy, alerts) and thermostats (zones
      included: temperature, humidity, heat/cool setpoints with deadband,
      mode, EcoNet mode select, running state, fan speed, fan mode, alerts);
      badges; "Test the connection"; en/fr; docs en/fr; cover. Tested against
      pyeconet's example answers only.
- [x] **Review fixes** (2026-10-17): anti-scald `max_water_setpoint`,
      Gladys 5.2, fresh-token handling (login spacing doubled, live refusal
      held back), 429 pause of every request, MQTT stable-link backoff and
      jitter, catch-up spacing, commands serialized / checked / confirmed,
      `reported` only, unique transaction ids, discarded and unknown modes,
      °F check, update-only @MODE fix, empty energy report, valve as an
      opening sensor, LiveLink.open() failures retried.
- [ ] **Milestone 2 — real account**: run against a real account and compare
      with the app (see "To check"); turn the answers (anonymized) into
      fixtures.
- [ ] **Milestone 3 — more**: away/vacation (`@AWAY`), schedule resume
      (`@SCHEDULERESUME` and its confirmation dialog), water usage (gallons →
      litres), Wi-Fi signal (`@SIGNAL`, MQTT only), dehumidifier setpoint and
      switch, alert details if EcoNet exposes them, tank temperature if a
      unit reports one.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real account

- Login refusal: pyeconet only knows `200` + `options.success: false`; HTTP
  400/401 on `/user/auth` are also taken as a refused password, 403 as a
  passing firewall. Check what EcoNet really answers to a wrong password.
- Lifetime of the ClearBlade user token, and what `getUserDataForApp`
  answers once it expired (401 assumed).
- The temperature unit: every example says `deg F` (pyeconet and Home
  Assistant assume °F). Does an account set to Celsius change the values?
  (Today: `temperature_display_unit` other than Fahrenheit, or a
  `constraints.units` other than °F, refuses the setpoints.)
- MQTT: are the commands echoed on `desired` and then confirmed on
  `reported`? Only `reported` changes the state now (pyeconet applies both);
  a value not reported within 30 s is logged and the last reported state is
  published again. Does a reported update repeat the whole field or only the
  value? Does the broker drop the connection when the token expires? Is the
  unique `transactionId` (`ANDROID_<ISO ms>_<n>`) accepted?
- The energy report (dates to check): does `start_date`/`end_date` without a
  time zone mean the local day of the unit? Is "yesterday counted from 12 h
  ago" the right day for the Gladys time zone? Is `data` hourly for one day
  (an empty `data` is taken as no reading)? Gas units: kBTU.
- `@RUNNINGSTATUS` texts of the thermostats (only "" in the examples):
  "heat"/"cool" are looked for.
- `@FANMODE` texts (none in the examples): "Auto" / "On Continuous" assumed.
- `@SETPOINT` of a thermostat is read as the room temperature, as pyeconet
  and Home Assistant do.

## Decisions

- **Reference reused: pyeconet** (w1ll1am23/pyeconet, MIT, maintained, the
  library of the Home Assistant EcoNet integration). It cannot run in a Node
  container: its logic is ported to JavaScript (`src/econet.js`,
  `src/equipment.js`, `src/live.js`), with its MIT notice in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). Its example
  answers are the test fixtures (`test/fixtures/econet/`, kept as published,
  ignored by Prettier).
- **Neighbour module**: LM1LC3N7/gladys-toshiba-ac (app structure, state
  publisher, badges, status messages).
- **MQTT.js** (MIT) as the second runtime dependency, its own reconnection
  off (a new connection may need a new login). `npm audit --omit=dev`: 0.
- **ClearBlade system key and secret** are the public constants of the EcoNet
  app (from pyeconet), not user secrets. The MQTT client id is the app's
  format `<e-mail><13 digits>_android`, never logged.
- **User token in memory only**: a restart logs in once; nothing is written
  to `/data`.
- **Units**: °F everywhere (water-heater, thermostat and temperature-sensor
  categories accept fahrenheit); `remaining-hot-water` %, health %
  (maintenance/life-remaining), daily energy kWh
  (energy-sensor/daily-consumption, published with `publishEnergyConsumption`,
  the last 3 elapsed days, "yesterday" counted from 12 hours ago so the day is
  over in North America), alerts counter-sensor/integer without unit.
- **Water heater modes → WATER_HEATER_MODE** (one EcoNet mode per Gladys
  value, EcoNet names as labels): Off → OFF; Energy Saver → AUTO on a heat
  pump (the unit picks heat pump or elements), ECO on other tanks; Heat Pump
  Only → ECO (the core: "heat-pump-only on a heat-pump appliance"); High
  Demand and Performance → BOOST; Electric and Gas → MANUAL; Vacation → AWAY.
  On/off is the OFF mode (no separate `binary`), as pyeconet's set_mode does
  it (`@ENABLED` and `@MODE`). A mode sharing a Gladys value with an earlier
  one (High Demand and Performance) is not offered but still shown with that
  value; discarded and unknown mode texts are logged once.
- **Thermostat modes**: THERMOSTAT_MODE has no fan only nor emergency heat:
  the `mode` feature offers off/heating/cooling/auto and shows emergency heat
  as heating, fan only as off; the `system-mode` select carries every EcoNet
  mode. Fan speeds map to AC_FAN_SPEED (Med.Lo → LOW_MID, Med.Hi → MID_HIGH,
  Max → TURBO) on the air-conditioning category: the core has no thermostat
  fan speed type.
- **Shut-off valve read only**: the PIPELINE rule (valves off by default);
  pyeconet itself does not command it. Published as an opening sensor
  (opening-sensor/binary, OPENING_SENSOR_STATE: 1 closed, 0 open): a sensor
  category, never reachable by "turn everything off"; the water-valve
  category has no open/closed type.
- **Anti-scald cap `max_water_setpoint`** (review, blocking): a number in °F,
  80–149, 149 by default (65 °C, Louis's rule of 2026-10-28: hot water never
  written above 65 °C, 65 °C by default; it was 80–185, 120 by default);
  without a usable value, the scald warning the unit reports
  (`@SETPOINT.constraints.warning[].value`), else 149; always kept within the
  unit limits (a lower one wins), rounded down, never above 149 °F
  (`WATER_SETPOINT_HARD_MAX`, exactly 65 °C). It is the `max` of the setpoint
  feature, and any higher setpoint is refused with an English + French
  message giving the °C equivalent. The value written is checked once more
  (cap, 149 °F, 65 °C after conversion). The unit stays °F for the user; the
  docs give the °C table and explain legionella (140 °F is enough).
- **Gladys 5.2** minimum: `publishEnergyConsumption`.
- **Commands need the live link** (they are MQTT messages): refused with a
  message while it is down. Serialized per equipment (checks and sending);
  refused when EcoNet reports the equipment offline or its state is older
  than 45 min (a reading every 30 min, plus margin). Setpoints checked
  against the unit limits, the deadband kept in auto mode. Only the
  `reported` topic changes the state; a command not confirmed by `reported`
  within 30 s is logged and the last reported state is published again (the
  confirmation runs after the ack: Gladys awaits a command for a few seconds
  only).
- **°F check**: the account's `temperature_display_unit` and the
  `constraints.units` of the temperature fields; anything but °F is logged
  once, shown in the status, and every setpoint is refused.
- **Login limits**: a refused password stops everything until the
  configuration changes or the test button succeeds; a refused token gets one
  new login, at most one every 5 minutes; a token refused less than 5 minutes
  after its login doubles that spacing (10, 20 min… 6 h), back to 5 min after
  the first successful call, shown in the status. The broker refusing (CONNACK
  4/5) a token younger than 5 minutes is a lasting refusal of the live link:
  no new login, next attempt in 30 min (doubled up to 6 h); an older token is
  dropped (next login, spaced as above).
- **HTTP 429**: the client blocks every request, the login included, until
  what Retry-After says (15 min at least) without touching the network; the
  live link and the test button wait too, the energy reading stops.
- **Retries**: REST backoff 10 s → 30 min and MQTT 10 s → 5 min, both ±25 % at
  random; the MQTT count starts again only after 60 s of a stable link; one
  catch-up reading after a reconnection at most every 5 minutes.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json` and the
  manifest (with the `docker_image` tag): the one-time exception to "versions
  belong to the Release workflow", the template's 1.0.0 and image name had to
  be replaced for this repository; the first patch release gives 0.1.1.
- **Duplicates**: checked by the pipeline before the batch (forum thread
  10385, store, Gladys core, GitHub), not again in this session.
