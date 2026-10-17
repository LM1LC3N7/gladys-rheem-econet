// -----------------------------------------------------------------------------
// The EcoNet equipments (pure): the list of the account, the merge of the
// live updates, what a water heater or a thermostat reports, and the payloads
// of its commands.
//
// Ported from pyeconet (w1ll1am23/pyeconet, MIT): api.py (_get_equipment,
// check_mode_enum), equipment/__init__.py (update_equipment_info),
// equipment/water_heater.py and equipment/thermostat.py. The EcoNet fields
// start with "@"; most are { value, status, constraints: { enumText,
// lowerLimit, upperLimit } }, and a live update may carry the bare value.
// -----------------------------------------------------------------------------

export const KINDS = { WATER_HEATER: 'WH', THERMOSTAT: 'HVAC' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, length = 100) => String(text ?? '').slice(0, length);

/**
 * pyeconet check_mode_enum: some units report a @MODE `value` that does not
 * match its `status`; the status wins (its index in enumText).
 */
export function fixModeEnum(field, enumText = field?.constraints?.enumText) {
  if (!isObject(field) || !Array.isArray(enumText) || typeof field.status !== 'string') {
    return field;
  }
  const index = enumText.indexOf(field.status);
  if (index >= 0 && index !== field.value) {
    return { ...field, value: index };
  }
  return field;
}

/** One equipment of the list: { serial, deviceName, kind, info }. */
function equipmentOf(raw) {
  if (!isObject(raw) || 'error' in raw) {
    return null;
  }
  const kind = raw.device_type;
  const serial = typeof raw.serial_number === 'string' ? raw.serial_number.trim() : '';
  if (![KINDS.WATER_HEATER, KINDS.THERMOSTAT].includes(kind) || serial === '') {
    return null;
  }
  const info = { ...raw };
  if (isObject(info['@MODE'])) {
    info['@MODE'] = fixModeEnum(info['@MODE']);
  }
  return {
    serial,
    deviceName: String(raw.device_name ?? ''),
    kind,
    info,
  };
}

/**
 * The equipments of the getUserDataForApp locations: water heaters,
 * thermostats and the zones of zoned thermostats (each zone has its own
 * serial number). Unknown types and equipments in error are left out.
 * @returns {{ equipments: object[], skipped: string[] }}
 */
export function equipmentsOf(locations) {
  const equipments = [];
  const skipped = [];
  const add = (raw) => {
    const equipment = equipmentOf(raw);
    if (!equipment) {
      skipped.push(clip(raw?.device_type ?? raw?.error ?? 'unknown', 40));
      return;
    }
    if (!equipments.some((e) => e.serial === equipment.serial)) {
      equipments.push(equipment);
    }
  };
  for (const location of Array.isArray(locations) ? locations : []) {
    // They spelled it wrong (pyeconet).
    for (const raw of Array.isArray(location?.equiptments) ? location.equiptments : []) {
      add(raw);
      if (raw?.device_type === KINDS.THERMOSTAT && Array.isArray(raw.zoning_devices)) {
        for (const zone of raw.zoning_devices) {
          add({ device_type: KINDS.THERMOSTAT, ...zone });
        }
      }
    }
  }
  return { equipments, skipped };
}

/**
 * pyeconet update_equipment_info: the "@" fields of a live update merged into
 * the equipment, a bare value going into the `value` of an object field.
 * @returns {{ info: object, changed: boolean }}
 */
export function mergeUpdate(info, update) {
  if (!isObject(update) || update.dialog !== undefined) {
    return { info, changed: false };
  }
  const next = { ...info };
  let changed = false;
  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith('@')) {
      continue;
    }
    const current = next[key];
    let merged;
    if (isObject(value)) {
      // pyeconet check_update_enum: the update alone is fixed (its own status,
      // the enumText of the equipment), never with the status kept from before.
      const fixed =
        key === '@MODE'
          ? fixModeEnum(value, value.constraints?.enumText ?? current?.constraints?.enumText)
          : value;
      merged = { ...(isObject(current) ? current : {}), ...fixed };
    } else if (isObject(current)) {
      if (current.value === undefined || current.value === null) {
        continue;
      }
      merged = { ...current, value };
    } else {
      merged = value;
    }
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      next[key] = merged;
      changed = true;
    }
  }
  return { info: changed ? next : info, changed };
}

/** The name the user gave the equipment in the app. */
export function nameOf(equipment) {
  const name = equipment.info['@NAME'];
  const text = isObject(name) ? name.value : name;
  return clip(typeof text === 'string' && text.trim() ? text.trim() : equipment.serial);
}

