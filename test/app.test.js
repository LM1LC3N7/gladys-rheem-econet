// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake EcoNet cloud behind the transport and a fake MQTT broker.
// Timers and Date are mocked: the tests move the clock second by second. The
// random spread of the delays is fixed at its middle (no spread).
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
const DESIRED = `user/${ACCOUNT}/device/desired`;

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
    random: () => 0.5,
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
const statesOf = (gladys, device, key) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === `${device}:${key}`);
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
  // The anti-scald cap (120 °F by default) is the maximum of the setpoint.
  assert.equal(featureOf(gladys, WH(IDS.gen4), 'target-temperature').max, 120);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /5 equipment\(s\), live updates on/);
  // One MQTT connection: the user token and the system key, the app's client id.
  assert.equal(mqtt.connections.length, 1);
  const { options, client } = mqtt.connections[0];
  assert.equal(options.username, 'token-1');
  assert.equal(options.password, ECONET.systemKey);
  assert.equal(options.reconnectPeriod, 0);
  assert.match(options.clientId, new RegExp(`^${EMAIL.replace('.', '\\.')}\\d{13}_android$`));
  assert.deepEqual(client.subscriptions, [`user/${ACCOUNT}/device/reported`, DESIRED]);
});

test('states reach Gladys once the devices are created; only "reported" changes them', async (t) => {
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
  // The echo of a command on "desired" is not the state of the equipment.
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 115 }), DESIRED);
  await settle();
  await t.mock.timers.tick(TIMINGS.flushInterval);
  await settle();
  assert.equal(last(gladys, WH(IDS.gen4), 'heating'), 0);
  assert.equal(last(gladys, WH(IDS.gen4), 'remaining-hot-water'), undefined);
  assert.equal(last(gladys, WH(IDS.gen4), 'target-temperature'), 132);
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 126 }));
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

test('commands: desired topic, unique transaction ids, one at a time per equipment', async (t) => {
  const { gladys, mqtt, advance } = await setup(t);
  await createAll(gladys);
  const a = await set(gladys, WH(IDS.gen4), 'target-temperature', 118);
  assert.equal(a.success, true, 'Gladys gets its answer once the command is sent');
  // The next command of the same equipment waits for the report of the first.
  const pending = set(gladys, WH(IDS.gen4), 'mode', 2);
  await settle();
  assert.equal(mqtt.published.length, 1);
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 118 }));
  const b = await pending;
  assert.equal(b.success, true);
  const [first, second] = mqtt.published;
  assert.equal(first.topic, DESIRED);
  assert.equal(first.message.device_name, IDS.gen4.deviceName);
  assert.equal(first.message.serial_number, IDS.gen4.serial);
  assert.equal(first.message['@SETPOINT'], 118, 'in the order they were given');
  assert.equal(second.message['@MODE'], 2);
  assert.match(first.message.transactionId, /^ANDROID_2026-10-16T18:00:\d\d\.\d{3}_\d+$/);
  assert.notEqual(first.message.transactionId, second.message.transactionId);
  // Never reported: the queue is released after 30 s.
  const third = set(gladys, WH(IDS.gen4), 'mode', 4);
  await advance(TIMINGS.commandConfirm - 2000);
  assert.equal(mqtt.published.length, 2);
  await advance(3000);
  assert.equal((await third).success, true);
  assert.equal(mqtt.published.length, 3);
  assert.equal(mqtt.published[2].message['@MODE'], 4);
  mqtt.published.splice(2, 1);
  await set(gladys, WH(IDS.gen5), 'mode', 0);
  assert.deepEqual(
    { enabled: mqtt.published[2].message['@ENABLED'], mode: mqtt.published[2].message['@MODE'] },
    { enabled: 0, mode: 0 },
  );
  await set(gladys, HVAC(IDS.hvac), 'fan-speed', 5);
  assert.equal(mqtt.published[3].message['@FANSPEED'], 5);
  // Out of range: refused with a message, nothing sent (the queue of gen4 is
  // free once its last mode is reported).
  mqtt.send(update(IDS.gen4, { '@MODE': { value: 4 } }));
  const refused = await set(gladys, WH(IDS.gen4), 'target-temperature', 105);
  assert.equal(refused.success, false);
  assert.match(refused.error, /between 110 and 140/);
  assert.equal(mqtt.published.length, 4);
});

