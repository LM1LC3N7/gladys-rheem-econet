// -----------------------------------------------------------------------------
// The Gladys devices of the EcoNet equipments, their states and the payloads
// of the commands (pure), on pyeconet's example answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDevice,
  modeReport,
  modeValues,
  payloadOf,
  statesOf,
  UnsupportedError,
  waterSetpointCap,
} from '../src/devices.js';
import { equipmentsOf, numberOf } from '../src/equipment.js';
import { IDS, locations } from './fixtures/econet.js';

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};
const all = () => equipmentsOf(locations()).equipments;
const bySerial = (id) => all().find((e) => e.serial === id.serial);
const keys = (device) => device.features.map((f) => f.external_id.split(':').at(-1));
const feature = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

/**
 * The units the Gladys core accepts (server/utils/constants.js,
 * DEVICE_FEATURE_UNITS_BY_CATEGORY and …_BY_CATEGORY_AND_TYPE), for the
 * categories this integration uses. `null`: no unit.
 */
const CORE_UNITS = {
  'water-heater': {
    mode: [null],
    'target-temperature': ['celsius', 'fahrenheit'],
    'remaining-hot-water': ['percent', 'liter'],
    heating: [null],
  },
  thermostat: {
    'target-temperature': ['celsius', 'fahrenheit'],
    mode: [null],
    'operating-state': [null],
  },
  'temperature-sensor': { '*': ['celsius', 'fahrenheit', 'kelvin'] },
  'humidity-sensor': { '*': ['percent'] },
  maintenance: { '*': ['percent'] },
  'energy-sensor': { '*': ['watt-hour', 'kilowatt-hour', 'megawatt-hour'] },
  'air-conditioning': { 'fan-speed': [null] },
  'opening-sensor': { binary: [null] },
  text: { select: [null] },
  'counter-sensor': { '*': [null] },
};

test('every feature uses a unit the core accepts for its category and type', () => {
  for (const equipment of all()) {
    for (const f of buildDevice(gladys, equipment, 'en').features) {
      const allowed = CORE_UNITS[f.category]?.[f.type] ?? CORE_UNITS[f.category]?.['*'];
      assert.ok(allowed, `${f.external_id}: ${f.category}/${f.type} not expected`);
      assert.ok(allowed.includes(f.unit ?? null), `${f.external_id}: unit ${f.unit}`);
    }
  }
});

test('a heat pump water heater (gen4)', () => {
  const device = buildDevice(gladys, bySerial(IDS.gen4), 'fr', { maxWaterSetpoint: 140 });
  assert.equal(device.external_id, 'ext:test:water-heater:q0320gen4');
  assert.equal(device.name, 'Water Heater');
  assert.equal(device.model, 'heatpumpWaterHeaterGen4');
  assert.deepEqual(keys(device), [
    'mode',
    'target-temperature',
    'heating',
    'energy-daily',
    'alerts',
  ]);
  const mode = feature(device, 'mode');
  assert.deepEqual(
    mode.supported_options.map((o) => [o.value, o.label]),
    [
      [0, 'Arrêt'],
      [1, 'Économie d’énergie'],
      [2, 'Pompe à chaleur seule'],
      [3, 'Forte demande'],
      [4, 'Électrique'],
    ],
  );
  const setpoint = feature(device, 'target-temperature');
  assert.deepEqual([setpoint.unit, setpoint.min, setpoint.max], ['fahrenheit', 110, 140]);
  assert.equal(setpoint.read_only, false);
  assert.equal(feature(device, 'heating').read_only, true);
  assert.equal(feature(device, 'energy-daily').type, 'daily-consumption');
  assert.deepEqual(statesOf(bySerial(IDS.gen4)), [
    ['mode', { state: 1 }],
    ['target-temperature', { state: 132 }],
    ['heating', { state: 1 }],
    ['alerts', { state: 0 }],
  ]);
});

