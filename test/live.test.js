// -----------------------------------------------------------------------------
// The MQTT link on its own: an unexpected failure ends in a retry, the
// delays are spread at random, a 429 pause is waited for.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { LiveLink, jittered } from '../src/live.js';
import { settle } from './helpers/fakeEcoNet.js';

const session = async () => ({ userToken: 't', accountId: '1', email: 'a@b.c' });

test('the delays are spread by ±25 %', () => {
  assert.equal(
    jittered(10_000, () => 0),
    7500,
  );
  assert.equal(
    jittered(10_000, () => 0.5),
    10_000,
  );
  assert.equal(
    jittered(10_000, () => 1),
    12_500,
  );
});

test('a connection that throws is retried, never left dead', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const link = new LiveLink({
    session,
    onUpdate: () => {},
    random: () => 0.5,
    connect: () => {
      calls += 1;
      throw new Error('TLS setup failed');
    },
  });
  link.start();
  await settle();
  assert.equal(calls, 1);
  assert.equal(link.client, undefined);
  t.mock.timers.tick(TIMINGS.retryMin);
  await settle();
  assert.equal(calls, 2);
  link.stop();
});

test('a 429 pause of the session is waited for before the next attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const link = new LiveLink({
    session: async () => {
      calls += 1;
      const err = new Error('too many requests');
      err.kind = 'rate_limited';
      err.retryAfter = 15 * 60_000;
      throw err;
    },
    onUpdate: () => {},
    random: () => 0.5,
    connect: () => assert.fail('no connection without a session'),
  });
  link.start();
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(15 * 60_000 - 1);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls, 2);
  link.stop();
});
