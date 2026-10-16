// -----------------------------------------------------------------------------
// The REST side of the EcoNet cloud (ClearBlade, rheem.rheemconnect.com):
// the login with the e-mail and the password of the EcoNet app, the
// equipment list of the account (getUserDataForApp) and the "dynamic
// actions" (the energy report of a water heater). Commands never go through
// it: see src/live.js.
//
// Ported from pyeconet (w1ll1am23/pyeconet, MIT, src/pyeconet/api.py and
// equipment/water_heater.py): same endpoints, headers and payloads.
// The password, the user token and the headers are never logged nor put in an
// error message. The only HTTP network access of the integration.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { ECONET, LIMITS, TIMINGS } from './constants.js';

/**
 * A failed EcoNet call. `kind`:
 * - `refused`: the e-mail or the password was refused (never retried alone);
 * - `unauthorized`: the user token was refused (renewed by a new login);
 * - `rate_limited`: HTTP 429 (`retryAfter` in ms when the server said);
 * - `unavailable`: HTTP 403 (firewall) or 5xx;
 * - `unsupported`: a dynamic action the equipment does not have;
 * - `network`, `timeout`: no answer;
 * - `bad_response`, `size`: an answer that is not the expected JSON;
 * - `http`: any other HTTP status.
 */
export class EcoNetError extends Error {
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'EcoNetError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter ?? null;
  }
}

/** Errors worth a retry later, without any change of the configuration. */
export const isTransient = (err) => !(err instanceof EcoNetError) || err.kind !== 'refused';

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const clip = (text, length = 120) => String(text ?? '').slice(0, length);

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof EcoNetError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return clip(err?.message ?? err ?? 'error');
}

/**
 * One HTTPS request; resolves `{ status, headers, body }` whatever the status.
 * Settles once: a request destroyed for its size or its timeout may still end
 * or fail after that.
 */
export function httpRequest(
  url,
  {
    method = 'POST',
    headers = {},
    body,
    timeout = TIMINGS.httpTimeout,
    maxBytes = LIMITS.responseBytes,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const network = (err) =>
      new EcoNetError('network', NETWORK_REASONS[err?.code] ?? clip(err?.code ?? 'network error'));
    const all = { ...headers };
    if (body !== undefined) {
      all['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = https.request(new URL(url), { method, headers: all }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new EcoNetError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode ?? 0,
          headers: res.headers ?? {},
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, network(err)));
    });
    timer = setTimeout(() => {
      settle(
        reject,
        new EcoNetError('timeout', `no answer within ${Math.round(timeout / 1000)} s`),
      );
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, network(err)));
    req.end(body);
  });
}

