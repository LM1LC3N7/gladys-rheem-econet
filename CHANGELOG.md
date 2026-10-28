# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.3] - 2026-10-28

### Changed

- Hot water never above 65 °C: the "Maximum water setpoint" option goes up
  to 149 °F (65 °C) instead of 185 °F (85 °C), and its default is 149 °F
  instead of 120 °F (49 °C). Set it to 120 °F to keep the former default.
  The limits of the unit still apply and win when lower. A maximum saved
  above 149 °F counts as 149 °F, with a line in the log; lower it to save the
  configuration form again.
- The scald refusal gives the °C equivalent of the cap.

### Fixed

- No water setpoint above 149 °F (65 °C) is ever written, whatever the
  configuration or the unit allows: a hard ceiling checks the value that
  leaves, rounded down for the cap.

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-17

### Added

- Rheem and Ruud water heaters of the EcoNet cloud: mode (EcoNet modes mapped
  to the Gladys water heater modes), water setpoint (°F), hot water available,
  heating, shut-off valve (read-only opening sensor), tank and compressor
  health, energy per day (kWh), active alerts.
- Anti-scald cap: the "Maximum water setpoint" option (120 °F by default,
  raise it to 140 °F against legionella) bounds every water setpoint.
- Commands are checked (equipment online, recent state, limits), sent one at
  a time per equipment, and confirmed by the equipment's report within 30 s;
  otherwise the last reported value is shown again.
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
- Requires Gladys 5.2 or later (daily energy).

### Security

- A refused password is never retried by itself; a token refused minutes
  after its login spaces the next logins out (5 min doubled up to 6 h); a
  broker refusing a fresh token holds the live link back (30 min doubled up
  to 6 h) without logging in again; an HTTP 429 pauses every request, the
  login included (what EcoNet asks, 15 min at least).
- Setpoints are refused when the account may not report °F.

[Unreleased]: https://github.com/LM1LC3N7/gladys-rheem-econet/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/LM1LC3N7/gladys-rheem-econet/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/LM1LC3N7/gladys-rheem-econet/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-rheem-econet/releases/tag/v0.1.1
