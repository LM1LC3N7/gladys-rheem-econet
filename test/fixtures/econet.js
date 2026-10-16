// -----------------------------------------------------------------------------
// The example answers of pyeconet (w1ll1am23/pyeconet, MIT,
// src/pyeconet/example_responses/, copied as they are in fixtures/econet/),
// and an account made of them: every example uses the same serial number, so
// each equipment gets its own here.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const read = (name) =>
  JSON.parse(readFileSync(new URL(`./econet/${name}.json`, import.meta.url), 'utf8'));

export const EMAIL = 'owner@example.com';
export const PASSWORD = 'p4ssw0rd';
export const ACCOUNT = read('user_auth').options.account_id;
export const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
export const MINUTE = 60_000;

/** Serial numbers and device names of the account. */
export const IDS = {
  gen4: { serial: 'Q0320GEN4', deviceName: '7490000000001' },
  gen5: { serial: 'Q0320GEN5', deviceName: '7490000000002' },
  legacy: { serial: 'Q0320LEG', deviceName: '7490000000003' },
  gas: { serial: 'Q0320GAS', deviceName: '7490000000004' },
  hvac: { serial: 'Q0320HVAC', deviceName: '7490000000005' },
};

const equipmentOf = (file, id) => ({
  ...read(file).results.locations[0].equiptments[0],
  serial_number: id.serial,
  device_name: id.deviceName,
});

/** The getUserDataForApp locations of the account: four water heaters and a thermostat. */
export function locations() {
  const [home] = read('get_locations_water_heater').results.locations;
  return [
    {
      ...home,
      equiptments: [
        equipmentOf('get_locations_water_heater', IDS.gen4),
        equipmentOf('get_locations_water_heater_electric_gas_mode', IDS.gen5),
        equipmentOf('get_locations_water_heater_legacy_modes', IDS.legacy),
        equipmentOf('get_locations_water_heater_no_modes', IDS.gas),
        equipmentOf('get_locations_hvac', IDS.hvac),
        { error: 'Equipment not reachable' },
        { device_type: 'POOL', serial_number: 'X1', device_name: 'x' },
      ],
    },
  ];
}

/** A live update of an equipment (mqtt_running_reported shape). */
export const update = (id, fields) => ({
  transactionId: 'WIFI_1.0_2020-05-30T14:17:45.282Z',
  device_name: id.deviceName,
  serial_number: id.serial,
  ...fields,
});
