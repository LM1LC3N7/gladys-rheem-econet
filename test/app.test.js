// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake EcoNet cloud behind the transport and a fake MQTT broker.
// Timers and Date are mocked: the tests move the clock second by second.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EcoNetApp, energyDays } from '../src/app.js';
import { ACTIONS, ECONET, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { ACCOUNT, EMAIL, IDS, MINUTE, NOW, PASSWORD, read, update } from './fixtures/econet.js';
import { fakeEcoNet, fakeMqtt, settle } from './helpers/fakeEcoNet.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const WH = (id) => `ext:test-integration:water-heater:${id.serial.toLowerCase()}`;
const HVAC = (id) => `ext:test-integration:thermostat:${id.serial.toLowerCase()}`;

async function setup(t, { config = CONFIG, server = fakeEcoNet(), autoConnect = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const mqtt = fakeMqtt(server, { autoConnect });
  const lines = [];
  const logger = createLogger({ level: 'silent' });
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  const app = new EcoNetApp({
    gladys,
    logger,
    transport: server.transport,
    connect: (options) => mqtt.connect(options),
    now: () => Date.now(),
    spacing: 0,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      t.mock.timers.tick(1000);
      await settle(5);
    }
    await settle();
  };
  return { gladys, app, server, mqtt, advance, lines };
}

const deviceOf = (gladys, id) => gladys.fake.discoveredDevices.find((d) => d.external_id === id);
const featureOf = (gladys, device, key) =>
  deviceOf(gladys, device).features.find((f) => f.external_id === `${device}:${key}`);
const create = async (gladys, ...ids) => {
  for (const id of ids) {
    await gladys.fake.deviceCreated(deviceOf(gladys, id));
  }
  await settle();
};
const createAll = (gladys) =>
  create(gladys, ...gladys.fake.discoveredDevices.map((d) => d.external_id));
const last = (gladys, device, key) => gladys.fake.lastState(`${device}:${key}`);
const badgeOf = (gladys, device) =>
  gladys.fake.transports.filter((b) => b.device_external_id === device).at(-1);
const set = (gladys, device, key, value) =>
  gladys.fake.setValue(deviceOf(gladys, device), featureOf(gladys, device, key), value);

test('without credentials, the status asks for them and nothing is sent', async (t) => {
  const { gladys, server } = await setup(t, { config: {} });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /e-mail address and the password/);
  assert.equal(server.requests.length, 0);
});

test('start: login, equipment list, devices, then the live events', async (t) => {
  const { gladys, server, mqtt } = await setup(t);
  assert.equal(server.logins().length, 1);
  assert.equal(server.paths('getUserDataForApp').length, 1);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [WH(IDS.gen4), WH(IDS.gen5), WH(IDS.legacy), WH(IDS.gas), HVAC(IDS.hvac)],
  );
  assert.equal(featureOf(gladys, WH(IDS.gen4), 'mode').name, 'Mode');
  assert.equal(featureOf(gladys, WH(IDS.gen4), 'target-temperature').name, "Consigne de l'eau");
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /5 equipment\(s\), live updates on/);
  // One MQTT connection: the user token and the system key, the app's client id.
  assert.equal(mqtt.connections.length, 1);
  const { options, client } = mqtt.connections[0];
  assert.equal(options.username, 'token-1');
  assert.equal(options.password, ECONET.systemKey);
  assert.equal(options.reconnectPeriod, 0);
  assert.match(options.clientId, new RegExp(`^${EMAIL.replace('.', '\\.')}\\d{13}_android$`));
  assert.deepEqual(client.subscriptions, [
    `user/${ACCOUNT}/device/reported`,
    `user/${ACCOUNT}/device/desired`,
  ]);
});

