// -----------------------------------------------------------------------------
// The port of pyeconet's equipment logic, on its own example answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumIndex,
  enumValue,
  equipmentsOf,
  fanSpeedOf,
  fixModeEnum,
  hotWaterOf,
  mergeUpdate,
  nameOf,
  operatingStateOf,
  runningOf,
  thermostatModeOf,
  valveOf,
  waterHeaterMode,
  waterHeaterModeOf,
  waterHeaterModePayload,
  waterHeaterModes,
} from '../src/equipment.js';
import { IDS, locations, read, update } from './fixtures/econet.js';

/** The equipment of an example (one has an empty serial number: given one here). */
const first = (file) => {
  const [location] = read(file).results.locations;
  const [raw] = location.equiptments;
  return equipmentsOf([{ equiptments: [{ ...raw, serial_number: raw.serial_number || 'S1' }] }])
    .equipments[0];
};

test('the equipment list: water heaters, thermostats, zones; errors and unknown types left out', () => {
  const { equipments, skipped } = equipmentsOf(locations());
  assert.deepEqual(
    equipments.map((e) => [e.serial, e.kind]),
    [
      [IDS.gen4.serial, 'WH'],
      [IDS.gen5.serial, 'WH'],
      [IDS.legacy.serial, 'WH'],
      [IDS.gas.serial, 'WH'],
      [IDS.hvac.serial, 'HVAC'],
    ],
  );
  assert.deepEqual(skipped, ['Equipment not reachable', 'POOL']);
  const zoned = equipmentsOf([
    {
      equiptments: [
        {
          device_type: 'HVAC',
          serial_number: 'MAIN',
          device_name: 'd',
          zoning_devices: [{ serial_number: 'ZONE2', device_name: 'd' }],
        },
      ],
    },
  ]);
  assert.deepEqual(
    zoned.equipments.map((e) => [e.serial, e.kind]),
    [
      ['MAIN', 'HVAC'],
      ['ZONE2', 'HVAC'],
    ],
  );
  assert.equal(nameOf(equipments[0]), 'Water Heater');
  assert.equal(nameOf({ serial: 'S1', info: {} }), 'S1');
});

test('mode strings as pyeconet reads them', () => {
  assert.equal(waterHeaterModeOf('HEAT PUMP ONLY '), 'HEAT_PUMP_ONLY');
  assert.equal(waterHeaterModeOf('Energy Saver  '), 'ENERGY_SAVING');
  assert.equal(waterHeaterModeOf('Electric/Gas  '), 'ELECTRIC_GAS');
  assert.equal(waterHeaterModeOf('Heat Pump     '), 'HEAT_PUMP_ONLY');
  assert.equal(waterHeaterModeOf('ELECTRIC MODE'), 'ELECTRIC');
  assert.equal(waterHeaterModeOf('Turbo'), null);
  assert.equal(thermostatModeOf('Emergency Heat'), 'EMERGENCY_HEAT');
  assert.equal(thermostatModeOf('Fan Only'), 'FAN_ONLY');
  assert.equal(fanSpeedOf('Med.Lo'), 'MEDLO');
  assert.equal(fanSpeedOf('Med.Hi'), 'MEDHI');
});

test('a @MODE whose value does not match its status: the status wins', () => {
  const field = {
    constraints: { enumText: ['Heating', 'Cooling', 'Auto'] },
    status: 'Auto',
    value: 0,
  };
  assert.equal(fixModeEnum(field).value, 2);
  assert.equal(fixModeEnum({ ...field, status: 'cool' }).value, 0, 'unknown status: value kept');
});

test('water heater modes: heat pump gen4, gen5 (Electric/Gas and @ENABLED), legacy, gas', () => {
  const gen4 = first('get_locations_water_heater').info;
  assert.deepEqual(
    waterHeaterModes(gen4).map((m) => m.mode),
    ['OFF', 'ENERGY_SAVING', 'HEAT_PUMP_ONLY', 'HIGH_DEMAND', 'ELECTRIC'],
  );
  assert.equal(waterHeaterMode(gen4), 'ENERGY_SAVING');

  const gen5 = first('get_locations_water_heater_electric_gas_mode').info;
  assert.deepEqual(
    waterHeaterModes(gen5).map((m) => [m.mode, m.index]),
    [
      ['OFF', 0],
      ['ENERGY_SAVING', 1],
      ['HEAT_PUMP_ONLY', 2],
      ['HIGH_DEMAND', 3],
      ['ELECTRIC', 4],
      ['VACATION', 5],
    ],
  );
  assert.equal(waterHeaterMode(gen5), 'HIGH_DEMAND');
  // @ENABLED is the authoritative on/off flag (pyeconet).
  assert.equal(waterHeaterMode({ ...gen5, '@ENABLED': { ...gen5['@ENABLED'], value: 0 } }), 'OFF');
  assert.deepEqual(waterHeaterModePayload(gen5, 'OFF'), { '@ENABLED': 0, '@MODE': 0 });
  assert.deepEqual(waterHeaterModePayload(gen5, 'ELECTRIC'), { '@ENABLED': 1, '@MODE': 4 });

  const legacy = first('get_locations_water_heater_legacy_modes').info;
  assert.deepEqual(
    waterHeaterModes(legacy).map((m) => [m.mode, m.index]),
    [
      ['ENERGY_SAVING', 0],
      ['PERFORMANCE', 1],
      ['OFF', null],
    ],
  );
  assert.deepEqual(waterHeaterModePayload(legacy, 'OFF'), { '@ENABLED': 0 });
  assert.deepEqual(waterHeaterModePayload(legacy, 'PERFORMANCE'), { '@ENABLED': 1, '@MODE': 1 });
  assert.equal(waterHeaterModePayload(legacy, 'VACATION'), null);

  const gas = first('get_locations_water_heater_no_modes').info;
  assert.deepEqual(waterHeaterModes(gas), []);
  assert.equal(waterHeaterMode(gas), null);
  assert.equal(waterHeaterModePayload(gas, 'OFF'), null);
  // @ENABLED without @MODE: off and the gas mode (pyeconet modes).
  assert.deepEqual(
    waterHeaterModes({ ...gas, '@ENABLED': { value: 1 } }).map((m) => m.mode),
    ['OFF', 'GAS'],
  );
});

