// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

/**
 * The hard ceiling of the water setpoint (°F): 149 °F is exactly 65 °C
 * (Louis's rule: hot water never written above 65 °C). EcoNet setpoints are
 * whole °F, so a written value at or under 149 °F is at most 65.0 °C. Nothing
 * above it is ever written, whatever the configuration or the unit allows.
 */
export const WATER_SETPOINT_HARD_MAX = 149;

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  email: '',
  password: '',
  // Anti-scald cap of the water setpoint (°F): 149 °F (65 °C) by default and
  // at most; the user may lower it (120 °F = 49 °C is the usual safe value).
  max_water_setpoint: WATER_SETPOINT_HARD_MAX,
  language: 'fr',
};

/** Bounds of `max_water_setpoint` in the manifest (°F); the unit limits apply too. */
export const MAX_WATER_SETPOINT = { min: 80, max: WATER_SETPOINT_HARD_MAX };

/** °F -> °C (for the texts and the checks; EcoNet is read and written in °F). */
export const celsiusOf = (fahrenheit) => ((fahrenheit - 32) * 5) / 9;

export const LANGUAGES = ['fr', 'en'];

/**
 * @returns {{ email: string, password: string, maxWaterSetpoint: number,
 *   language: 'en' | 'fr', missing: string[] }} `missing` lists the fields
 *   still to fill in
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const c = { ...DEFAULTS, ...given };
  const email = String(c.email ?? '').trim();
  const password = String(c.password ?? '');
  const language = String(c.language ?? '')
    .trim()
    .toLowerCase();
  const cap = Number(c.max_water_setpoint);
  const missing = [];
  if (email === '') {
    missing.push('email');
  }
  if (password === '') {
    missing.push('password');
  }
  return {
    email,
    password,
    maxWaterSetpoint: Number.isFinite(cap)
      ? Math.floor(Math.max(MAX_WATER_SETPOINT.min, Math.min(MAX_WATER_SETPOINT.max, cap)))
      : DEFAULTS.max_water_setpoint,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
    missing,
  };
}
