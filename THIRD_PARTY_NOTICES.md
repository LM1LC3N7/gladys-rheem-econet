# Third-party notices

gladys-rheem-econet is licensed under the Apache License, Version 2.0 (see
`LICENSE`). It includes work ported from the project below, under its own
license.

## pyeconet

- Project: https://github.com/w1ll1am23/pyeconet
- License: MIT
- What was ported to JavaScript: the EcoNet cloud endpoints, headers and
  payloads (`src/pyeconet/api.py`: login, `getUserDataForApp`,
  `dynamicAction`, the MQTT connection, topics and command messages, the
  `@MODE` status fix), the merge of the live updates
  (`src/pyeconet/equipment/__init__.py`), the water heater logic
  (`src/pyeconet/equipment/water_heater.py`: modes, on/off, hot water level,
  shut-off valve, health values, energy report) and the thermostat logic
  (`src/pyeconet/equipment/thermostat.py`: modes, fan speeds, fan modes,
  setpoints). They live in `src/econet.js`, `src/equipment.js` and
  `src/live.js`.
- Copied as they are: the example answers of
  `src/pyeconet/example_responses/`, in `test/fixtures/econet/` (tests only,
  not in the image).

```
MIT License

Copyright (c) 2016 William Scanlon

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
```

## Runtime dependencies

- `@gladysassistant/integration-sdk` (Apache-2.0) and `mqtt` (MQTT.js, MIT),
  installed from npm with their own license files.

Rheem, Ruud and EcoNet are trademarks of their respective owners. This project
is not affiliated with, endorsed by or sponsored by Rheem Manufacturing
Company.
