// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  email: '',
  password: '',
  // Anti-scald cap of the water setpoint (°F): 120 °F (49 °C) is the usual
  // safe value; the user raises it (140 °F against legionella) on purpose.
  max_water_setpoint: 120,
  language: 'fr',
};

/** Bounds of `max_water_setpoint` in the manifest (°F); the unit limits apply too. */
export const MAX_WATER_SETPOINT = { min: 80, max: 185 };

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
      ? Math.round(Math.max(MAX_WATER_SETPOINT.min, Math.min(MAX_WATER_SETPOINT.max, cap)))
      : DEFAULTS.max_water_setpoint,
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
    missing,
  };
}
