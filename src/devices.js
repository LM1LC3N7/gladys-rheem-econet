// -----------------------------------------------------------------------------
// The Gladys device of an EcoNet equipment, its states, and the payloads of
// the commands its features take (pure).
//
// Water heater (device type `water-heater`), the features the unit reports:
//   - `mode`                 water-heater/mode: WATER_HEATER_MODE, the modes
//                            of the unit as supported_options (EcoNet names
//                            as labels, see MODE_VALUES);
//   - `target-temperature`   water-heater/target-temperature (°F, from the
//                            minimum of the unit up to the anti-scald cap of
//                            the configuration, `max_water_setpoint`);
//   - `remaining-hot-water`  water-heater/remaining-hot-water (%: 0, 33, 66,
//                            100, the tank icon of the app);
//   - `heating`              water-heater/heating (0/1, @RUNNING);
//   - `shutoff-valve`        opening-sensor/binary, READ ONLY
//                            (OPENING_SENSOR_STATE: 1 closed, 0 open), when a
//                            shut-off valve is installed: never commanded;
//   - `tank-health`, `compressor-health`  maintenance/life-remaining (%);
//   - `energy-daily`         energy-sensor/daily-consumption (kWh per day,
//                            from the energy report of the app);
//   - `alerts`               counter-sensor/integer (@ALERTCOUNT).
// Thermostat (device type `thermostat`, each zone of a zoned system too):
//   - `temperature`          temperature-sensor/decimal (°F; EcoNet reports
//                            the room temperature in @SETPOINT, as pyeconet
//                            and Home Assistant read it);
//   - `humidity`             humidity-sensor/decimal (%);
//   - `heat-setpoint`, `cool-setpoint`  thermostat/target-temperature (°F);
//   - `thermostat-mode`      thermostat/mode: THERMOSTAT_MODE (off, heating,
//                            cooling, auto);
//   - `system-mode`          text/select: every EcoNet mode, fan only and
//                            emergency heat included (no Gladys value);
//   - `operating-state`      thermostat/operating-state (idle, heating,
//                            cooling, from @RUNNINGSTATUS);
//   - `fan-speed`            air-conditioning/fan-speed: AC_FAN_SPEED;
//   - `fan-mode`             text/select: auto / on (continuous);
//   - `alerts`               counter-sensor/integer.
// Feature external ids end with the keys of constants.js FEATURES: never
// rename one; the option values of the selects are frozen too (scenes).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AC_FAN_SPEED,
  DEVICE_TYPES,
  FEATURES,
  THERMOSTAT_MODE,
  WATER_HEATER_MODE,
} from './constants.js';
import {
  KINDS,
  enumIndex,
  enumOptions,
  enumValue,
  fanModeOf,
  fanSpeedOf,
  hasEnergyReport,
  hasValve,
  healthOf,
  hotWaterOf,
  limitsOf,
  nameOf,
  numberOf,
  operatingStateOf,
  runningOf,
  thermostatModeOf,
  unknownTexts,
  valveOf,
  waterHeaterMode,
  waterHeaterModeOf,
  waterHeaterModePayload,
  waterHeaterModes,
} from './equipment.js';
import { celsiusOf, DEFAULTS, WATER_SETPOINT_HARD_MAX } from './config.js';
import { texts } from './i18n.js';

/** A command Gladys cannot send: the message is shown to the user. */
export class UnsupportedError extends Error {}

const fail = (message) => {
  throw new UnsupportedError(message);
};

/** The anti-scald default of `max_water_setpoint` (°F): 149 °F = 65 °C. */
export const DEFAULT_MAX_WATER_SETPOINT = DEFAULTS.max_water_setpoint;

/**
 * The highest water setpoint Gladys may write: the `max_water_setpoint` of
 * the configuration (else the scald warning the unit reports, else 149 °F),
 * kept within the limits of the unit, never above 149 °F (65 °C), rounded
 * down. A lower limit of the unit always wins.
 */
export function waterSetpointCap(info, configured) {
  const field = info['@SETPOINT'];
  const limits = limitsOf(field) ?? { min: 90, max: 140 };
  const warnings = (Array.isArray(field?.constraints?.warning) ? field.constraints.warning : [])
    .map((w) => Number(w?.value))
    .filter(Number.isFinite);
  const wanted = Number.isFinite(configured)
    ? configured
    : warnings.length > 0
      ? Math.min(...warnings)
      : DEFAULT_MAX_WATER_SETPOINT;
  const max = Math.max(limits.min, Math.min(Math.floor(limits.max), Math.floor(wanted)));
  return {
    min: limits.min,
    // A unit whose floor is above 149 °F gets max < min: every write refused.
    max: Math.min(WATER_SETPOINT_HARD_MAX, max),
  };
}