test('the anti-scald cap: above it, refused in English and French', async (t) => {
  const { gladys, mqtt } = await setup(t);
  await createAll(gladys);
  const refused = await set(gladys, WH(IDS.gen4), 'target-temperature', 125);
  assert.equal(refused.success, false);
  assert.match(refused.error, /Scald risk: the water setpoint is limited to 120 °F/);
  assert.match(refused.error, /Risque de brûlure/);
  assert.equal(mqtt.published.length, 0);
});

test('a raised cap (legionella): 140 °F allowed, the unit limit still applies', async (t) => {
  const { gladys, mqtt } = await setup(t, { config: { ...CONFIG, max_water_setpoint: 160 } });
  await createAll(gladys);
  assert.equal(featureOf(gladys, WH(IDS.gen4), 'target-temperature').max, 140);
  assert.equal((await set(gladys, WH(IDS.gen4), 'target-temperature', 140)).success, true);
  assert.equal(mqtt.published[0].message['@SETPOINT'], 140);
});

test('a command is confirmed by "reported", else logged and the state shown again', async (t) => {
  const { gladys, mqtt, advance, lines } = await setup(t);
  await createAll(gladys);
  await set(gladys, WH(IDS.gen4), 'target-temperature', 118);
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 118 }));
  await advance(TIMINGS.commandConfirm + 1000);
  assert.equal(last(gladys, WH(IDS.gen4), 'target-temperature'), 118);
  assert.ok(!lines.some((l) => /not confirmed/.test(l)));
  // Never reported: the last reported value is published again.
  const before = statesOf(gladys, WH(IDS.gen4), 'target-temperature').length;
  await set(gladys, WH(IDS.gen4), 'target-temperature', 115);
  mqtt.send(update(IDS.gen4, { '@SETPOINT': 115 }), DESIRED);
  await advance(TIMINGS.commandConfirm + 2000);
  assert.ok(lines.some((l) => /target-temperature not confirmed/.test(l)));
  const after = statesOf(gladys, WH(IDS.gen4), 'target-temperature');
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).state, 118);
});

test('commands refused for an offline equipment or an old state', async (t) => {
  const { gladys, app, mqtt } = await setup(t);
  await createAll(gladys);
  mqtt.send(update(IDS.hvac, { '@CONNECTED': false }));
  await settle();
  const offline = await set(gladys, HVAC(IDS.hvac), 'fan-speed', 5);
  assert.equal(offline.success, false);
  assert.match(offline.error, /offline/);
  app.entries.get(IDS.gen4.serial).updatedAt = Date.now() - TIMINGS.stateMaxAge - 1;
  const old = await set(gladys, WH(IDS.gen4), 'target-temperature', 118);
  assert.equal(old.success, false);
  assert.match(old.error, /too old/);
  assert.equal(mqtt.published.length, 0);
});

