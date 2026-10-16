# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Rheem and Ruud water heaters of the EcoNet cloud: mode (EcoNet modes mapped
  to the Gladys water heater modes), water setpoint (°F), hot water available,
  heating, shut-off valve (read only), tank and compressor health, energy per
  day (kWh), active alerts.
- EcoNet thermostats and the zones of zoned systems: temperature, humidity,
  heating and cooling setpoints, mode, EcoNet mode (fan only and emergency
  heat included), running state, fan speed, fan mode, active alerts.
- Live updates and commands over the MQTT broker of the EcoNet app, a full
  reading every 30 minutes (5 while the live link is down), the daily energy
  every 6 hours.
- Connection status, transport badges, a "Test the connection" button, French
  and English texts and documentation.
- The EcoNet logic is ported from pyeconet (MIT): see
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-rheem-econet/commits/main