test('states reach Gladys once the devices are created, live updates follow', async (t) => {
  const { gladys, mqtt } = await setup(t);
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  assert.equal(last(gladys, WH(IDS.gen4), 'target-temperature'), 132);
  assert.equal(last(gladys, WH(IDS.gen4), 'mode'), 1);
  assert.equal(last(gladys, WH(IDS.gen5), 'remaining-hot-water'), 100);
  assert.equal(last(gladys, HVAC(IDS.hvac), 'temperature'), 72);
  assert.equal(last(gladys, HVAC(IDS.hvac), 'system-mode'), 'heating');
  assert.equal(badgeOf(gladys, WH(IDS.gen4)).transport, DEVICE_TRANSPORTS.CLOUD);
  // A live report: running state and hot water (mqtt_running_reported).
  mqtt.send(update(IDS.gen4, { '@RUNNING': '', '@HOTWATER': 'ic_tank_ten_percent.png' }));
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 126 }), `user/${ACCOUNT}/device/desired`);
  await settle();
  await t.mock.timers.tick(TIMINGS.flushInterval);
  await settle();
  assert.equal(last(gladys, WH(IDS.gen4), 'heating'), 0);
  assert.equal(last(gladys, WH(IDS.gen4), 'target-temperature'), 126);
  // Another equipment with the same serial but another device name: ignored.
  mqtt.send({ ...update(IDS.gen4, { '@SETPOINT': 111 }), device_name: 'other' });
  // Another account's topic: ignored.
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 112 }), 'user/999/device/reported');
  await settle();
  await t.mock.timers.tick(TIMINGS.flushInterval);
  await settle();
  assert.equal(last(gladys, WH(IDS.gen4), 'target-temperature'), 126);
  // An equipment going offline: unreachable badge.
  mqtt.send(update(IDS.hvac, { '@CONNECTED': false }));
  await settle();
  assert.equal(badgeOf(gladys, HVAC(IDS.hvac)).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badgeOf(gladys, HVAC(IDS.hvac)).degraded, true);
});

test('commands go to the desired topic, checked first', async (t) => {
  const { gladys, mqtt } = await setup(t);
  await createAll(gladys);
  const ack = await set(gladys, WH(IDS.gen4), 'target-temperature', 125);
  assert.equal(ack.success, true);
  const [sent] = mqtt.published;
  assert.equal(sent.topic, `user/${ACCOUNT}/device/desired`);
  assert.equal(sent.message.device_name, IDS.gen4.deviceName);
  assert.equal(sent.message.serial_number, IDS.gen4.serial);
  assert.equal(sent.message['@SETPOINT'], 125);
  assert.match(sent.message.transactionId, /^ANDROID_2026-10-16T18:00:\d\d$/);
  await set(gladys, WH(IDS.gen5), 'mode', 0);
  assert.deepEqual(
    { enabled: mqtt.published[1].message['@ENABLED'], mode: mqtt.published[1].message['@MODE'] },
    { enabled: 0, mode: 0 },
  );
  await set(gladys, HVAC(IDS.hvac), 'fan-speed', 5);
  assert.equal(mqtt.published[2].message['@FANSPEED'], 5);
  // Out of range: refused with a message, nothing sent.
  const refused = await set(gladys, WH(IDS.gen4), 'target-temperature', 160);
  assert.equal(refused.success, false);
  assert.match(refused.error, /between 110 and 140/);
  assert.equal(mqtt.published.length, 3);
});