/** Whether the heat pump flavour of the mode table applies. */
const isHeatPump = (info) =>
  waterHeaterModes(info).some((m) => m.mode === 'HEAT_PUMP_ONLY') ||
  /heatpump/i.test(String(info['@TYPE']));

/** EcoNet water heater mode -> Gladys WATER_HEATER_MODE (see modeValues). */
export function modeValueOf(mode, heatPump) {
  switch (mode) {
    case 'OFF':
      return WATER_HEATER_MODE.OFF;
    case 'ENERGY_SAVING':
      // On a heat pump, "Energy Saver" lets the unit pick heat pump or
      // elements (AUTO), ECO being "heat pump only"; on a plain tank it is ECO.
      return heatPump ? WATER_HEATER_MODE.AUTO : WATER_HEATER_MODE.ECO;
    case 'HEAT_PUMP_ONLY':
      return WATER_HEATER_MODE.ECO;
    case 'HIGH_DEMAND':
    case 'PERFORMANCE':
      return WATER_HEATER_MODE.BOOST;
    case 'ELECTRIC':
    case 'GAS':
      return WATER_HEATER_MODE.MANUAL;
    case 'VACATION':
      return WATER_HEATER_MODE.AWAY;
    default:
      return null;
  }
}

/** The modes of a water heater as [{ mode, value }], one EcoNet mode per Gladys value. */
export function modeValues(info) {
  const heatPump = isHeatPump(info);
  const values = [];
  for (const { mode } of waterHeaterModes(info)) {
    const value = modeValueOf(mode, heatPump);
    if (value !== null && !values.some((v) => v.value === value)) {
      values.push({ mode, value });
    }
  }
  return values;
}

/**
 * What the mode feature leaves out, for a log: EcoNet modes sharing a Gladys
 * value with an earlier one (not offered as commands, still shown), and mode
 * texts pyeconet does not know.
 */
export function modeReport(info) {
  const kept = modeValues(info).map((m) => m.mode);
  return {
    discarded: waterHeaterModes(info)
      .map((m) => m.mode)
      .filter((m) => !kept.includes(m)),
    unknown: unknownTexts(info['@MODE'], waterHeaterModeOf),
  };
}

/** Frozen option values of the selects. */
const SYSTEM_MODES = {
  HEATING: 'heating',
  COOLING: 'cooling',
  AUTO: 'auto',
  FAN_ONLY: 'fan-only',
  OFF: 'off',
  EMERGENCY_HEAT: 'emergency-heat',
};
const FAN_MODES = { AUTO: 'auto', ON_CONTINUOUS: 'on' };
const FAN_SPEEDS = {
  AUTO: AC_FAN_SPEED.AUTO,
  LOW: AC_FAN_SPEED.LOW,
  MEDLO: AC_FAN_SPEED.LOW_MID,
  MEDIUM: AC_FAN_SPEED.MID,
  MEDHI: AC_FAN_SPEED.MID_HIGH,
  HIGH: AC_FAN_SPEED.HIGH,
  MAX: AC_FAN_SPEED.TURBO,
};
/** EcoNet thermostat mode -> THERMOSTAT_MODE (the command side has only the four). */
const THERMOSTAT_MODES = {
  OFF: THERMOSTAT_MODE.OFF,
  HEATING: THERMOSTAT_MODE.HEATING,
  COOLING: THERMOSTAT_MODE.COOLING,
  AUTO: THERMOSTAT_MODE.AUTO,
};
/** …and the state shown for the two modes Gladys has no value for. */
const THERMOSTAT_STATE = {
  ...THERMOSTAT_MODES,
  EMERGENCY_HEAT: THERMOSTAT_MODE.HEATING,
  FAN_ONLY: THERMOSTAT_MODE.OFF,
};

const invert = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [String(v), k]));
const SYSTEM_MODE_OF = invert(SYSTEM_MODES);
const FAN_MODE_OF = invert(FAN_MODES);
const FAN_SPEED_OF = invert(FAN_SPEEDS);
const THERMOSTAT_MODE_OF = invert(THERMOSTAT_MODES);