test('a gen5 heat pump: hot water, health, valve not installed, vacation', () => {
  const equipment = bySerial(IDS.gen5);
  const device = buildDevice(gladys, equipment, 'en');
  assert.deepEqual(keys(device), [
    'mode',
    'target-temperature',
    'remaining-hot-water',
    'heating',
    'tank-health',
    'compressor-health',
    'energy-daily',
    'alerts',
  ]);
  assert.deepEqual(
    modeValues(equipment.info).map((m) => [m.mode, m.value]),
    [
      ['OFF', 0],
      ['ENERGY_SAVING', 1],
      ['HEAT_PUMP_ONLY', 2],
      ['HIGH_DEMAND', 3],
      ['ELECTRIC', 4],
      ['VACATION', 5],
    ],
  );
  const states = Object.fromEntries(statesOf(equipment));
  assert.deepEqual(states.mode, { state: 3 });
  assert.deepEqual(states['remaining-hot-water'], { state: 100 });
  assert.deepEqual(states['tank-health'], { state: 100 });
  assert.deepEqual(states['compressor-health'], { state: 100 });
  // A valve that reports itself installed gets a read-only feature.
  const withValve = {
    ...equipment,
    info: { ...equipment.info, '@VALVESTATUS': { title: 'Shut-OFF Valve - Closed', value: 0 } },
  };
  const valve = feature(buildDevice(gladys, withValve, 'en'), 'shutoff-valve');
  assert.equal(valve.read_only, true);
  assert.deepEqual([valve.category, valve.type], ['opening-sensor', 'binary']);
  // OPENING_SENSOR_STATE: 1 closed, 0 open.
  assert.deepEqual(Object.fromEntries(statesOf(withValve))['shutoff-valve'], { state: 1 });
  const open = {
    ...equipment,
    info: { ...equipment.info, '@VALVESTATUS': { title: 'Shut-OFF Valve - Open', value: 1 } },
  };
  assert.deepEqual(Object.fromEntries(statesOf(open))['shutoff-valve'], { state: 0 });
  assert.throws(() => payloadOf(open, 'shutoff-valve', 1), /cannot be controlled/);
});

test('modes sharing a Gladys value: the first is offered, the other still shown', () => {
  const equipment = bySerial(IDS.legacy);
  const info = {
    ...equipment.info,
    '@MODE': {
      constraints: { enumText: ['High Demand', 'Performance', 'Turbo'] },
      status: 'Performance',
      value: 1,
    },
  };
  assert.deepEqual(
    modeValues(info).map((m) => [m.mode, m.value]),
    [
      ['HIGH_DEMAND', 3],
      ['OFF', 0],
    ],
  );
  assert.deepEqual(modeReport(info), { discarded: ['PERFORMANCE'], unknown: ['Turbo'] });
  assert.deepEqual(Object.fromEntries(statesOf({ ...equipment, info })).mode, { state: 3 });
});

test('the anti-scald cap of the water setpoint', () => {
  const { info } = bySerial(IDS.gen4); // limits 110–140, scald warning at 121
  assert.deepEqual(waterSetpointCap(info, 120), { min: 110, max: 120 });
  assert.deepEqual(waterSetpointCap(info, undefined), { min: 110, max: 121 });
  assert.deepEqual(waterSetpointCap(info, 160), { min: 110, max: 140 });
  assert.deepEqual(waterSetpointCap(info, 100), { min: 110, max: 110 });
  const noWarning = { ...info, '@SETPOINT': { constraints: { lowerLimit: 90, upperLimit: 150 } } };
  assert.deepEqual(waterSetpointCap(noWarning, undefined), { min: 90, max: 149 });
  // The feature offers the cap as its maximum.
  const device = buildDevice(gladys, bySerial(IDS.gen4), 'en', { maxWaterSetpoint: 120 });
  assert.equal(feature(device, 'target-temperature').max, 120);
});