const numberOf = (field) => {
  const value = isObject(field) ? field.value : field;
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** { min, max } of a field with constraints, or null. */
export function limitsOf(field) {
  const c = field?.constraints;
  const min = Number(c?.lowerLimit);
  const max = Number(c?.upperLimit);
  return Number.isFinite(min) && Number.isFinite(max) && min <= max ? { min, max } : null;
}

// --- Water heaters --------------------------------------------------------------

/** The modes of pyeconet WaterHeaterOperationMode (aliases folded, as by_string does). */
export const WH_MODES = [
  'OFF',
  'ENERGY_SAVING',
  'HEAT_PUMP_ONLY',
  'HIGH_DEMAND',
  'PERFORMANCE',
  'ELECTRIC',
  'GAS',
  'VACATION',
];

const WH_ALIASES = {
  OFF: 'OFF',
  ELECTRIC_MODE: 'ELECTRIC',
  ELECTRIC: 'ELECTRIC',
  ENERGY_SAVING: 'ENERGY_SAVING',
  ENERGY_SAVER: 'ENERGY_SAVING',
  HEAT_PUMP_ONLY: 'HEAT_PUMP_ONLY',
  HEAT_PUMP: 'HEAT_PUMP_ONLY',
  HIGH_DEMAND: 'HIGH_DEMAND',
  GAS: 'GAS',
  PERFORMANCE: 'PERFORMANCE',
  VACATION: 'VACATION',
  ELECTRIC_GAS: 'ELECTRIC_GAS',
};

/** pyeconet WaterHeaterOperationMode.by_string, or null for an unknown text. */
export function waterHeaterModeOf(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/ /g, '_')
    .replace(/\//g, '_')
    .toUpperCase();
  return WH_ALIASES[cleaned] ?? null;
}

const isGas = (info) => ['gasWaterHeater', 'tanklessWaterHeater'].includes(info['@TYPE']);

/**
 * The modes of a water heater, in the order of the app: [{ mode, index }],
 * `index` being the @MODE enumText index (null for an @ENABLED-only mode).
 * "Electric/Gas" is the gas or the electric mode depending on the type.
 */
export function waterHeaterModes(info) {
  const modes = [];
  const enumText = info['@MODE']?.constraints?.enumText;
  if (Array.isArray(enumText)) {
    enumText.forEach((text, index) => {
      let mode = waterHeaterModeOf(text);
      if (mode === 'ELECTRIC_GAS') {
        mode = isGas(info) ? 'GAS' : 'ELECTRIC';
      }
      if (mode && !modes.some((m) => m.mode === mode)) {
        modes.push({ mode, index });
      }
    });
  }
  if (isObject(info['@ENABLED'])) {
    if (modes.length === 0) {
      modes.push(
        { mode: 'OFF', index: null },
        { mode: isGas(info) ? 'GAS' : 'ELECTRIC', index: null },
      );
    } else if (!modes.some((m) => m.mode === 'OFF')) {
      modes.push({ mode: 'OFF', index: null });
    }
  }
  return modes;
}

/** The current mode, or null when unknown (pyeconet WaterHeater.mode). */
export function waterHeaterMode(info) {
  const enabled = info['@ENABLED'];
  if (isObject(enabled) && enabled.value !== undefined && enabled.value !== 1) {
    return 'OFF';
  }
  const modes = waterHeaterModes(info);
  const mode = info['@MODE'];
  if (isObject(mode) && Array.isArray(mode.constraints?.enumText)) {
    return modes.find((m) => m.index !== null && m.index === mode.value)?.mode ?? null;
  }
  return modes.find((m) => m.mode !== 'OFF')?.mode ?? null;
}

/** The payload that puts a water heater in `mode` (pyeconet WaterHeater.set_mode), or null. */
export function waterHeaterModePayload(info, mode) {
  const payload = {};
  if (isObject(info['@ENABLED'])) {
    payload['@ENABLED'] = mode === 'OFF' ? 0 : 1;
  }
  const target = waterHeaterModes(info).find((m) => m.mode === mode);
  if (!target) {
    return null;
  }
  if (target.index !== null) {
    payload['@MODE'] = target.index;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

/** Hot water left, from the tank icon of the app (pyeconet tank_hot_water_availability). */
export function hotWaterOf(info) {
  const icon = info['@HOTWATER'];
  if (typeof icon !== 'string' || icon === '') {
    return null;
  }
  if (icon.includes('ic_tank_hundread_percent')) {
    return 100;
  }
  // The "fourty" icon is shown with "2/3rd full", the "ten" one with "1/3rd full".
  if (icon.includes('ic_tank_fourty_percent')) {
    return 66;
  }
  if (icon.includes('ic_tank_ten_percent')) {
    return 33;
  }
  if (icon.includes('ic_tank_empty') || icon.includes('ic_tank_zero_percent')) {
    return 0;
  }
  return null;
}

/** 1 when the water heater runs (heats), 0 when idle, null when unknown. */
export function runningOf(info) {
  const running = info['@RUNNING'];
  return typeof running === 'string' ? (running.trim() === '' ? 0 : 1) : null;
}

export const hasValve = (info) =>
  String(info['@VALVESTATUS']?.title ?? '').startsWith('Shut-OFF Valve - ');

/** 1 open, 0 closed, null unknown (pyeconet shutoff_valve_open). */
export function valveOf(info) {
  const title = info['@VALVESTATUS']?.title;
  if (title === 'Shut-OFF Valve - Open') {
    return 1;
  }
  if (title === 'Shut-OFF Valve - Closed') {
    return 0;
  }
  return null;
}

/** A 0–100 health value (@TANK, @COMBUSTION), or null. */
export function healthOf(field) {
  const n = numberOf(field);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

/** Whether the energy report of the app exists for this water heater, in kWh (not gas). */
export const hasEnergyReport = (info) =>
  Array.isArray(info.actions) &&
  info.actions.includes('waterheaterUsageReportView') &&
  !isGas(info);

// --- Thermostats -----------------------------------------------------------------

export const HVAC_MODES = ['HEATING', 'COOLING', 'AUTO', 'FAN_ONLY', 'OFF', 'EMERGENCY_HEAT'];

const HVAC_ALIASES = {
  OFF: 'OFF',
  HEATING: 'HEATING',
  COOLING: 'COOLING',
  AUTO: 'AUTO',
  FANONLY: 'FAN_ONLY',
  EMERGENCYHEAT: 'EMERGENCY_HEAT',
};

/** pyeconet ThermostatOperationMode.by_string, or null. */
export function thermostatModeOf(text) {
  return (
    HVAC_ALIASES[
      String(text ?? '')
        .trim()
        .replace(/ /g, '')
        .toUpperCase()
    ] ?? null
  );
}

export const FAN_SPEEDS = ['AUTO', 'LOW', 'MEDLO', 'MEDIUM', 'MEDHI', 'HIGH', 'MAX'];

/** pyeconet ThermostatFanSpeed.by_string, or null. */
export function fanSpeedOf(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/ /g, '_')
    .replace(/\./g, '')
    .toUpperCase();
  return FAN_SPEEDS.includes(cleaned) ? cleaned : null;
}

export const FAN_MODES = ['AUTO', 'ON_CONTINUOUS'];

/** pyeconet ThermostatFanMode.by_string, or null. */
export function fanModeOf(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/ /g, '_')
    .replace(/\./g, '')
    .replace(/\//g, '_')
    .toUpperCase();
  return FAN_MODES.includes(cleaned) ? cleaned : null;
}

/**
 * The options of an enum field (@MODE, @FANSPEED, @FANMODE): [{ option, index }]
 * in the order of the app, unknown texts left out.
 */
export function enumOptions(field, parse) {
  const options = [];
  const enumText = field?.constraints?.enumText;
  if (Array.isArray(enumText)) {
    enumText.forEach((text, index) => {
      const option = parse(text);
      if (option && !options.some((o) => o.option === option)) {
        options.push({ option, index });
      }
    });
  }
  return options;
}

/** A unit text meaning °F: "deg F", "F", "Fahrenheit" (the account's display unit too). */
export const FAHRENHEIT = /\bF\b|fahrenheit/i;

/**
 * Whether the temperature fields declare a unit other than °F
 * (`constraints.units`, "deg F" in every example); false when none says.
 */
export function notFahrenheit(info) {
  return ['@SETPOINT', '@HEATSETPOINT', '@COOLSETPOINT'].some((key) => {
    const units = info[key]?.constraints?.units;
    return typeof units === 'string' && units.trim() !== '' && !FAHRENHEIT.test(units);
  });
}

/** The texts of an enum field that `parse` does not know (logged once by the app). */
export function unknownTexts(field, parse) {
  const enumText = field?.constraints?.enumText;
  return Array.isArray(enumText)
    ? enumText.filter((text) => parse(text) === null).map((text) => clip(String(text).trim(), 40))
    : [];
}

/** The current option of an enum field, or null. */
export function enumValue(field, parse) {
  if (!isObject(field)) {
    return null;
  }
  return enumOptions(field, parse).find((o) => o.index === field.value)?.option ?? null;
}

/** The index to write for `option`, or null when the equipment does not have it. */
export function enumIndex(field, parse, option) {
  return enumOptions(field, parse).find((o) => o.option === option)?.index ?? null;
}

/** 0 idle, 1 heating, 2 cooling, null unknown (from the @RUNNINGSTATUS text). */
export function operatingStateOf(info) {
  const text = info['@RUNNINGSTATUS'];
  if (typeof text !== 'string') {
    return null;
  }
  if (/heat/i.test(text)) {
    return 1;
  }
  if (/cool/i.test(text)) {
    return 2;
  }
  return 0;
}

export { numberOf };
