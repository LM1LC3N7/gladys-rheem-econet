// -----------------------------------------------------------------------------
// The REST client against the fake EcoNet cloud: login, user token renewal,
// errors, energy report. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECONET, TIMINGS } from '../src/constants.js';
import { EcoNetClient, EcoNetError, energyOf, httpError, retryAfterOf } from '../src/econet.js';
import { ACCOUNT, EMAIL, IDS, PASSWORD, read } from './fixtures/econet.js';
import { fakeEcoNet } from './helpers/fakeEcoNet.js';

const client = (server, options = {}) => {
  let now = 1_000_000;
  const c = new EcoNetClient({
    email: EMAIL,
    password: PASSWORD,
    transport: server.transport,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    spacing: 0,
    ...options,
  });
  c.advance = (ms) => {
    now += ms;
  };
  return c;
};

test('login with the headers of the app, then the equipment list', async () => {
  const server = fakeEcoNet();
  const c = client(server);
  const locations = await c.locations();
  assert.equal(locations[0].equiptments.length, 7);
  const [login, data] = server.requests;
  assert.equal(login.path, '/user/auth');
  assert.deepEqual(login.body, { email: EMAIL, password: PASSWORD });
  assert.equal(login.headers['ClearBlade-SystemKey'], ECONET.systemKey);
  assert.equal(login.headers['ClearBlade-UserToken'], undefined);
  assert.equal(data.path, `/code/${ECONET.systemKey}/getUserDataForApp`);
  assert.deepEqual(data.body, { resource: 'friedrich' });
  assert.equal(data.headers['ClearBlade-UserToken'], 'token-1');
  assert.equal(c.accountId, ACCOUNT);
  // The session is reused.
  await c.locations();
  assert.equal(server.logins().length, 1);
});

test('a refused password is a "refused" error, and concurrent calls share one login', async () => {
  const server = fakeEcoNet();
  server.password = 'other';
  const c = client(server);
  const results = await Promise.allSettled([c.locations(), c.locations()]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason.kind, 'refused');
    assert.doesNotMatch(r.reason.message, new RegExp(PASSWORD));
  }
  assert.equal(server.logins().length, 1);
  // HTTP 400/401 on the login endpoint are refusals too; 403 is a passing firewall.
  assert.equal(httpError(401, { auth: true }).kind, 'refused');
  assert.equal(httpError(403, { auth: true }).kind, 'unavailable');
  assert.equal(httpError(401).kind, 'unauthorized');
  assert.equal(httpError(503).kind, 'unavailable');
  assert.equal(httpError(429, { retryAfter: 5000 }).retryAfter, 5000);
});

test('a refused user token: one new login and the call again, never a loop', async () => {
  const server = fakeEcoNet();
  const c = client(server);
  await c.locations();
  c.advance(TIMINGS.reloginSpacing);
  server.tokens.clear();
  await c.locations();
  assert.equal(server.logins().length, 2);
  assert.equal(server.requests.at(-1).headers['ClearBlade-UserToken'], 'token-2');
  // The new token is refused at once: the login spacing doubles (10 min).
  server.tokens.clear();
  await assert.rejects(c.locations(), (err) => err.kind === 'unauthorized');
  await assert.rejects(c.locations(), (err) => err.kind === 'unauthorized');
  assert.equal(server.logins().length, 2);
  assert.equal(c.reloginSpacing, 10 * 60_000);
  c.advance(TIMINGS.reloginSpacing);
  await assert.rejects(c.locations(), (err) => err.kind === 'unauthorized');
  assert.equal(server.logins().length, 2, 'no login 5 minutes after a fresh token was refused');
  c.advance(TIMINGS.reloginSpacing);
  // The third token is refused too: 20 min.
  server.queue.push({ match: (r) => r.path.endsWith('getUserDataForApp'), status: 401 });
  await assert.rejects(c.locations(), (err) => err.kind === 'unauthorized');
  assert.equal(server.logins().length, 3);
  assert.equal(c.reloginSpacing, 20 * 60_000);
  // Then it works: back to 5 minutes after the first successful use.
  c.advance(20 * 60_000);
  await c.locations();
  assert.equal(server.logins().length, 4);
  assert.equal(c.reloginSpacing, TIMINGS.reloginSpacing);
});

