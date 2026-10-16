import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('defaults and missing fields', () => {
  assert.deepEqual(normalizeConfig(), {
    email: '',
    password: '',
    language: DEFAULTS.language,
    missing: ['email', 'password'],
  });
  assert.deepEqual(normalizeConfig(null).missing, ['email', 'password']);
});

test('values are cleaned', () => {
  const config = normalizeConfig({
    email: '  me@example.com ',
    password: ' spaces kept ',
    language: 'EN',
  });
  assert.deepEqual(config, {
    email: 'me@example.com',
    password: ' spaces kept ',
    language: 'en',
    missing: [],
  });
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