/** The id of an equipment in the external ids: its serial number, kept to [a-z0-9_-]. */
export function equipmentId(equipment) {
  const id = String(equipment.serial ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return id || 'unknown';
}

const typeOf = (equipment) =>
  equipment.kind === KINDS.WATER_HEATER ? DEVICE_TYPES.WATER_HEATER : DEVICE_TYPES.THERMOSTAT;

export const idsOf = (gladys, equipment) =>
  gladys.externalIds(typeOf(equipment), equipmentId(equipment));

const command = (feature) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...feature,
});
const sensor = (feature) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...feature,
});

const has = (info, key) => info[key] !== undefined && info[key] !== null;

/** Whether a water heater gets the `energy-daily` feature. */
export const hasEnergy = (equipment) =>
  equipment.kind === KINDS.WATER_HEATER && hasEnergyReport(equipment.info);

/**
 * @param {object} gladys the SDK client (external ids)
 * @param {{ serial: string, kind: string, info: object }} equipment
 * @param {'en' | 'fr'} language
 * @param {{ maxWaterSetpoint?: number }} [options]
 */
export function buildDevice(gladys, equipment, language, { maxWaterSetpoint } = {}) {
  const { info } = equipment;
  const ids = idsOf(gladys, equipment);
  const t = texts(language);
  const named = (key, feature) => ({
    name: t.features[key],
    external_id: ids.feature(key),
    ...feature,
  });
  const options = (list, labels, valueOf) =>
    list.map((o, i) => ({ value: valueOf(o), label: labels[o] ?? o, sort_order: i }));
  const features = [];

  if (equipment.kind === KINDS.WATER_HEATER) {
    const modes = modeValues(info);
    if (modes.length > 0) {
      features.push(
        named(
          FEATURES.MODE,
          command({
            category: C.WATER_HEATER,
            type: TYPES.WATER_HEATER.MODE,
            min: WATER_HEATER_MODE.OFF,
            max: WATER_HEATER_MODE.PROGRAM,
            supported_options: modes.map((m, i) => ({
              value: m.value,
              label: t.options.waterHeaterMode[m.mode],
              sort_order: i,
            })),
          }),
        ),
      );
    }
    if (has(info, '@SETPOINT')) {
      // The anti-scald cap is the maximum Gladys offers.
      const limits = waterSetpointCap(info, maxWaterSetpoint);
      features.push(
        named(
          FEATURES.SETPOINT,
          command({
            category: C.WATER_HEATER,
            type: TYPES.WATER_HEATER.TARGET_TEMPERATURE,
            unit: U.FAHRENHEIT,
            ...limits,
          }),
        ),
      );
    }
    if (has(info, '@HOTWATER')) {
      features.push(
        named(
          FEATURES.HOT_WATER,
          sensor({
            category: C.WATER_HEATER,
            type: TYPES.WATER_HEATER.REMAINING_HOT_WATER,
            unit: U.PERCENT,
            min: 0,
            max: 100,
          }),
        ),
      );
    }
    if (typeof info['@RUNNING'] === 'string') {
      features.push(
        named(
          FEATURES.HEATING,
          sensor({ category: C.WATER_HEATER, type: TYPES.WATER_HEATER.HEATING, min: 0, max: 1 }),
        ),
      );
    }
    if (hasValve(info)) {
      // Read only: closing or opening the water from Gladys is not offered.
      features.push(
        named(
          FEATURES.VALVE,
          sensor({ category: C.OPENING_SENSOR, type: TYPES.SENSOR.BINARY, min: 0, max: 1 }),
        ),
      );
    }
    for (const [key, field] of [
      [FEATURES.TANK_HEALTH, '@TANK'],
      [FEATURES.COMPRESSOR_HEALTH, '@COMBUSTION'],
    ]) {
      if (has(info, field)) {
        features.push(
          named(
            key,
            sensor({
              category: C.MAINTENANCE,
              type: TYPES.MAINTENANCE.LIFE_REMAINING,
              unit: U.PERCENT,
              min: 0,
              max: 100,
            }),
          ),
        );
      }
    }
    if (hasEnergy(equipment)) {
      features.push(
        named(
          FEATURES.ENERGY_DAILY,
          sensor({
            category: C.ENERGY_SENSOR,
            type: TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
            unit: U.KILOWATT_HOUR,
            min: 0,
            max: 1000,
          }),
        ),
      );
    }
  } else {
    if (has(info, '@SETPOINT')) {
      features.push(
        named(
          FEATURES.TEMPERATURE,
          sensor({
            category: C.TEMPERATURE_SENSOR,
            type: TYPES.SENSOR.DECIMAL,
            unit: U.FAHRENHEIT,
            min: -40,
            max: 140,
          }),
        ),
      );
    }
    if (has(info, '@HUMIDITY')) {
      features.push(
        named(
          FEATURES.HUMIDITY,
          sensor({
            category: C.HUMIDITY_SENSOR,
            type: TYPES.SENSOR.DECIMAL,
            unit: U.PERCENT,
            min: 0,
            max: 100,
          }),
        ),
      );
    }
    for (const [key, field, fallback] of [
      [FEATURES.HEAT_SETPOINT, '@HEATSETPOINT', { min: 50, max: 90 }],
      [FEATURES.COOL_SETPOINT, '@COOLSETPOINT', { min: 52, max: 92 }],
    ]) {
      if (has(info, field)) {
        features.push(
          named(
            key,
            command({
              category: C.THERMOSTAT,
              type: TYPES.THERMOSTAT.TARGET_TEMPERATURE,
              unit: U.FAHRENHEIT,
              ...(limitsOf(info[field]) ?? fallback),
            }),
          ),
        );
      }
    }
    const modes = enumOptions(info['@MODE'], thermostatModeOf).map((o) => o.option);
    const gladysModes = modes.filter((m) => m in THERMOSTAT_MODES);
    if (gladysModes.length > 0) {
      features.push(
        named(
          FEATURES.THERMOSTAT_MODE,
          command({
            category: C.THERMOSTAT,
            type: TYPES.THERMOSTAT.MODE,
            min: THERMOSTAT_MODE.OFF,
            max: THERMOSTAT_MODE.AUTO,
            supported_options: options(
              gladysModes,
              t.options.thermostatMode,
              (m) => THERMOSTAT_MODES[m],
            ),
          }),
        ),
      );
    }
    if (modes.length > 0) {
      features.push(
        named(
          FEATURES.SYSTEM_MODE,
          command({
            category: C.TEXT,
            type: TYPES.TEXT.SELECT,
            keep_history: false,
            supported_options: options(modes, t.options.thermostatMode, (m) => SYSTEM_MODES[m]),
          }),
        ),
      );
    }
    if (typeof info['@RUNNINGSTATUS'] === 'string') {
      features.push(
        named(
          FEATURES.OPERATING_STATE,
          sensor({
            category: C.THERMOSTAT,
            type: TYPES.THERMOSTAT.OPERATING_STATE,
            min: 0,
            max: 2,
          }),
        ),
      );
    }
    const speeds = enumOptions(info['@FANSPEED'], fanSpeedOf).map((o) => o.option);
    if (speeds.length > 0) {
      features.push(
        named(
          FEATURES.FAN_SPEED,
          command({
            category: C.AIR_CONDITIONING,
            type: TYPES.AIR_CONDITIONING.FAN_SPEED,
            min: AC_FAN_SPEED.AUTO,
            max: AC_FAN_SPEED.TURBO,
            supported_options: options(speeds, t.options.fanSpeed, (s) => FAN_SPEEDS[s]),
          }),
        ),
      );
    }
    const fanModes = enumOptions(info['@FANMODE'], fanModeOf).map((o) => o.option);
    if (fanModes.length > 0) {
      features.push(
        named(
          FEATURES.FAN_MODE,
          command({
            category: C.TEXT,
            type: TYPES.TEXT.SELECT,
            keep_history: false,
            supported_options: options(fanModes, t.options.fanMode, (m) => FAN_MODES[m]),
          }),
        ),
      );
    }
  }
  if (has(info, '@ALERTCOUNT')) {
    features.push(
      named(
        FEATURES.ALERTS,
        sensor({ category: C.COUNTER_SENSOR, type: TYPES.SENSOR.INTEGER, min: 0, max: 100 }),
      ),
    );
  }
  return {
    name: nameOf(equipment),
    external_id: ids.device,
    model: String(
      info['@TYPE'] ?? (equipment.kind === KINDS.WATER_HEATER ? 'water-heater' : 'hvac'),
    ).slice(0, 60),
    features,
  };
}