test('live events down: degraded badge, no commands, reconnection, catch-up within 5 min', async (t) => {
  const { gladys, server, mqtt, advance } = await setup(t);
  await createAll(gladys);
  mqtt.drop();
  await settle();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /live updates are down/);
  const badge = badgeOf(gladys, WH(IDS.gen4));
  assert.equal(badge.transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(badge.degraded, true);
  const refused = await set(gladys, WH(IDS.gen4), 'target-temperature', 118);
  assert.equal(refused.success, false);
  assert.match(refused.error, /live link to EcoNet is down/);
  // Reconnects after 10 s; the catch-up reading comes 5 min after the last one.
  await advance(10_000);
  assert.equal(mqtt.connections.length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(badgeOf(gladys, WH(IDS.gen4)).degraded, undefined);
  assert.equal(server.paths('getUserDataForApp').length, 1);
  await advance(5 * MINUTE);
  assert.equal(server.paths('getUserDataForApp').length, 2);
});

test('an unstable broker: the backoff grows until the link holds 60 s, one catch-up per 5 min', async (t) => {
  const { server, mqtt, advance } = await setup(t);
  const count = () => mqtt.connections.length;
  mqtt.drop(); // t = 0
  await advance(10_000);
  assert.equal(count(), 2);
  mqtt.drop(); // up for less than 60 s: the next wait doubles
  await advance(19_000);
  assert.equal(count(), 2);
  await advance(1000);
  assert.equal(count(), 3);
  mqtt.drop();
  await advance(39_000);
  assert.equal(count(), 3);
  await advance(1000);
  assert.equal(count(), 4);
  // Stable for 60 s: back to 10 s.
  await advance(60_000);
  mqtt.drop();
  await advance(10_000);
  assert.equal(count(), 5);
  assert.equal(server.paths('getUserDataForApp').length, 1, 'no reading at every reconnection');
  await advance(3 * MINUTE);
  assert.equal(server.paths('getUserDataForApp').length, 2);
  assert.equal(server.logins().length, 1);
});

test('the broker refuses a fresh token: live refused for 30 min, no login loop', async (t) => {
  const { gladys, server, mqtt, advance } = await setup(t);
  mqtt.refuseAll = true;
  mqtt.drop();
  await advance(10_000);
  assert.equal(mqtt.connections.length, 2);
  assert.equal(server.logins().length, 1, 'a token issued seconds ago is not expired');
  assert.match(gladys.fake.connectionStatus.message.en, /broker refuses the live updates.*30 min/);
  await advance(29 * MINUTE);
  assert.equal(mqtt.connections.length, 2);
  assert.equal(server.logins().length, 1);
  // 30 min later the token is old: one login (40 s later), refused again, 60 min.
  await advance(2 * MINUTE);
  assert.equal(server.logins().length, 2);
  assert.equal(mqtt.connections.length, 4);
  assert.match(gladys.fake.connectionStatus.message.en, /Next attempt in 60 min/);
  // The broker accepts again: back to normal.
  mqtt.refuseAll = false;
  await advance(60 * MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an older token refused by the broker: one new login, live again', async (t) => {
  const { server, mqtt, advance } = await setup(t);
  await advance(6 * MINUTE);
  server.tokens.clear();
  mqtt.drop();
  await advance(10_000);
  assert.equal(server.logins().length, 1);
  await advance(20_000);
  assert.equal(server.logins().length, 2);
  assert.equal(mqtt.connections.at(-1).options.username, 'token-2');
  assert.ok(mqtt.live());
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

test('rate limit: waits what EcoNet asks, at least 15 minutes, nothing sent meanwhile', async (t) => {
  const server = fakeEcoNet();
  server.queue.push({
    match: (r) => r.path.endsWith('getUserDataForApp'),
    status: 429,
    headers: { 'retry-after': '60' },
  });
  const { gladys, advance } = await setup(t, { server });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down\. Next attempt in 15 min/);
  const sent = server.requests.length;
  // The test button does not go around the pause.
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /slow down/);
  await advance(14 * MINUTE);
  assert.equal(server.requests.length, sent);
  await advance(MINUTE);
  assert.equal(server.paths('getUserDataForApp').length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a 429 during the energy reading stops it', async (t) => {
  const { gladys, server, advance } = await setup(t);
  server.queue.push({ match: (r) => r.path.endsWith('dynamicAction'), status: 429 });
  await createAll(gladys);
  await advance(1000);
  assert.equal(server.paths('dynamicAction').length, 1);
  await advance(14 * MINUTE);
  assert.equal(server.paths('dynamicAction').length, 1);
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

test('an account that may not be in °F: status, setpoints refused', async (t) => {
  const server = fakeEcoNet();
  server.displayUnit = 'Celsius';
  const { gladys, mqtt, lines } = await setup(t, { server });
  await createAll(gladys);
  assert.match(gladys.fake.connectionStatus.message.en, /may not report this account in °F/);
  const refused = await set(gladys, HVAC(IDS.hvac), 'heat-setpoint', 66);
  assert.equal(refused.success, false);
  assert.match(refused.error, /°F/);
  assert.equal((await set(gladys, HVAC(IDS.hvac), 'fan-speed', 5)).success, true);
  assert.equal(mqtt.published.length, 1);
  assert.equal(lines.filter((l) => /may not report °F/.test(l)).length, 1);
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
  const { gladys, lines, mqtt, server, advance } = await setup(t);
  await createAll(gladys);
  await set(gladys, WH(IDS.gen4), 'target-temperature', 118);
  server.tokens.clear();
  mqtt.drop();
  await advance(10 * MINUTE);
  const all = lines.join('\n');
  for (const secret of [PASSWORD, 'token-1', 'token-2', EMAIL, ECONET.systemSecret]) {
    assert.ok(!all.includes(secret), `"${secret}" logged`);
  }
  assert.equal(read('user_auth').user_token.length > 0, true);
});
