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
// here: 10 s doubled up to 5 min, ±25 % at random, the count starting again
// only after 60 s of a stable link. The user token is never logged.
// -----------------------------------------------------------------------------

import mqtt from 'mqtt';
import { ECONET, LIMITS, TIMINGS } from './constants.js';

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

/** A delay spread by ±TIMINGS.jitter (`random` in 0..1). */
export const jittered = (ms, random = Math.random) =>
  Math.round(ms * (1 - TIMINGS.jitter + 2 * TIMINGS.jitter * random()));

export class LiveLink {
  /**
   * @param {object} options
   * @param {() => Promise<{ userToken: string, accountId: string, email: string }>} options.session
   *   a valid session (logs in when needed)
   * @param {(update: object, topic: 'reported' | 'desired') => void} options.onUpdate
   *   a message of an equipment
   * @param {() => void} [options.onChange] the link went up or down
   * @param {(err: Error) => void} [options.onRefused] the credentials were refused: no retry
   * @param {(token: string) => number | void} [options.onTokenRefused] the broker refused
   *   the user token; a number is the least wait before the next attempt
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
    random = Math.random,
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
    this.random = random;
    this.client = undefined;
    this.connected = false;
    this.accountId = undefined;
    this.failures = 0;
    this.timer = undefined;
    this.stableTimer = undefined;
    this.holdOff = 0;
    this.running = false;
    /** When the next attempt is due (ms), for the status message. */
    this.nextAttempt = undefined;
    /** Commands sent by this process, for unique transaction ids. */
    this.sent = 0;
  }

  get topics() {
    return [`user/${this.accountId}/device/reported`, `user/${this.accountId}/device/desired`];
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.safeOpen();
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
    this.clearStable();
    client?.removeAllListeners?.();
    // A late error of the closed client must not crash the process.
    client?.on?.('error', () => {});
    client?.end?.(true);
  }

  clearStable() {
    if (this.stableTimer) {
      this.timers.clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  /** The delay before the next attempt (10 s, doubled each time, 5 min at most, ±25 %). */
  retryDelay() {
    const base = Math.min(
      TIMINGS.retryMin * 2 ** Math.min(this.failures, 10),
      TIMINGS.liveRetryMax,
    );
    return jittered(base, this.random);
  }

  /** Plans the next attempt; `err.retryAfter` (a 429 pause) and a hold-off are waited for. */
  retry(err) {
    if (!this.running) {
      return;
    }
    const wait = Math.max(this.retryDelay(), err?.retryAfter ?? 0, this.holdOff);
    this.holdOff = 0;
    this.failures += 1;
    this.nextAttempt = this.now() + wait;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.safeOpen();
    }, wait);
  }

  /** open(), whose unexpected failures end in a retry rather than a dead link. */
  safeOpen() {
    this.open().catch((err) => {
      this.logger?.warn?.(`EcoNet live events: ${String(err?.message ?? err).slice(0, 120)}`);
      if (this.client) {
        this.close();
      }
      this.retry(err);
      this.onChange();
    });
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
      this.retry(err);
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
        this.nextAttempt = undefined;
        // The backoff starts again only once the link held for a while.
        this.clearStable();
        this.stableTimer = this.timers.setTimeout(() => {
          this.stableTimer = undefined;
          if (this.client === client && this.connected) {
            this.failures = 0;
          }
        }, TIMINGS.liveStable);
        this.logger?.info?.('EcoNet live events connected');
        this.onChange();
      });
    });
    client.on('message', (topic, payload) => this.message(topic, payload));
    client.on('error', (err) => {
      // MQTT.js errors carry no credentials; the token is never logged.
      this.logger?.warn?.(`EcoNet live events: ${String(err?.message ?? err).slice(0, 120)}`);
      if (authRefused(err)) {
        const wait = this.onTokenRefused(token);
        if (Number.isFinite(wait)) {
          this.holdOff = Math.max(this.holdOff, wait);
        }
      }
    });
    client.on('close', () => {
      if (this.client !== client) {
        return;
      }
      const was = this.connected;
      this.client = undefined;
      this.connected = false;
      this.clearStable();
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
    const index = this.topics.indexOf(topic);
    if (index < 0 || !payload || payload.length > LIMITS.messageBytes) {
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
      this.onUpdate(update, index === 0 ? 'reported' : 'desired');
    } catch (err) {
      this.logger?.warn?.(`EcoNet live update not handled: ${err.message}`);
    }
  }

  /** A transaction id like the app's (`ANDROID_<date>`), made unique: milliseconds + counter. */
  transactionId() {
    this.sent += 1;
    return `ANDROID_${new Date(this.now()).toISOString().slice(0, 23)}_${this.sent}`;
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
      transactionId: this.transactionId(),
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