test('a plain electric tank: Energy Saver is ECO, Performance is BOOST, off through @ENABLED', () => {
  const equipment = bySerial(IDS.legacy);
  assert.deepEqual(
    modeValues(equipment.info).map((m) => [m.mode, m.value]),
    [
      ['ENERGY_SAVING', 2],
      ['PERFORMANCE', 3],
      ['OFF', 0],
    ],
  );
  const device = buildDevice(gladys, equipment, 'en');
  assert.ok(!keys(device).includes('energy-daily'), 'no energy report in its actions');
  assert.deepEqual(payloadOf(equipment, 'mode', 0), { '@ENABLED': 0 });
  assert.deepEqual(payloadOf(equipment, 'mode', 3), { '@ENABLED': 1, '@MODE': 1 });
  assert.throws(() => payloadOf(equipment, 'mode', 5), UnsupportedError);
});

test('a gas water heater without modes: setpoint only', () => {
  const equipment = bySerial(IDS.gas);
  assert.deepEqual(keys(buildDevice(gladys, equipment, 'en')), [
    'target-temperature',
    'heating',
    'alerts',
  ]);
  assert.throws(() => payloadOf(equipment, 'mode', 4), /no mode/);
});

test('water heater commands are checked against the unit', () => {
  const equipment = bySerial(IDS.gen4);
  const cap = { maxWaterSetpoint: 120 };
  assert.deepEqual(payloadOf(equipment, 'target-temperature', 120.4, cap), { '@SETPOINT': 120 });
  // Above the anti-scald cap: refused, in English and French.
  assert.throws(
    () => payloadOf(equipment, 'target-temperature', 125, cap),
    (err) =>
      err instanceof UnsupportedError &&
      /Scald risk: the water setpoint is limited to 120 °F/.test(err.message) &&
      /Risque de brûlure/.test(err.message),
  );
  const raised = { maxWaterSetpoint: 185 };
  assert.deepEqual(payloadOf(equipment, 'target-temperature', 140, raised), { '@SETPOINT': 140 });
  assert.throws(() => payloadOf(equipment, 'target-temperature', 150, raised), /limited to 140/);
  assert.throws(() => payloadOf(equipment, 'target-temperature', 100, cap), /between 110 and 140/);
  assert.throws(() => payloadOf(equipment, 'target-temperature', 'hot', cap), /number/);
  // An account that may not be in °F: every setpoint refused.
  assert.throws(
    () => payloadOf(equipment, 'target-temperature', 115, { ...cap, fahrenheit: false }),
    /not report this account in °F/,
  );
  assert.throws(
    () => payloadOf(bySerial(IDS.hvac), 'heat-setpoint', 66, { fahrenheit: false }),
    /°F/,
  );
  assert.deepEqual(payloadOf(equipment, 'mode', 2), { '@MODE': 2 });
  assert.throws(() => payloadOf(equipment, 'heating', 1), /cannot be controlled/);
  assert.throws(() => payloadOf(equipment, 'alerts', 0), /cannot be controlled/);
});

