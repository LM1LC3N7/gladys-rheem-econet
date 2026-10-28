import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celsiusOf, DEFAULTS, normalizeConfig, WATER_SETPOINT_HARD_MAX } from '../src/config.js';

test('defaults and missing fields', () => {
  assert.deepEqual(normalizeConfig(), {
    email: '',
    password: '',
    maxWaterSetpoint: 149,
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
    maxWaterSetpoint: 139,
    language: 'en',
    missing: [],
  });
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  // The anti-scald cap stays within the manifest bounds, rounded down; empty or wrong = 149 °F.
  assert.equal(normalizeConfig({ max_water_setpoint: 500 }).maxWaterSetpoint, 149);
  assert.equal(normalizeConfig({ max_water_setpoint: 185 }).maxWaterSetpoint, 149);
  assert.equal(normalizeConfig({ max_water_setpoint: 150 }).maxWaterSetpoint, 149);
  assert.equal(normalizeConfig({ max_water_setpoint: 149 }).maxWaterSetpoint, 149);
  assert.equal(normalizeConfig({ max_water_setpoint: 148.9 }).maxWaterSetpoint, 148);
  assert.equal(normalizeConfig({ max_water_setpoint: 10 }).maxWaterSetpoint, 80);
  assert.equal(normalizeConfig({ max_water_setpoint: '' }).maxWaterSetpoint, 149);
  assert.equal(normalizeConfig({ max_water_setpoint: 'hot' }).maxWaterSetpoint, 149);
});

test('149 °F is 65.0 °C: no whole °F at or under it converts above 65 °C', () => {
  assert.equal(WATER_SETPOINT_HARD_MAX, 149);
  assert.equal(celsiusOf(149), 65);
  assert.ok(celsiusOf(150) > 65, '150 °F would be 65.6 °C');
  for (let f = 80; f <= WATER_SETPOINT_HARD_MAX; f += 1) {
    assert.ok(celsiusOf(f) <= 65, `${f} °F`);
  }
});
