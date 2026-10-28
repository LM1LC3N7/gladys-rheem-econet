# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). Its one
other runtime dependency is `mqtt`; HTTP is bare `node:https`. It signs in to
the **EcoNet** cloud (Rheem, ClearBlade platform) with the e-mail and the
password of the app, turns the water heaters and thermostats into Gladys
devices, follows them live through the MQTT broker of the app and sends the
commands through it. Unofficial, not affiliated with Rheem.

The EcoNet logic is ported from `w1ll1am23/pyeconet` (MIT): keep
`THIRD_PARTY_NOTICES.md` up to date when porting more.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run them (tests on both Node
versions) before pushing.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          EcoNetApp: login, readings, live events, energy, commands,
                    status, transports, connection test
src/econet.js       REST client (node:https): login, getUserDataForApp,
                    dynamicAction (energy); error kinds; pacing
src/live.js         MQTT (mqtts, port 1884): live updates, commands
src/equipment.js    pyeconet's equipment logic (pure): list, merge of the
                    updates, water heater and thermostat fields, mode payloads
src/devices.js      equipment -> Gladys device, states, command -> payload (pure)
src/publisher.js    states within the Gladys rate limit
src/config.js       config_schema normalized
src/constants.js    manifest keys, feature keys, Gladys enums, timings
src/i18n.js         runtime texts (en/fr)
test/fixtures/      pyeconet's example answers (as published) and an account
test/helpers/       fake EcoNet cloud and MQTT broker
```

## Rules

- **External ids are forever**: device = `water-heater:<serial>` or
  `thermostat:<serial>` (lowercased, `[a-z0-9_-]`), feature =
  `<device>:<key>` with the keys of `FEATURES` (constants.js). The select
  option values (`heating`, `fan-only`, `emergency-heat`…, `auto`/`on`) are
  frozen too: scenes store them.
- Manifest keys are frozen: `email`, `password`, `max_water_setpoint`,
  `language`, `test_connection`. Gladys 5.2 minimum (`publishEnergyConsumption`).
- **Scalding**: no water setpoint above `max_water_setpoint` (149 °F = 65 °C
  by default and at most, Louis's rule of 2026-10-28; bounded by the unit
  limits, see `waterSetpointCap` in devices.js) may ever be sent, whatever
  the caller; it is also the `max` of the feature. `WATER_SETPOINT_HARD_MAX`
  (149 °F, src/config.js) is never raised: 150 °F is already 65.6 °C.
  `payloadOf` checks the written value once more (cap, 149 °F, 65 °C).
  `test/devices.test.js`, `test/app.test.js` and `test/manifest.test.js`
  hold it.
- Value conventions: the Gladys side uses the core enums of
  `server/utils/constants.js` (WATER_HEATER_MODE, THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE, AC_FAN_SPEED), copied in constants.js; units only
  from `DEVICE_FEATURE_UNITS_BY_CATEGORY` (checked in test/devices.test.js).
  The EcoNet side uses pyeconet's names (`ENERGY_SAVING`, `HEAT_PUMP_ONLY`,
  `MEDLO`…). Convert in devices.js only.
- **Never sign in more than needed**: a refused password is never retried
  automatically; a refused token gets one new login, at most one every
  5 minutes, doubled while EcoNet refuses fresh tokens (up to 6 h); a broker
  refusing a fresh token never triggers a login; a 429 blocks every request;
  the test button is the only extra login.
- Commands only go through MQTT: when the live link is down, a command fails
  with a clear message, it is never queued. One at a time per equipment,
  refused for an offline equipment or a state older than 45 min, confirmed
  by `reported` only. The shut-off valve is never commanded. Setpoints are
  refused when the account may not be in °F.
- Container limits: read-only rootfs, only `/data` writable (unused: the token
  stays in memory). Gladys: 300 states/min (the publisher keeps 250).
- Never log or put in a status message the password, the user token, the
  e-mail address (it is in the MQTT client id) or a request header.
- Tests never touch the network: fake REST transport, fake MQTT broker, SDK
  fake Gladys.
- Write files as UTF-8 without BOM; `test/manifest.test.js` refuses mojibake
  and a BOM in the manifest and the docs.
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
