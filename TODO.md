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
- MQTT: are the commands echoed on `desired` and then confirmed on
  `reported`? (both are applied, as pyeconet does). Does the broker drop the
  connection when the token expires?
- The energy report: does `start_date`/`end_date` without a time zone mean
  the local day of the unit? Is `data` hourly for one day? Gas units: kBTU.
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
  it (`@ENABLED` and `@MODE`).
- **Thermostat modes**: THERMOSTAT_MODE has no fan only nor emergency heat:
  the `mode` feature offers off/heating/cooling/auto and shows emergency heat
  as heating, fan only as off; the `system-mode` select carries every EcoNet
  mode. Fan speeds map to AC_FAN_SPEED (Med.Lo → LOW_MID, Med.Hi → MID_HIGH,
  Max → TURBO) on the air-conditioning category: the core has no thermostat
  fan speed type.
- **Shut-off valve read only**: the PIPELINE rule (valves off by default);
  pyeconet itself does not command it.
- **Commands need the live link** (they are MQTT messages): refused with a
  message while it is down. Setpoints checked against the unit limits, the
  deadband kept in auto mode. No command is held back for a hot water
  setpoint: the unit limits apply (docs warn about scalding).
- **Login limits**: a refused password stops everything until the
  configuration changes or the test button succeeds; a refused token gets one
  new login, at most one every 5 minutes, never a loop.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json` and the
  manifest (with the `docker_image` tag): the one-time exception to "versions
  belong to the Release workflow", the template's 1.0.0 and image name had to
  be replaced for this repository; the first patch release gives 0.1.1.
- **Duplicates**: checked by the pipeline before the batch (forum thread
  10385, store, Gladys core, GitHub), not again in this session.