/** Retry-After in seconds or as an HTTP date -> milliseconds, or null. */
export function retryAfterOf(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (text === '') {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** The error of a non-200 answer. `auth`: the answer of the login endpoint. */
export function httpError(status, { auth = false, retryAfter = null } = {}) {
  if (auth && (status === 400 || status === 401)) {
    return new EcoNetError('refused', 'e-mail or password refused by EcoNet', { status });
  }
  if (status === 401) {
    return new EcoNetError('unauthorized', 'user token refused', { status });
  }
  if (status === 429) {
    return new EcoNetError('rate_limited', 'too many requests', { status, retryAfter });
  }
  // 403 is what a firewall (CloudFront) answers: passing, never a refused password.
  if (status === 403 || status >= 500) {
    return new EcoNetError('unavailable', 'EcoNet is unavailable', { status });
  }
  return new EcoNetError('http', 'request failed', { status });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EcoNetClient {
  /**
   * @param {object} options
   * @param {string} options.email
   * @param {string} options.password
   * @param {Function} [options.transport] httpRequest (tests)
   * @param {() => number} [options.now]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {number} [options.spacing] minimum spacing of two requests (ms)
   * @param {object} [options.logger]
   */
  constructor({
    email,
    password,
    transport = httpRequest,
    now = Date.now,
    sleep = defaultSleep,
    spacing = TIMINGS.requestSpacing,
    logger,
  }) {
    this.email = email;
    this.password = password;
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
    this.spacing = spacing;
    this.logger = logger;
    this.baseUrl = `https://${ECONET.host}${ECONET.restPath}`;
    /** { userToken, accountId, at } | null — kept in memory only. */
    this.session = null;
    this.loggingIn = undefined;
    this.queue = Promise.resolve();
    this.notBefore = 0;
    /** Minimum time between a login and the next one, doubled while fresh tokens are refused. */
    this.reloginSpacing = TIMINGS.reloginSpacing;
    /** No request at all before this time (ms): EcoNet answered 429. */
    this.blockedUntil = 0;
  }

  get userToken() {
    return this.session?.userToken ?? null;
  }

  get accountId() {
    return this.session?.accountId ?? null;
  }

  /** The temperature unit of the account ("Fahrenheit" in every example), or null. */
  get displayUnit() {
    return this.session?.displayUnit ?? null;
  }

  /** Whether the session is younger than the base login spacing (a refusal is then suspicious). */
  isFresh(token) {
    return (
      Boolean(this.session) &&
      (token === undefined || this.session.userToken === token) &&
      this.now() - this.session.at < TIMINGS.reloginSpacing
    );
  }

  /**
   * Forgets a refused user token: the next call logs in again, once the login
   * spacing is over. A token refused minutes after the login it came from
   * doubles that spacing (5, 10, 20 min… 6 h at most): a new login would not
   * fix it, and EcoNet must not see a loop of logins.
   */
  invalidate(token) {
    if (!this.session || (token !== undefined && this.session.userToken !== token)) {
      return;
    }
    if (this.session.stale) {
      return;
    }
    if (this.isFresh()) {
      this.reloginSpacing = Math.min(this.reloginSpacing * 2, TIMINGS.reloginSpacingMax);
      this.logger?.warn?.(
        `EcoNet refused a token it has just issued: next login in ${Math.round(this.reloginSpacing / 60_000)} min`,
      );
    }
    this.session = { ...this.session, stale: true };
  }

  /** The rate_limited error of a request made during a 429 pause. */
  blockedError() {
    return new EcoNetError('rate_limited', 'too many requests', {
      status: 429,
      retryAfter: Math.max(0, this.blockedUntil - this.now()),
    });
  }

  headers(authenticated) {
    const headers = {
      'ClearBlade-SystemKey': ECONET.systemKey,
      'ClearBlade-SystemSecret': ECONET.systemSecret,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
    };
    if (authenticated) {
      headers['ClearBlade-UserToken'] = this.session.userToken;
    }
    return headers;
  }

  /** Requests one after the other, `spacing` ms apart. */
  paced(fn) {
    const run = this.queue.then(async () => {
      const wait = this.notBefore - this.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
      this.notBefore = this.now() + this.spacing;
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** One POST -> { status, json, headers }; never logs the headers nor the body. */
  async post(path, payload, authenticated) {
    if (this.now() < this.blockedUntil) {
      throw this.blockedError();
    }
    const answer = await this.paced(() => {
      // Checked again: the pause may have started while this request waited.
      if (this.now() < this.blockedUntil) {
        throw this.blockedError();
      }
      return this.transport(this.baseUrl + path, {
        method: 'POST',
        headers: this.headers(authenticated),
        body: JSON.stringify(payload),
      });
    });
    if (answer.status === 429) {
      // Every request waits, the logins included: what EcoNet asks, 15 min at least.
      const asked = retryAfterOf(answer.headers?.['retry-after'], this.now()) ?? 0;
      this.blockedUntil = this.now() + Math.max(asked, TIMINGS.rateLimit);
      this.logger?.debug?.(`EcoNet ${path.split('/').at(-1)} -> 429`);
      throw this.blockedError();
    }
    let json = null;
    if (answer.body) {
      try {
        json = JSON.parse(answer.body);
      } catch {
        json = null;
      }
    }
    this.logger?.debug?.(`EcoNet ${path.split('/').at(-1)} -> ${answer.status}`);
    return { status: answer.status, json, headers: answer.headers ?? {} };
  }

  async login() {
    const { status, json, headers } = await this.post(
      '/user/auth',
      { email: this.email, password: this.password },
      false,
    );
    if (status !== 200) {
      throw httpError(status, {
        auth: true,
        retryAfter: retryAfterOf(headers['retry-after'], this.now()),
      });
    }
    const options = json?.options;
    if (!options || typeof options !== 'object') {
      throw new EcoNetError('bad_response', 'EcoNet sent an unreadable login answer');
    }
    if (options.success !== true) {
      throw new EcoNetError('refused', 'e-mail or password refused by EcoNet');
    }
    if (typeof json.user_token !== 'string' || json.user_token === '') {
      throw new EcoNetError('bad_response', 'EcoNet sent no user token');
    }
    const accountId = options.account_id;
    if (accountId === undefined || accountId === null || String(accountId) === '') {
      throw new EcoNetError('bad_response', 'EcoNet sent no account id');
    }
    const unit = options.temperature_display_unit;
    this.session = {
      userToken: json.user_token,
      accountId: String(accountId),
      at: this.now(),
      displayUnit: typeof unit === 'string' && unit.trim() ? unit.trim().slice(0, 20) : null,
    };
    this.logger?.info?.('Logged in to EcoNet');
  }

  /** Logs in when there is no usable session; concurrent calls share one login. */
  ensureSession() {
    if (this.session && !this.session.stale) {
      return Promise.resolve();
    }
    if (this.session?.stale && this.now() - this.session.at < this.reloginSpacing) {
      // Never a loop of logins: one every 5 minutes at most (longer, see invalidate).
      return Promise.reject(new EcoNetError('unauthorized', 'user token refused'));
    }
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = undefined;
    });
    return this.loggingIn;
  }

  /** An authenticated call; a refused token is renewed (one login) and the call made again. */
  async call(path, payload) {
    await this.ensureSession();
    const used = this.session;
    let answer = await this.post(path, payload, true);
    if (answer.status === 401) {
      if (this.session === used) {
        this.invalidate(used.userToken);
      }
      await this.ensureSession();
      answer = await this.post(path, payload, true);
    }
    if (answer.status !== 200) {
      if (answer.status === 401) {
        this.invalidate(this.session?.userToken);
      }
      throw httpError(answer.status, {
        retryAfter: retryAfterOf(answer.headers['retry-after'], this.now()),
      });
    }
    if (!answer.json || typeof answer.json !== 'object') {
      throw new EcoNetError('bad_response', 'EcoNet sent an answer that is not JSON');
    }
    // The token works: back to the base spacing of the logins.
    this.reloginSpacing = TIMINGS.reloginSpacing;
    return answer.json;
  }

  /** The locations of the account, each with its `equiptments` (sic). */
  async locations() {
    const json = await this.call(`/code/${ECONET.systemKey}/getUserDataForApp`, {
      resource: 'friedrich',
    });
    const locations = json.success === true ? json.results?.locations : undefined;
    if (!Array.isArray(locations)) {
      throw new EcoNetError('bad_response', 'EcoNet sent no equipment list');
    }
    return locations;
  }

  /** A dynamic action; `unsupported` when EcoNet answers success: false. */
  async dynamicAction(payload) {
    const json = await this.call(`/code/${ECONET.systemKey}/dynamicAction`, payload);
    if (json.success !== true) {
      throw new EcoNetError('unsupported', 'action not supported by this equipment');
    }
    return json;
  }

  /**
   * The energy a water heater used on one day (kWh), from the hourly report
   * of the app; null when the report is not in kWh (gas: kBTU).
   * @param {{ deviceName: string, serial: string }} equipment
   * @param {string} day YYYY-MM-DD
   */
  async dailyEnergy(equipment, day) {
    const json = await this.dynamicAction({
      ACTION: 'waterheaterUsageReportView',
      device_name: equipment.deviceName,
      serial_number: equipment.serial,
      start_date: `${day}T00:00:00.000`,
      end_date: `${day}T23:59:59.999`,
      usage_type: 'energyUsage',
    });
    return energyOf(json);
  }
}

/** The kWh of an energy report: the sum of its values; null when not in kWh or unreadable. */
export function energyOf(json) {
  const report = json?.results?.energy_usage;
  const data = report?.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  // "<p>You've used <b>5.72</b> kWh units of energy</p>": pyeconet reads the 4th word.
  const unit = String(report.message ?? '')
    .split(' ')[3]
    ?.toUpperCase();
  if (unit !== undefined && unit !== 'KWH') {
    return null;
  }
  let total = 0;
  for (const item of data) {
    const value = Number(item?.value);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    total += value;
  }
  return Math.round(total * 1000) / 1000;
}