test('a thermostat', () => {
  const equipment = bySerial(IDS.hvac);
  const device = buildDevice(gladys, equipment, 'en');
  assert.equal(device.external_id, 'ext:test:thermostat:q0320hvac');
  assert.deepEqual(keys(device), [
    'temperature',
    'humidity',
    'heat-setpoint',
    'cool-setpoint',
    'thermostat-mode',
    'system-mode',
    'operating-state',
    'fan-speed',
    'alerts',
  ]);
  assert.deepEqual(
    feature(device, 'thermostat-mode').supported_options.map((o) => [o.value, o.label]),
    [
      [1, 'Heating'],
      [2, 'Cooling'],
      [3, 'Auto'],
      [0, 'Off'],
    ],
  );
  assert.deepEqual(
    feature(device, 'system-mode').supported_options.map((o) => o.value),
    ['heating', 'cooling', 'auto', 'fan-only', 'off', 'emergency-heat'],
  );
  assert.deepEqual(
    feature(device, 'fan-speed').supported_options.map((o) => o.value),
    [0, 1, 2, 3, 4, 5],
  );
  const heat = feature(device, 'heat-setpoint');
  assert.deepEqual(
    [heat.category, heat.unit, heat.min, heat.max],
    ['thermostat', 'fahrenheit', 50, 90],
  );
  assert.deepEqual(statesOf(equipment), [
    ['temperature', { state: 72 }],
    ['humidity', { state: 48 }],
    ['heat-setpoint', { state: 68 }],
    ['cool-setpoint', { state: 70 }],
    ['thermostat-mode', { state: 1 }],
    ['system-mode', { text: 'heating' }],
    ['operating-state', { state: 0 }],
    ['fan-speed', { state: 0 }],
    ['alerts', { state: 0 }],
  ]);
  // Emergency heat and fan only have no Gladys mode: heating and off are shown.
  const emergency = {
    ...equipment,
    info: { ...equipment.info, '@MODE': { ...equipment.info['@MODE'], value: 5 } },
  };
  const states = Object.fromEntries(statesOf(emergency));
  assert.deepEqual(states['thermostat-mode'], { state: 1 });
  assert.deepEqual(states['system-mode'], { text: 'emergency-heat' });
});

test('thermostat commands', () => {
  const equipment = bySerial(IDS.hvac);
  assert.deepEqual(payloadOf(equipment, 'heat-setpoint', 66), { '@HEATSETPOINT': 66 });
  assert.throws(() => payloadOf(equipment, 'heat-setpoint', 95), /between 50 and 90/);
  assert.deepEqual(payloadOf(equipment, 'cool-setpoint', 76), { '@COOLSETPOINT': 76 });
  assert.deepEqual(payloadOf(equipment, 'thermostat-mode', 2), { '@MODE': 1 });
  assert.deepEqual(payloadOf(equipment, 'thermostat-mode', 0), { '@MODE': 4 });
  assert.deepEqual(payloadOf(equipment, 'system-mode', 'fan-only'), { '@MODE': 3 });
  assert.throws(() => payloadOf(equipment, 'system-mode', 'turbo'), /no mode/);
  assert.deepEqual(payloadOf(equipment, 'fan-speed', 4), { '@FANSPEED': 4 });
  assert.throws(() => payloadOf(equipment, 'fan-speed', 7), /no fan speed/);
  assert.throws(() => payloadOf(equipment, 'fan-mode', 'on'), /no fan mode/);
  assert.throws(() => payloadOf(equipment, 'temperature', 70), /cannot be controlled/);
  // In auto mode the setpoints keep the deadband (2 °F) between them.
  const auto = {
    ...equipment,
    info: { ...equipment.info, '@MODE': { ...equipment.info['@MODE'], value: 2 } },
  };
  assert.throws(() => payloadOf(auto, 'heat-setpoint', 69), /2 °F under the cooling one/);
  assert.deepEqual(payloadOf(auto, 'heat-setpoint', 68), { '@HEATSETPOINT': 68 });
  assert.throws(() => payloadOf(auto, 'cool-setpoint', 69), /2 °F above the heating one/);
});

test('fan mode select when the thermostat has one', () => {
  const equipment = bySerial(IDS.hvac);
  const withFan = {
    ...equipment,
    info: {
      ...equipment.info,
      '@FANMODE': { constraints: { enumText: ['Auto', 'On Continuous'] }, value: 1 },
    },
  };
  const device = buildDevice(gladys, withFan, 'fr');
  assert.deepEqual(
    feature(device, 'fan-mode').supported_options.map((o) => [o.value, o.label]),
    [
      ['auto', 'Auto'],
      ['on', 'Marche (continue)'],
    ],
  );
  assert.deepEqual(Object.fromEntries(statesOf(withFan))['fan-mode'], { text: 'on' });
  assert.deepEqual(payloadOf(withFan, 'fan-mode', 'auto'), { '@FANMODE': 0 });
});