test('the login spacing stops doubling at 6 hours', () => {
  const c = client(fakeEcoNet());
  for (let i = 0; i < 12; i += 1) {
    c.session = { userToken: `t${i}`, accountId: '1', at: c.now() };
    c.invalidate(`t${i}`);
  }
  assert.equal(c.reloginSpacing, TIMINGS.reloginSpacingMax);
});

test('a 429 pauses every request, the login included, without touching the network', async () => {
  const server = fakeEcoNet();
  const c = client(server);
  await c.locations();
  server.queue.push({
    match: (r) => r.path.endsWith('getUserDataForApp'),
    status: 429,
    headers: { 'retry-after': '60' },
  });
  await assert.rejects(
    c.locations(),
    (err) => err.kind === 'rate_limited' && err.retryAfter === TIMINGS.rateLimit,
    'what EcoNet asks, 15 min at least',
  );
  const sent = server.requests.length;
  c.advance(5 * 60_000);
  await assert.rejects(
    c.locations(),
    (err) => err.kind === 'rate_limited' && err.retryAfter === 10 * 60_000,
  );
  c.session = null;
  await assert.rejects(c.locations(), (err) => err.kind === 'rate_limited', 'the login waits too');
  assert.equal(server.requests.length, sent, 'nothing sent during the pause');
  c.advance(10 * 60_000);
  await c.locations();
  assert.equal(server.requests.length, sent + 2);
  // A longer Retry-After wins.
  server.queue.push({
    match: (r) => r.path.endsWith('/user/auth'),
    status: 429,
    headers: { 'retry-after': '3600' },
  });
  c.session = null;
  await assert.rejects(
    c.locations(),
    (err) => err.kind === 'rate_limited' && err.retryAfter === 3_600_000,
  );
});

test('errors: rate limit with Retry-After, outage, unreadable answers', async () => {
  const server = fakeEcoNet();
  const c = client(server);
  server.queue.push({
    match: (r) => r.path.endsWith('getUserDataForApp'),
    status: 502,
    body: '<html>',
  });
  await assert.rejects(c.locations(), (err) => err.kind === 'unavailable' && err.status === 502);
  server.queue.push({
    match: (r) => r.path.endsWith('getUserDataForApp'),
    body: { success: false },
  });
  await assert.rejects(c.locations(), (err) => err.kind === 'bad_response');
  server.queue.push({ match: (r) => r.path.endsWith('getUserDataForApp'), body: 'not json' });
  await assert.rejects(c.locations(), (err) => err.kind === 'bad_response');
  server.down = true;
  await assert.rejects(
    c.locations(),
    (err) => err instanceof EcoNetError && err.kind === 'network',
  );
  assert.equal(
    retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT', Date.UTC(2026, 9, 21, 7, 27, 0)),
    60_000,
  );
  assert.equal(retryAfterOf(''), null);
});

test('the daily energy of a water heater (the energy report of the app)', async () => {
  const server = fakeEcoNet();
  const c = client(server);
  const equipment = { serial: IDS.gen4.serial, deviceName: IDS.gen4.deviceName };
  assert.equal(await c.dailyEnergy(equipment, '2026-10-15'), 5.72);
  const request = server.paths('dynamicAction')[0].body;
  assert.deepEqual(request, {
    ACTION: 'waterheaterUsageReportView',
    device_name: IDS.gen4.deviceName,
    serial_number: IDS.gen4.serial,
    start_date: '2026-10-15T00:00:00.000',
    end_date: '2026-10-15T23:59:59.999',
    usage_type: 'energyUsage',
  });
  server.energy[IDS.gen4.serial] = null;
  await assert.rejects(c.dailyEnergy(equipment, '2026-10-15'), (err) => err.kind === 'unsupported');
  // Gas units report kBTU: not published.
  const gas = read('dynamic_action_energy_usage');
  gas.results.energy_usage.message = "<p>You've used <b>12</b> kBTU units of energy</p>";
  assert.equal(energyOf(gas), null);
  assert.equal(energyOf({ results: {} }), null);
});
