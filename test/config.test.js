import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('defaults and missing fields', () => {
  assert.deepEqual(normalizeConfig(), {
    email: '',
    password: '',
    maxWaterSetpoint: 120,
    language: DEFAULTS.language,
    missing: ['email', 'password'],
  });
  assert.deepEqual(normalizeConfig(null).missing, ['email', 'password']);
});

test('values are cleaned', () => {
  const config = normalizeConfig({
    email: '  me@example.com ',
    password: ' spaces kept ',
    max_water_setpoint: '139.6',
    language: 'EN',
  });
  assert.deepEqual(config, {
    email: 'me@example.com',
    password: ' spaces kept ',
    maxWaterSetpoint: 140,
    language: 'en',
    missing: [],
  });
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  // The anti-scald cap stays within the manifest bounds; empty or wrong = 120 °F.
  assert.equal(normalizeConfig({ max_water_setpoint: 500 }).maxWaterSetpoint, 185);
  assert.equal(normalizeConfig({ max_water_setpoint: 10 }).maxWaterSetpoint, 80);
  assert.equal(normalizeConfig({ max_water_setpoint: '' }).maxWaterSetpoint, 120);
  assert.equal(normalizeConfig({ max_water_setpoint: 'hot' }).maxWaterSetpoint, 120);
});
