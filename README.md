# Rheem EcoNet for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for the
Rheem and Ruud water heaters and thermostats of the **EcoNet** app (United
States and Canada), through the EcoNet cloud: live states over MQTT, commands,
daily energy.

> Never tested on a real account yet: written from pyeconet and tested
> against its example answers. Unofficial, not affiliated with Rheem.

User documentation: [English](docs/en.md) · [Français](docs/fr.md).

## Features

- **Water heaters**: mode (EcoNet modes mapped to the Gladys water heater
  modes), water setpoint (°F, capped by the anti-scald `max_water_setpoint`,
  120 °F by default), hot water available, heating, shut-off valve (read-only
  opening sensor), tank and compressor health, energy per day (kWh), active
  alerts.
- **Thermostats** (and each zone of a zoned system): temperature, humidity,
  heating and cooling setpoints (°F, deadband kept in auto), mode, every
  EcoNet mode as a select, running state, fan speed, fan mode, active alerts.
- Live updates over the MQTT broker of the app, a full reading every 30 min
  (5 min while the live link is down), energy every 6 h, transport badges,
  a "Test the connection" button, French and English.
- Commands checked (online, recent state, limits), one at a time per
  equipment, confirmed by the equipment's report within 30 s.
- Requires Gladys 5.2 or later (`publishEnergyConsumption`).

## Credits

The EcoNet protocol logic is ported from
[pyeconet](https://github.com/w1ll1am23/pyeconet) by William Scanlon (MIT),
the library of the Home Assistant EcoNet integration: endpoints, MQTT topics
and messages, water heater and thermostat logic. Its example answers are the
test fixtures. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Runtime dependencies: [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
(Apache-2.0) and [MQTT.js](https://github.com/mqttjs/MQTT.js) (MIT).

## Development

```bash
npm install
npm test                 # node --test, against the SDK's fake Gladys, no network
npm run lint
npm run format:check
npm run audit            # npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .
```

Architecture:

```
index.js            SDK wiring only
src/handlers.js     the SDK handlers, shared with the tests
src/app.js          the integration: account, devices, states, timers, status
src/econet.js       REST client: login, equipment list, energy report
src/live.js         MQTT: live updates and commands
src/equipment.js    pyeconet's equipment logic (pure)
src/devices.js      Gladys devices, states and command payloads (pure)
src/publisher.js    states within the Gladys budget (300 per minute)
src/i18n.js         texts (en, fr)
```

Read [CLAUDE.md](CLAUDE.md) for the rules (external ids are forever, no
secret in the logs, versions belong to the Release workflow) and
[TODO.md](TODO.md) for the decisions and what comes next.

## License

Apache-2.0, see [LICENSE](LICENSE). Rheem, Ruud and EcoNet are trademarks of
their respective owners.
