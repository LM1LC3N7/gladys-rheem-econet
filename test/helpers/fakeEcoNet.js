// -----------------------------------------------------------------------------
// A fake EcoNet cloud behind the transport and the MQTT connect function the
// integration is given: the login, getUserDataForApp and the energy report
// (dynamicAction), with the ClearBlade headers checked, and a broker that
// accepts the current user tokens. Records every request. No network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { ECONET } from '../../src/constants.js';
import { EcoNetError } from '../../src/econet.js';
import { ACCOUNT, EMAIL, PASSWORD, locations, read } from '../fixtures/econet.js';

const BASE = `https://${ECONET.host}${ECONET.restPath}`;

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

export function fakeEcoNet() {
  const server = {
    email: EMAIL,
    password: PASSWORD,
    locations: locations(),
    /** user token -> valid */
    tokens: new Set(),
    issued: 0,
    /** { path, body, headers } */
    requests: [],
    down: false,
    /** One-shot answers: { match(request), status, body, headers } */
    queue: [],
    /** serial -> { day -> kWh } (absent: the energy example) */
    energy: {},
    paths(name) {
      return this.requests.filter((r) => r.path.endsWith(name));
    },
    logins() {
      return this.paths('/user/auth');
    },
  };

  server.transport = async (url, { method, headers = {}, body } = {}) => {
    const path = url.slice(BASE.length);
    const request = { url, path, method, headers, body: body ? JSON.parse(body) : undefined };
    server.requests.push(request);
    if (server.down) {
      throw new EcoNetError('network', 'connection refused');
    }
    if (
      !url.startsWith(BASE) ||
      method !== 'POST' ||
      headers['ClearBlade-SystemKey'] !== ECONET.systemKey ||
      headers['ClearBlade-SystemSecret'] !== ECONET.systemSecret
    ) {
      return answer(400, { error: 'bad system key' });
    }
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [q] = server.queue.splice(forced, 1);
      return answer(q.status ?? 200, q.body ?? {}, q.headers);
    }
    if (path === '/user/auth') {
      const { email, password } = request.body;
      if (email !== server.email || password !== server.password) {
        return answer(200, { options: { success: false, message: 'Invalid credentials' } });
      }
      server.issued += 1;
      const token = `token-${server.issued}`;
      server.tokens.add(token);
      const auth = read('user_auth');
      return answer(200, { ...auth, user_token: token });
    }
    if (!server.tokens.has(headers['ClearBlade-UserToken'])) {
      return answer(401, { error: true, message: 'Invalid user token' });
    }
    if (path === `/code/${ECONET.systemKey}/getUserDataForApp`) {
      return answer(200, { results: { locations: server.locations }, success: true });
    }
    if (path === `/code/${ECONET.systemKey}/dynamicAction`) {
      const { serial_number: serial, start_date: start } = request.body;
      const kwh = server.energy[serial]?.[start.slice(0, 10)];
      if (server.energy[serial] === null) {
        return answer(200, { success: false });
      }
      const example = read('dynamic_action_energy_usage');
      if (kwh !== undefined) {
        example.results.energy_usage.data = [{ name: '1', value: kwh }];
      }
      return answer(200, example);
    }
    return answer(404, 'Not found');
  };

  return server;
}

/** A fake broker: `connect(options)` returns a client like MQTT.js. */
export function fakeMqtt(server, { autoConnect = true } = {}) {
  const mqtt = {
    /** { options, client } */
    connections: [],
    /** { topic, message } */
    published: [],
    refuseAll: false,
    connect(options) {
      const client = new EventEmitter();
      client.ended = false;
      client.subscriptions = [];
      client.subscribe = (topics, opts, cb) => {
        client.subscriptions.push(...[].concat(topics));
        setImmediate(() => cb?.(null, []));
      };
      client.publish = (topic, message, opts, cb) => {
        mqtt.published.push({ topic, message: JSON.parse(message) });
        setImmediate(() => cb?.(null));
      };
      client.end = () => {
        client.ended = true;
      };
      mqtt.connections.push({ options, client });
      if (autoConnect) {
        setImmediate(() => {
          if (client.ended) {
            return;
          }
          if (
            server.tokens.has(options.username) &&
            options.password === ECONET.systemKey &&
            !mqtt.refuseAll
          ) {
            client.emit('connect', { returnCode: 0 });
          } else {
            const err = new Error('Connection refused: Not authorized');
            err.code = 5;
            client.emit('error', err);
            client.emit('close');
          }
        });
      }
      return client;
    },
    live() {
      return mqtt.connections.filter((c) => !c.client.ended).at(-1)?.client;
    },
    /** A message of the broker on `reported` (or `desired`). */
    send(update, topic = `user/${ACCOUNT}/device/reported`) {
      mqtt.live().emit('message', topic, Buffer.from(JSON.stringify(update)));
    },
    /** The broker drops the connection. */
    drop() {
      const client = mqtt.live();
      client.ended = true;
      client.emit('close');
    },
  };
  return mqtt;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