test('hot water, running, valve', () => {
  assert.equal(hotWaterOf({ '@HOTWATER': 'ic_tank_hundread_percent_v2.png' }), 100);
  assert.equal(hotWaterOf({ '@HOTWATER': 'ic_tank_fourty_percent.png' }), 66);
  assert.equal(hotWaterOf({ '@HOTWATER': 'ic_tank_ten_percent.png' }), 33);
  assert.equal(hotWaterOf({ '@HOTWATER': 'ic_tank_empty.png' }), 0);
  assert.equal(hotWaterOf({ '@HOTWATER': 'ic_whatever.png' }), null);
  assert.equal(hotWaterOf({}), null);
  assert.equal(runningOf({ '@RUNNING': 'Compressor Running' }), 1);
  assert.equal(runningOf({ '@RUNNING': '' }), 0);
  assert.equal(runningOf({}), null);
  assert.equal(valveOf({ '@VALVESTATUS': { title: 'Shut-OFF Valve - Open' } }), 1);
  assert.equal(valveOf({ '@VALVESTATUS': { title: 'Shut-OFF Valve - Closed' } }), 0);
  assert.equal(valveOf({ '@VALVESTATUS': { title: 'Shut-OFF Valve not installed' } }), null);
});

test('thermostat enums', () => {
  const hvac = first('get_locations_hvac').info;
  assert.equal(enumValue(hvac['@MODE'], thermostatModeOf), 'HEATING');
  assert.equal(enumIndex(hvac['@MODE'], thermostatModeOf, 'EMERGENCY_HEAT'), 5);
  assert.equal(enumValue(hvac['@FANSPEED'], fanSpeedOf), 'AUTO');
  assert.equal(enumIndex(hvac['@FANSPEED'], fanSpeedOf, 'MAX'), null);
  assert.equal(operatingStateOf(hvac), 0);
  assert.equal(operatingStateOf({ '@RUNNINGSTATUS': 'Heating Stage 1' }), 1);
  assert.equal(operatingStateOf({ '@RUNNINGSTATUS': 'Cooling' }), 2);
  assert.equal(operatingStateOf({}), null);
});

test('live updates merge like pyeconet update_equipment_info', () => {
  const { info } = first('get_locations_water_heater');
  // A bare value goes into the `value` of an object field (mqtt_temp_desired).
  const desired = read('mqtt_temp_desired');
  const a = mergeUpdate(info, desired);
  assert.equal(a.changed, true);
  assert.equal(a.info['@SETPOINT'].value, 126);
  assert.equal(a.info['@SETPOINT'].constraints.lowerLimit, 110);
  assert.equal(info['@SETPOINT'].value, 132, 'the input is not modified');
  // Plain fields are replaced (mqtt_running_reported).
  const b = mergeUpdate(a.info, read('mqtt_running_reported'));
  assert.equal(b.info['@RUNNING'], 'Running');
  assert.equal(b.info['@HOTWATER'], 'ic_tank_fourty_percent.png');
  // Same values again: nothing changed.
  assert.equal(mergeUpdate(b.info, read('mqtt_running_reported')).changed, false);
  // An object update merges; @MODE follows its status.
  const c = mergeUpdate(b.info, update(IDS.gen4, { '@MODE': { status: 'HIGH DEMAND', value: 1 } }));
  assert.equal(c.info['@MODE'].value, 3);
  assert.deepEqual(c.info['@MODE'].constraints, info['@MODE'].constraints);
  // Confirmation dialogs are never applied nor accepted.
  assert.equal(mergeUpdate(c.info, { dialog: { message: 'x' }, '@AWAY': true }).changed, false);
  // Non-"@" keys are ignored.
  assert.equal(mergeUpdate(c.info, { serial_number: 'X', transactionId: 'y' }).changed, false);
});
