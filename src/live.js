// -----------------------------------------------------------------------------
// The live events and the commands: MQTT over TLS to the ClearBlade broker of
// EcoNet (rheem.rheemconnect.com:1884), as the app and pyeconet do
// (w1ll1am23/pyeconet, MIT, api.py subscribe/publish): the user token as
// username, the system key of the app as password, the topics
// `user/<account id>/device/reported` (what the equipments report) and
// `user/<account id>/device/desired` (the commands, echoed). A command is a
// JSON message on the `desired` topic.
//
// MQTT.js (MIT) opens the connection with its own reconnection off: a new
// connection may need a new user token (login), so the delays are handled
// here. The user token is never logged.
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { ECONET, LIMITS, TIMINGS } from './constants.js';

/** The longest wait between two connection attempts. */
const RETRY_MAX = 5 * 60_000;

/** Opens one MQTT connection (the only MQTT network access). */
export function mqttConnect(options) {
  return mqtt.connect(`mqtts://${ECONET.host}:${ECONET.mqttPort}`, options);
}

/** CONNACK refusals meaning the token is not accepted (MQTT 3.1.1: 4 and 5). */
const authRefused = (err) =>
  err?.code === 4 || err?.code === 5 || /not authori[sz]ed|bad user ?name/i.test(err?.message);

/** The client id of the app: `<e-mail><13 digits>_android` (pyeconet _get_client_id). */
export function clientIdOf(email, now) {
  return `${email}${String(now).replace('.', '').slice(0, 13)}_android`;
}

export class LiveLink {
  /**
   * @param {object} options
   * @param {() => Promise<{ userToken: string, accountId: string, email: string }>} options.session
   *   a valid session (logs in when needed)
   * @param {(update: object) => void} options.onUpdate a message of an equipment
   * @param {() => void} [options.onChange] the link went up or down
   * @param {(err: Error) => void} [options.onRefused] the credentials were refused: no retry
   * @param {(token: string) => void} [options.onTokenRefused] the broker refused the user token
   */
  constructor({
    connect = mqttConnect,
    session,
    onUpdate,
    onChange = () => {},
    onRefused = () => {},
    onTokenRefused = () => {},
    logger,
    now = Date.now,
    timers = globalThis,
  }) {
    this.connectFn = connect;
    this.session = session;
    this.onUpdate = onUpdate;
    this.onChange = onChange;
    this.onRefused = onRefused;
    this.onTokenRefused = onTokenRefused;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.client = undefined;
    this.connected = false;
    this.accountId = undefined;
    this.failures = 0;
    this.timer = undefined;
    this.running = false;
    /** When the next attempt is due (ms), for the status message. */
    this.nextAttempt = undefined;
  }

  get topics() {
    return [`user/${this.accountId}/device/reported`, `user/${this.accountId}/device/desired`];
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.close();
  }

  close() {
    const { client } = this;
    this.client = undefined;
    this.connected = false;
    client?.removeAllListeners?.();
    // A late error of the closed client must not crash the process.
    client?.on?.('error', () => {});
    client?.end?.(true);
  }

  /** The delay before the next attempt (10 s, doubled each time, 5 min at most). */
  retryDelay() {
    return Math.min(TIMINGS.retryMin * 2 ** Math.min(this.failures, 10), RETRY_MAX);
  }

  retry() {
    if (!this.running) {
      return;
    }
    const wait = this.retryDelay();
    this.failures += 1;
    this.nextAttempt = this.now() + wait;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.open();
    }, wait);
  }

  async open() {
    if (!this.running || this.client) {
      return;
    }
    let session;
    try {
      session = await this.session();
    } catch (err) {
      if (!this.running) {
        return;
      }
      if (err?.kind === 'refused') {
        this.running = false;
        this.onRefused(err);
        return;
      }
      this.logger?.warn?.(`EcoNet live events: no session (${err?.message ?? err})`);
      this.retry();
      this.onChange();
      return;
    }
    if (!this.running || this.client) {
      return;
    }
    this.accountId = session.accountId;
    const token = session.userToken;
    const client = this.connectFn({
      clientId: clientIdOf(session.email, this.now()),
      username: token,
      password: ECONET.systemKey,
      protocolVersion: 4,
      clean: true,
      keepalive: TIMINGS.mqttKeepalive,
      reconnectPeriod: 0,
      connectTimeout: TIMINGS.mqttConnectTimeout,
      servername: ECONET.host,
    });
    this.client = client;
    client.on('connect', () => {
      client.subscribe(this.topics, { qos: 0 }, (err) => {
        if (this.client !== client) {
          return;
        }
        if (err) {
          this.logger?.warn?.('EcoNet live events: subscription refused');
          client.end(true);
          return;
        }
        this.connected = true;
        this.failures = 0;
        this.nextAttempt = undefined;
        this.logger?.info?.('EcoNet live events connected');
        this.onChange();
      });
    });
    client.on('message', (topic, payload) => this.message(topic, payload));
    client.on('error', (err) => {
      // MQTT.js errors carry no credentials; the token is never logged.
      this.logger?.warn?.(`EcoNet live events: ${String(err?.message ?? err).slice(0, 120)}`);
      if (authRefused(err)) {
        this.onTokenRefused(token);
      }
    });
    client.on('close', () => {
      if (this.client !== client) {
        return;
      }
      const was = this.connected;
      this.client = undefined;
      this.connected = false;
      client.removeAllListeners();
      client.on('error', () => {});
      if (was) {
        this.logger?.warn?.('EcoNet live events disconnected');
      }
      this.retry();
      this.onChange();
    });
  }

  message(topic, payload) {
    if (!this.topics.includes(topic) || !payload || payload.length > LIMITS.messageBytes) {
      return;
    }
    let update;
    try {
      update = JSON.parse(payload.toString('utf8'));
    } catch {
      this.logger?.debug?.('EcoNet live events: a message is not JSON');
      return;
    }
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      return;
    }
    try {
      this.onUpdate(update);
    } catch (err) {
      this.logger?.warn?.(`EcoNet live update not handled: ${err.message}`);
    }
  }

  /**
   * Sends a command (pyeconet publish): the payload with a transaction id,
   * the device name and the serial number of the equipment.
   */
  publish(equipment, payload) {
    const client = this.client;
    if (!client || !this.connected) {
      return Promise.reject(
        new Error('the live link to EcoNet is down: commands are unavailable for now'),
      );
    }
    const body = JSON.stringify({
      transactionId: `ANDROID_${new Date(this.now()).toISOString().slice(0, 19)}`,
      device_name: equipment.deviceName,
      serial_number: equipment.serial,
      ...payload,
    });
    return new Promise((resolve, reject) => {
      client.publish(this.topics[1], body, { qos: 0 }, (err) => {
        if (err) {
          reject(new Error(`command not sent (${String(err.message).slice(0, 80)})`));
        } else {
          resolve();
        }
      });
    });
  }
}