test('hot water never written above 149 °F (65 °C); a lower unit limit wins', () => {
  const gen4 = bySerial(IDS.gen4); // limits 110–140
  // A unit that would accept up to 185 °F (85 °C), no scald warning.
  const wide = {
    ...gen4,
    info: {
      ...gen4.info,
      '@SETPOINT': { value: 120, constraints: { lowerLimit: 80, upperLimit: 185 } },
    },
  };
  const write = (equipment, value, options) =>
    payloadOf(equipment, 'target-temperature', value, options)['@SETPOINT'];
  // The default cap (149 °F) and the hard ceiling.
  assert.deepEqual(waterSetpointCap(wide.info, 149), { min: 80, max: 149 });
  assert.deepEqual(waterSetpointCap(wide.info, 185), { min: 80, max: 149 });
  assert.deepEqual(waterSetpointCap(wide.info, 1e9), { min: 80, max: 149 });
  assert.deepEqual(waterSetpointCap(wide.info, 148.7), { min: 80, max: 148 }, 'rounded down');
  const warned = { constraints: { lowerLimit: 80, upperLimit: 185, warning: [{ value: 170 }] } };
  assert.deepEqual(waterSetpointCap({ '@SETPOINT': warned }, undefined), { min: 80, max: 149 });
  // 149 °F (65.0 °C) passes; above, refused, whatever the cap given.
  assert.equal(write(wide, 149, { maxWaterSetpoint: 149 }), 149);
  assert.equal(write(wide, 149.4, { maxWaterSetpoint: 149 }), 149);
  assert.equal(write(wide, 149), 149, 'no cap given: 149 °F');
  for (const value of [149.5, 150, 160, 185]) {
    assert.throws(
      () => payloadOf(wide, 'target-temperature', value, { maxWaterSetpoint: 185 }),
      /limited to 149 °F \(65 °C\); Gladys never sets more/,
      `${value} °F`,
    );
  }
  // The value read back from the unit (set higher in the app) is never resent.
  const high = {
    ...wide,
    info: { ...wide.info, '@SETPOINT': { ...wide.info['@SETPOINT'], value: 160 } },
  };
  assert.throws(
    () => payloadOf(high, 'target-temperature', numberOf(high.info['@SETPOINT']), {}),
    /limited to 149 °F/,
  );
  // A lower ceiling of the configuration, and a lower limit of the unit, win.
  assert.equal(write(wide, 130, { maxWaterSetpoint: 130 }), 130);
  assert.throws(
    () => write(wide, 131, { maxWaterSetpoint: 130 }),
    /limited to 130 °F \(54\.4 °C\)/,
  );
  assert.equal(write(gen4, 140, { maxWaterSetpoint: 149 }), 140);
  assert.throws(() => write(gen4, 145, { maxWaterSetpoint: 149 }), /limited to 140 °F/);
  // Every value that leaves is 65.0 °C at most once converted.
  for (let f = 80; f <= 185; f += 0.5) {
    let sent;
    try {
      sent = write(wide, f, { maxWaterSetpoint: 185 });
    } catch {
      continue;
    }
    assert.ok(sent <= 149 && ((sent - 32) * 5) / 9 <= 65, `${f} °F sent as ${sent}`);
  }
  // A unit whose floor is above 149 °F: nothing can be written.
  const hotFloor = {
    ...gen4,
    info: {
      ...gen4.info,
      '@SETPOINT': { value: 155, constraints: { lowerLimit: 150, upperLimit: 185 } },
    },
  };
  assert.throws(() => write(hotFloor, 150), /limited to 149 °F/);
  // The feature offers the cap as its maximum.
  const device = buildDevice(gladys, wide, 'en', { maxWaterSetpoint: 185 });
  assert.equal(feature(device, 'target-temperature').max, 149);
  assert.equal(feature(device, 'target-temperature').unit, 'fahrenheit');
});
