// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration and scenes), the EcoNet cloud constants and the tuning of the
// integration.
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/**
 * The EcoNet cloud: a ClearBlade platform hosted by Rheem. The system key and
 * secret identify the EcoNet app itself (not the user): they are the public
 * constants of pyeconet (w1ll1am23/pyeconet, MIT, src/pyeconet/api.py).
 */
export const ECONET = {
  host: 'rheem.rheemconnect.com',
  restPath: '/api/v/1',
  mqttPort: 1884,
  systemKey: 'e2e699cb0bb0bbb88fc8858cb5a401',
  systemSecret: 'E2E699CB0BE6C6FADDB1B0BC9A20',
};

/** Device types of the external ids: ext:<selector>:<type>:<serial number>. */
export const DEVICE_TYPES = {
  WATER_HEATER: 'water-heater',
  THERMOSTAT: 'thermostat',
};

/** Feature keys, the end of the feature external ids: never rename one. */
export const FEATURES = {
  // Water heaters.
  MODE: 'mode',
  SETPOINT: 'target-temperature',
  HOT_WATER: 'remaining-hot-water',
  HEATING: 'heating',
  VALVE: 'shutoff-valve',
  TANK_HEALTH: 'tank-health',
  COMPRESSOR_HEALTH: 'compressor-health',
  ENERGY_DAILY: 'energy-daily',
  // Thermostats.
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  HEAT_SETPOINT: 'heat-setpoint',
  COOL_SETPOINT: 'cool-setpoint',
  THERMOSTAT_MODE: 'thermostat-mode',
  SYSTEM_MODE: 'system-mode',
  OPERATING_STATE: 'operating-state',
  FAN_SPEED: 'fan-speed',
  FAN_MODE: 'fan-mode',
  // Both.
  ALERTS: 'alerts',
};

/** Gladys core values (server/utils/constants.js, the SDK does not export them). */
export const WATER_HEATER_MODE = {
  OFF: 0,
  AUTO: 1,
  ECO: 2,
  BOOST: 3,
  MANUAL: 4,
  AWAY: 5,
  PROGRAM: 6,
};
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };
export const AC_FAN_SPEED = {
  AUTO: 0,
  LOW: 1,
  LOW_MID: 2,
  MID: 3,
  MID_HIGH: 4,
  HIGH: 5,
  QUIET: 6,
  TURBO: 7,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Size of an EcoNet answer (bytes). */
  responseBytes: 4 * 1024 * 1024,
  /** Size of an MQTT message (bytes). */
  messageBytes: 256 * 1024,
  /** Equipments handled for one account. */
  equipments: 50,
  /** Days of daily energy published at each reading (the last elapsed ones). */
  energyDays: 3,
};

export const TIMINGS = {
  /** One HTTP request to the EcoNet API. */
  httpTimeout: 20_000,
  /** Minimum spacing of two HTTP requests. */
  requestSpacing: 500,
  /** Full reading of the account (the safety net of the live events). */
  refresh: 30 * 60_000,
  /** …while the live events are down. */
  refreshDegraded: 5 * 60_000,
  /** Daily energy of the water heaters that report it. */
  energy: 6 * 60 * 60_000,
  /** A refused user token is renewed by a new login at most this often. */
  reloginSpacing: 5 * 60_000,
  /** Delays of the retries (API and live events): doubled each time, up to the max. */
  retryMin: 10_000,
  retryMax: 30 * 60_000,
  /** HTTP 429 without Retry-After. */
  rateLimit: 15 * 60_000,
  /** MQTT. */
  mqttConnectTimeout: 30_000,
  mqttKeepalive: 60,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
};