test('live events down: degraded badge, 5-min readings, no commands, reconnection', async (t) => {
  const { gladys, server, mqtt, advance } = await setup(t);
  await createAll(gladys);
  mqtt.drop();
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /live updates are down/);
  const badge = badgeOf(gladys, WH(IDS.gen4));
  assert.equal(badge.transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(badge.degraded, true);
  const refused = await set(gladys, WH(IDS.gen4), 'target-temperature', 125);
  assert.equal(refused.success, false);
  assert.match(refused.error, /live link to EcoNet is down/);
  // Reconnects after 10 s, then reads the account again.
  const before = server.paths('getUserDataForApp').length;
  await advance(10_000);
  assert.equal(mqtt.connections.length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await advance(1000);
  assert.equal(server.paths('getUserDataForApp').length, before + 1);
  assert.equal(badgeOf(gladys, WH(IDS.gen4)).degraded, undefined);
});

test('the broker refuses the token: a new login (spaced), then live again', async (t) => {
  const { server, mqtt, advance } = await setup(t);
  server.tokens.clear();
  mqtt.drop();
  await settle();
  // The refused token is dropped, but a login only 5 minutes after the last one.
  await advance(10_000);
  assert.equal(server.logins().length, 1);
  await advance(TIMINGS.reloginSpacing);
  assert.equal(server.logins().length, 2);
  assert.equal(mqtt.live().listenerCount('message') > 0, true);
  assert.equal(mqtt.connections.at(-1).options.username, 'token-2');
});

test('a refused password: status, no retry, until the configuration changes', async (t) => {
  const server = fakeEcoNet();
  server.password = 'changed';
  const { gladys, mqtt, advance } = await setup(t, { server });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the e-mail or the password/);
  await advance(60 * MINUTE);
  assert.equal(server.logins().length, 1);
  assert.equal(mqtt.connections.length, 0);
  // The test button tells the same, with one login.
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /refused/);
  assert.equal(server.logins().length, 2);
  // Fixed on the EcoNet side: the button restarts the integration.
  server.password = PASSWORD;
  const ok = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ok.data.message.en, /Connection OK: 5 equipment\(s\) \(Water Heater, /);
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('EcoNet unreachable: backoff, status, then recovery', async (t) => {
  const server = fakeEcoNet();
  server.down = true;
  const { gladys, advance } = await setup(t, { server });
  assert.match(gladys.fake.connectionStatus.message.en, /cannot be reached \(connection refused\)/);
  const attempts = () => server.logins().length;
  assert.equal(attempts(), 1);
  await advance(10_000);
  assert.equal(attempts(), 2);
  await advance(20_000);
  assert.equal(attempts(), 3);
  server.down = false;
  await advance(40_000);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.discoveredDevices.length, 5);
});

test('rate limit: waits what EcoNet asks, at least 15 minutes', async (t) => {
  const server = fakeEcoNet();
  server.queue.push({
    match: (r) => r.path.endsWith('getUserDataForApp'),
    status: 429,
    headers: { 'retry-after': '60' },
  });
  const { gladys, advance } = await setup(t, { server });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down\. Next attempt in 15 min/);
  await advance(14 * MINUTE);
  assert.equal(server.paths('getUserDataForApp').length, 1);
  await advance(MINUTE);
  assert.equal(server.paths('getUserDataForApp').length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('full readings every 30 minutes while live, energy every 6 hours', async (t) => {
  const { gladys, server, advance } = await setup(t);
  await createAll(gladys);
  await advance(1000);
  // Daily energy of the heat pumps (gen4, gen5), three elapsed days each.
  const days = energyDays(NOW);
  assert.deepEqual(days, ['2026-10-15', '2026-10-14', '2026-10-13']);
  const energy = gladys.fake.energyConsumption[`${WH(IDS.gen4)}:energy-daily`];
  assert.deepEqual(
    energy.map((s) => [s.created_at.slice(0, 10), s.kwh]),
    [
      ['2026-10-13', 5.72],
      ['2026-10-14', 5.72],
      ['2026-10-15', 5.72],
    ],
  );
  assert.equal(server.paths('dynamicAction').length, 6);
  assert.equal(gladys.fake.energyConsumption[`${WH(IDS.legacy)}:energy-daily`], undefined);
  await advance(TIMINGS.refresh);
  assert.equal(server.paths('getUserDataForApp').length, 2);
  // Six hours later only the last day is read again.
  await advance(TIMINGS.energy - TIMINGS.refresh);
  assert.equal(server.paths('dynamicAction').length, 8);
});

test('a scan reads the account again and publishes the devices', async (t) => {
  const { gladys, server } = await setup(t);
  server.locations[0].equiptments.splice(3, 1);
  await gladys.fake.scanRequest();
  await settle();
  assert.equal(server.paths('getUserDataForApp').length, 2);
  assert.equal(gladys.fake.discoveredDevices.length, 4);
});

test('no secret in the logs', async (t) => {
  const { gladys, lines, mqtt, server } = await setup(t);
  await createAll(gladys);
  await set(gladys, WH(IDS.gen4), 'target-temperature', 125);
  server.tokens.clear();
  mqtt.drop();
  await settle();
  const all = lines.join('\n');
  for (const secret of [PASSWORD, 'token-1', EMAIL, ECONET.systemSecret]) {
    assert.ok(!all.includes(secret), `"${secret}" logged`);
  }
  assert.equal(read('user_auth').user_token.length > 0, true);
});
