// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  email: '',
  password: '',
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/**
 * @returns {{ email: string, password: string, language: 'en' | 'fr',
 *   missing: string[] }} `missing` lists the fields still to fill in
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined),
  );
  const c = { ...DEFAULTS, ...given };
  const email = String(c.email ?? '').trim();
  const password = String(c.password ?? '');
  const language = String(c.language ?? '')
    .trim()
    .toLowerCase();
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
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
    missing,
  };
}