/**
 * The states of an equipment, as [featureKey, { state } | { text }] pairs;
 * fields without a value are left out. The daily energy is not a state (see
 * the app: publishEnergyConsumption).
 */
export function statesOf(equipment) {
  const { info } = equipment;
  const states = [];
  const add = (key, value) => {
    if (value !== null && value !== undefined && !Number.isNaN(value?.state)) {
      states.push([key, value]);
    }
  };
  const num = (n) => (n === null ? null : { state: n });
  if (equipment.kind === KINDS.WATER_HEATER) {
    const mode = waterHeaterMode(info);
    // Even a mode left out of the options (it shares its Gladys value) is shown.
    add(FEATURES.MODE, num(mode ? modeValueOf(mode, isHeatPump(info)) : null));
    add(FEATURES.SETPOINT, num(numberOf(info['@SETPOINT'])));
    add(FEATURES.HOT_WATER, num(hotWaterOf(info)));
    add(FEATURES.HEATING, num(runningOf(info)));
    if (hasValve(info)) {
      // OPENING_SENSOR_STATE: 0 open, 1 closed.
      const open = valveOf(info);
      add(FEATURES.VALVE, num(open === null ? null : open === 1 ? 0 : 1));
    }
    add(FEATURES.TANK_HEALTH, num(has(info, '@TANK') ? healthOf(info['@TANK']) : null));
    add(
      FEATURES.COMPRESSOR_HEALTH,
      num(has(info, '@COMBUSTION') ? healthOf(info['@COMBUSTION']) : null),
    );
  } else {
    add(FEATURES.TEMPERATURE, num(numberOf(info['@SETPOINT'])));
    add(FEATURES.HUMIDITY, num(has(info, '@HUMIDITY') ? numberOf(info['@HUMIDITY']) : null));
    add(
      FEATURES.HEAT_SETPOINT,
      num(has(info, '@HEATSETPOINT') ? numberOf(info['@HEATSETPOINT']) : null),
    );
    add(
      FEATURES.COOL_SETPOINT,
      num(has(info, '@COOLSETPOINT') ? numberOf(info['@COOLSETPOINT']) : null),
    );
    const mode = enumValue(info['@MODE'], thermostatModeOf);
    add(FEATURES.THERMOSTAT_MODE, num(mode ? THERMOSTAT_STATE[mode] : null));
    add(FEATURES.SYSTEM_MODE, mode ? { text: SYSTEM_MODES[mode] } : null);
    add(FEATURES.OPERATING_STATE, num(operatingStateOf(info)));
    const speed = enumValue(info['@FANSPEED'], fanSpeedOf);
    add(FEATURES.FAN_SPEED, num(speed ? FAN_SPEEDS[speed] : null));
    const fanMode = enumValue(info['@FANMODE'], fanModeOf);
    add(FEATURES.FAN_MODE, fanMode ? { text: FAN_MODES[fanMode] } : null);
  }
  add(FEATURES.ALERTS, num(has(info, '@ALERTCOUNT') ? numberOf(info['@ALERTCOUNT']) : null));
  return states;
}

/** A whole number within the limits of a setpoint field, or an UnsupportedError. */
function setpoint(field, value, what) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) {
    fail(`the ${what} must be a number`);
  }
  const limits = limitsOf(field);
  if (!limits) {
    fail(`the ${what} limits of this equipment are unknown: try again after the next update`);
  }
  const rounded = Math.round(n);
  if (rounded < limits.min || rounded > limits.max) {
    fail(`the ${what} must be between ${limits.min} and ${limits.max} °F`);
  }
  return rounded;
}

/** °C of a °F value for the texts, one decimal (149 °F -> 65, 120 °F -> 48.9). */
const celsiusText = (fahrenheit) => String(Math.round(celsiusOf(fahrenheit) * 10) / 10);

/** The anti-scald refusal, in English and French. */
function scaldMessage(cap) {
  const c = celsiusText(cap);
  const top = WATER_SETPOINT_HARD_MAX;
  const tc = celsiusText(top);
  return cap < top
    ? `Scald risk: the water setpoint is limited to ${cap} °F (${c} °C). Raise "Maximum water setpoint" in the configuration to go higher (${top} °F = ${tc} °C at most). / ` +
        `Risque de brûlure : la consigne de l'eau est limitée à ${cap} °F (${c} °C). Relevez « Consigne maximale de l'eau » dans la configuration pour aller plus haut (${top} °F = ${tc} °C au plus).`
    : `Scald risk: the water setpoint is limited to ${cap} °F (${c} °C); Gladys never sets more. / ` +
        `Risque de brûlure : la consigne de l'eau est limitée à ${cap} °F (${c} °C) ; Gladys ne règle jamais plus.`;
}

/**
 * The EcoNet payload of a Gladys command ({ "@SETPOINT": 120 }…), checked
 * against what the equipment reports now. Throws UnsupportedError with a
 * message for the user (in English, like every command error; the
 * anti-scald refusal is in English and French).
 * @param {{ maxWaterSetpoint?: number, fahrenheit?: boolean }} [options]
 *   fahrenheit: false when the account may not report °F (setpoints refused)
 */
export function payloadOf(equipment, key, value, { maxWaterSetpoint, fahrenheit = true } = {}) {
  const { info } = equipment;
  const text = String(value ?? '').trim();
  const n = Number(value);
  const setpointKeys = [FEATURES.SETPOINT, FEATURES.HEAT_SETPOINT, FEATURES.COOL_SETPOINT];
  if (!fahrenheit && setpointKeys.includes(key)) {
    fail(
      'EcoNet does not report this account in °F: setpoints are refused until the unit is checked (set the EcoNet app to Fahrenheit)',
    );
  }
  if (equipment.kind === KINDS.WATER_HEATER) {
    switch (key) {
      case FEATURES.MODE: {
        const mode = modeValues(info).find((m) => m.value === n)?.mode;
        const payload = mode ? waterHeaterModePayload(info, mode) : null;
        if (!payload) {
          fail(`this water heater has no mode ${text}`);
        }
        return payload;
      }
      case FEATURES.SETPOINT: {
        const wanted = Number(value);
        const cap = waterSetpointCap(info, maxWaterSetpoint).max;
        const scald = () => fail(scaldMessage(cap));
        if (Number.isFinite(wanted) && Math.round(wanted) > cap) {
          scald();
        }
        const written = setpoint(info['@SETPOINT'], value, 'water setpoint');
        // Last check on the value that leaves: never above the cap, 149 °F,
        // nor 65.0 °C once converted.
        if (written > cap || written > WATER_SETPOINT_HARD_MAX || celsiusOf(written) > 65) {
          scald();
        }
        return { '@SETPOINT': written };
      }
      default:
        return fail(`${key} cannot be controlled`);
    }
  }
  const index = (field, parse, option, message) => {
    const i = option ? enumIndex(info[field], parse, option) : null;
    if (i === null) {
      fail(message);
    }
    return { [field]: i };
  };
  const deadband = numberOf(info['@DEADBAND']) ?? 0;
  const auto = enumValue(info['@MODE'], thermostatModeOf) === 'AUTO';
  switch (key) {
    case FEATURES.HEAT_SETPOINT: {
      const heat = setpoint(info['@HEATSETPOINT'], value, 'heating setpoint');
      const cool = numberOf(info['@COOLSETPOINT']);
      if (auto && cool !== null && heat > cool - deadband) {
        fail(
          `in auto mode the heating setpoint must stay ${deadband} °F under the cooling one (${cool} °F)`,
        );
      }
      return { '@HEATSETPOINT': heat };
    }
    case FEATURES.COOL_SETPOINT: {
      const cool = setpoint(info['@COOLSETPOINT'], value, 'cooling setpoint');
      const heat = numberOf(info['@HEATSETPOINT']);
      if (auto && heat !== null && cool < heat + deadband) {
        fail(
          `in auto mode the cooling setpoint must stay ${deadband} °F above the heating one (${heat} °F)`,
        );
      }
      return { '@COOLSETPOINT': cool };
    }
    case FEATURES.THERMOSTAT_MODE:
      return index(
        '@MODE',
        thermostatModeOf,
        THERMOSTAT_MODE_OF[String(n)],
        `this thermostat has no mode ${text}`,
      );
    case FEATURES.SYSTEM_MODE:
      return index(
        '@MODE',
        thermostatModeOf,
        SYSTEM_MODE_OF[text],
        `this thermostat has no mode ${text}`,
      );
    case FEATURES.FAN_SPEED:
      return index(
        '@FANSPEED',
        fanSpeedOf,
        FAN_SPEED_OF[String(n)],
        `this thermostat has no fan speed ${text}`,
      );
    case FEATURES.FAN_MODE:
      return index(
        '@FANMODE',
        fanModeOf,
        FAN_MODE_OF[text],
        `this thermostat has no fan mode ${text}`,
      );
    default:
      return fail(`${key} cannot be controlled`);
  }
}
