// -----------------------------------------------------------------------------
// The integration: one EcoNet account, its water heaters and thermostats as
// Gladys devices, their live state, the commands sent back, the daily energy
// and the status shown in Gladys. index.js only wires the SDK handlers to it
// (src/handlers.js).
//
//   start ─► login ─► equipment list (getUserDataForApp) ─► devices + states
//              └► live events: MQTT, user/<account>/device/reported|desired
//   timers: full reading (30 min, 5 min while the live events are down),
//   daily energy (6 h), retries with backoff and jitter. A refused password
//   is never retried by itself; a 429 pauses every request.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { FEATURES, LIMITS, TIMINGS } from './constants.js';
import { buildDevice, hasEnergy, idsOf, modeReport, payloadOf, statesOf } from './devices.js';
import { EcoNetClient, EcoNetError, errorReason } from './econet.js';
import {
  FAHRENHEIT,
  KINDS,
  equipmentsOf,
  mergeUpdate,
  nameOf,
  notFahrenheit,
} from './equipment.js';
import { T } from './i18n.js';
import { LiveLink, jittered } from './live.js';
import { StatePublisher } from './publisher.js';

const DAY = 24 * 3600_000;

/** YYYY-MM-DD of a time (UTC). */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The days whose energy is published: the last LIMITS.energyDays elapsed ones.
 * "Yesterday" is counted from 12 hours ago, so the day is over in the
 * timezones of North America (UTC-3 to UTC-10) when it is published.
 */
export function energyDays(now) {
  const base = now - 12 * 3600_000;
  return Array.from({ length: LIMITS.energyDays }, (_, i) => dayOf(base - (i + 1) * DAY));
}

/** Whether the equipment reports every value of a command payload. */
export function confirms(info, payload) {
  return Object.entries(payload).every(([key, wanted]) => {
    const field = info[key];
    return (isObject(field) ? field.value : field) === wanted;
  });
}

export class EcoNetApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'rheem-econet' }),
    transport,
    connect,
    now = Date.now,
    timers = globalThis,
    sleep,
    spacing,
    random = Math.random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.sleep = sleep;
    this.spacing = spacing;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.configKey = undefined;
    this.rawConfig = {};
    this.generation = 0;
    this.client = null;
    this.live = null;
    /** serial -> { equipment, ids, updatedAt, chain, waiters } */
    this.entries = new Map();
    /** feature external id -> { entry, key } */
    this.routes = new Map();
    this.devicesKey = undefined;
    this.apiOk = false;
    this.refused = false;
    this.backoff = 0;
    this.scheduled = new Map();
    this.lastStatus = undefined;
    /** device external id -> transport entry last published (JSON) */
    this.transports = new Map();
    /** `<serial>:<day>` -> kWh already published */
    this.energy = new Map();
    /** Things logged once: unsupported types, unknown modes, the unit. */
    this.logged = new Set();
    this.resetRun();
  }

  /** The state of one run (one configuration). */
  resetRun() {
    this.liveWasDown = false;
    this.lastRefreshAt = -Infinity;
    this.liveRefusals = 0;
    this.unitIssue = false;
    this.commands = 0;
  }

  logOnce(key, level, message) {
    if (!this.logged.has(key)) {
      this.logged.add(key);
      this.logger[level](message);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * @param {object} raw the configuration
   * @param {{ force?: boolean }} options force: start again even with the same
   * configuration (the user saved it), instead of a resync
   */
  async start(raw = {}, { force = false } = {}) {
    const config = normalizeConfig(raw);
    const key = JSON.stringify(config);
    if (!force && key === this.configKey && this.client) {
      // Gladys reconnected, same configuration: resend what Gladys may have lost.
      await this.resync();
      return;
    }
    const blockedUntil = this.client?.blockedUntil ?? 0;
    this.stop();
    this.config = config;
    this.configKey = key;
    this.rawConfig = raw;
    if (config.missing.length > 0) {
      await this.setStatus(false, T.notConfigured);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.client = this.newClient();
    // A 429 pause survives a restart with the same account.
    this.client.blockedUntil = blockedUntil;
    this.live = this.newLive(this.client);
    this.publisher.start();
    await this.refresh(this.generation, { publish: true });
  }

  newClient() {
    return new EcoNetClient({
      email: this.config.email,
      password: this.config.password,
      transport: this.transport,
      now: this.now,
      sleep: this.sleep,
      spacing: this.spacing,
      logger: this.logger,
    });
  }

  newLive(client) {
    const generation = this.generation;
    const current = () => generation === this.generation;
    return new LiveLink({
      connect: this.connect,
      session: async () => {
        await client.ensureSession();
        return { userToken: client.userToken, accountId: client.accountId, email: client.email };
      },
      onUpdate: (update, topic) => current() && this.onUpdate(update, topic),
      onChange: () => current() && this.liveChanged(),
      onRefused: (err) => current() && this.apiFailed(err),
      onTokenRefused: (token) => (current() ? this.tokenRefused(client, token) : undefined),
      logger: this.logger,
      now: this.now,
      timers: this.timers,
      random: this.random,
    });
  }

  stop() {
    this.generation += 1;
    for (const timer of this.scheduled.values()) {
      this.timers.clearTimeout(timer);
    }
    this.scheduled.clear();
    this.live?.stop();
    this.live = null;
    this.publisher.stop();
    this.publisher.clear();
    this.client = null;
    // The timers are gone: release the commands still waiting for a report.
    for (const entry of this.entries.values()) {
      for (const waiter of entry.waiters) {
        waiter.resolve();
      }
      entry.waiters.clear();
    }
    this.entries.clear();
    this.routes.clear();
    this.devicesKey = undefined;
    this.apiOk = false;
    this.refused = false;
    this.backoff = 0;
    this.configKey = undefined;
    this.resetRun();
  }

  /** Runs `fn` after `delay`, once per name, unless the app was restarted meanwhile. */
  schedule(name, delay, fn) {
    this.timers.clearTimeout(this.scheduled.get(name));
    const generation = this.generation;
    this.scheduled.set(
      name,
      this.timers.setTimeout(() => {
        this.scheduled.delete(name);
        if (generation === this.generation) {
          Promise.resolve()
            .then(fn)
            .catch((err) => this.logger.error(`${name} failed: ${err.message}`));
        }
      }, delay),
    );
  }

  cancel(name) {
    this.timers.clearTimeout(this.scheduled.get(name));
    this.scheduled.delete(name);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get liveUp() {
    return Boolean(this.live?.connected);
  }

  /** Milliseconds before the next attempt of the live link (0 when unknown). */
  liveWait() {
    return Math.max(0, (this.live?.nextAttempt ?? this.now()) - this.now());
  }

  /** The status once EcoNet answered: the live events decide. */
  async reportStatus() {
    const count = this.entries.size;
    if (this.refused) {
      await this.setStatus(false, T.refused);
    } else if (this.unitIssue) {
      await this.setStatus(true, T.notFahrenheit);
    } else if (count === 0) {
      await this.setStatus(true, T.noEquipment);
    } else if (this.liveUp) {
      await this.setStatus(true, T.connected(count));
    } else if (this.liveRefusals > 0) {
      await this.setStatus(false, T.liveRefused(count, this.liveWait()));
    } else if (this.client && this.client.reloginSpacing > TIMINGS.reloginSpacing) {
      await this.setStatus(false, T.tokenRefused(count, this.client.reloginSpacing));
    } else {
      await this.setStatus(false, T.liveDown(count, this.liveWait()));
    }
  }

  // --- Full reading ----------------------------------------------------------

  /** Reads the account, publishes the devices and states, then opens the live events. */
  async refresh(generation = this.generation, { publish = false } = {}) {
    let locations;
    try {
      locations = await this.client.locations();
    } catch (err) {
      if (generation === this.generation) {
        await this.apiFailed(err, () => this.refresh(generation, { publish }));
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.apiOk = true;
    this.backoff = 0;
    this.lastRefreshAt = this.now();
    const { equipments, skipped } = equipmentsOf(locations);
    for (const type of skipped) {
      this.logOnce(`type:${type}`, 'info', `EcoNet equipment not supported: ${type}`);
    }
    this.setEquipments(equipments.slice(0, LIMITS.equipments));
    this.checkUnit();
    await this.publishDevices({ force: publish });
    await this.publishAllStates();
    if (this.entries.size > 0) {
      this.live.start();
    }
    await this.reportStatus();
    await this.publishTransports();
    this.scheduleRefresh();
    if (!this.scheduled.has('energy')) {
      this.scheduleEnergy(0);
    }
  }

  /** The equipments of a reading; known ones keep their entry (commands, waiters). */
  setEquipments(equipments) {
    const entries = new Map();
    for (const equipment of equipments) {
      const known = this.entries.get(equipment.serial);
      const entry = known ?? { chain: Promise.resolve(), waiters: new Set() };
      entry.equipment = equipment;
      entry.ids = idsOf(this.gladys, equipment);
      entry.updatedAt = this.now();
      entries.set(equipment.serial, entry);
      if (equipment.kind === KINDS.WATER_HEATER) {
        const { discarded, unknown } = modeReport(equipment.info);
        for (const mode of discarded) {
          this.logOnce(
            `discarded:${equipment.serial}:${mode}`,
            'info',
            `"${nameOf(equipment)}": mode ${mode} shares its Gladys mode with another one: shown, not offered`,
          );
        }
        for (const text of unknown) {
          this.logOnce(
            `unknown:${equipment.serial}:${text}`,
            'warn',
            `"${nameOf(equipment)}": unknown EcoNet mode "${text}" left out`,
          );
        }
      }
    }
    if (this.entries.size === 0 && entries.size > 0) {
      this.logger.info(`EcoNet: ${entries.size} equipment(s) on the account`);
    }
    this.entries = entries;
    this.routes.clear();
    for (const entry of entries.values()) {
      for (const feature of this.deviceOf(entry).features) {
        this.routes.set(feature.external_id, {
          entry,
          key: feature.external_id.slice(entry.ids.device.length + 1),
        });
      }
    }
  }

  /** °F is assumed everywhere: anything else is logged, shown, and setpoints are refused. */
  checkUnit() {
    const unit = this.client?.displayUnit;
    const accountOther = typeof unit === 'string' && !FAHRENHEIT.test(unit);
    const equipmentOther = [...this.entries.values()].some((e) => notFahrenheit(e.equipment.info));
    this.unitIssue = accountOther || equipmentOther;
    if (this.unitIssue) {
      this.logOnce(
        'unit',
        'warn',
        `EcoNet may not report °F (account unit: ${unit ?? 'unknown'}): setpoints are refused`,
      );
    }
  }

  deviceOf(entry) {
    return buildDevice(this.gladys, entry.equipment, this.config.language, {
      maxWaterSetpoint: this.config.maxWaterSetpoint,
    });
  }

  scheduleRefresh() {
    const delay =
      this.liveUp || this.entries.size === 0 ? TIMINGS.refresh : TIMINGS.refreshDegraded;
    this.schedule('refresh', delay, () => this.refresh());
  }

  async apiFailed(err, retry) {
    if (err instanceof EcoNetError && err.kind === 'refused') {
      // Never retried by itself: the user fixes the password (or the test button succeeds).
      this.refused = true;
      this.apiOk = false;
      this.live?.stop();
      for (const name of ['refresh', 'energy', 'api']) {
        this.cancel(name);
      }
      this.logger.warn('EcoNet refused the e-mail or the password');
      await this.setStatus(false, T.refused);
      await this.publishTransports();
      return;
    }
    this.apiOk = false;
    let wait;
    if (err instanceof EcoNetError && err.kind === 'rate_limited') {
      // The client holds every request until the end of the pause (15 min at least).
      wait = Math.max(err.retryAfter ?? TIMINGS.rateLimit, 1000);
      this.logger.warn(`EcoNet rate limit: next attempt in ${Math.round(wait / 1000)} s`);
      if (!this.liveUp) {
        await this.setStatus(false, T.rateLimited(wait));
      }
    } else {
      this.backoff = this.backoff ? Math.min(this.backoff * 2, TIMINGS.retryMax) : TIMINGS.retryMin;
      wait = jittered(this.backoff, this.random);
      this.logger.warn(`EcoNet: ${errorReason(err)}`);
      if (!this.liveUp) {
        await this.setStatus(false, T.unreachable(errorReason(err), wait));
      }
    }
    if (retry) {
      this.cancel('refresh');
      this.schedule('api', wait, retry);
    }
    await this.publishTransports();
  }

  // --- Live events -------------------------------------------------------------

  /**
   * The broker refused a user token. A token EcoNet issued minutes ago is not
   * expired: the live link is refused for good, a new login would not help;
   * it waits 30 min, doubled up to 6 h. An older token is dropped (next
   * login, spaced by the client).
   * @returns {number | undefined} the least wait before the next attempt
   */
  tokenRefused(client, token) {
    if (client.isFresh(token)) {
      this.liveRefusals += 1;
      const wait = Math.min(
        TIMINGS.liveRefused * 2 ** (this.liveRefusals - 1),
        TIMINGS.liveRefusedMax,
      );
      this.logger.warn(
        `The EcoNet broker refuses a fresh token: live events retried in ${Math.round(wait / 60_000)} min`,
      );
      return wait;
    }
    client.invalidate(token);
    return undefined;
  }

  /**
   * A message of the broker. Only `reported` (what the equipment says)
   * changes the state; `desired` is the echo of a command, not its result.
   */
  onUpdate(update, topic = 'reported') {
    const entry = this.entries.get(String(update.serial_number ?? ''));
    if (!entry || String(update.device_name ?? '') !== entry.equipment.deviceName) {
      this.logger.debug('EcoNet update of an unknown equipment ignored');
      return;
    }
    if (topic !== 'reported') {
      return;
    }
    entry.updatedAt = this.now();
    const { info, changed } = mergeUpdate(entry.equipment.info, update);
    if (changed) {
      entry.equipment = { ...entry.equipment, info };
      this.pushStates(entry);
      if ('@CONNECTED' in update) {
        this.publishTransports().catch(() => {});
      }
    }
    for (const waiter of [...entry.waiters]) {
      if (confirms(entry.equipment.info, waiter.payload)) {
        entry.waiters.delete(waiter);
        this.cancel(waiter.name);
        waiter.resolve();
      }
    }
  }

  async liveChanged() {
    const up = this.liveUp;
    if (up) {
      this.liveRefusals = 0;
    }
    await this.reportStatus();
    await this.publishTransports();
    if (up && this.liveWasDown) {
      // What changed while the live events were down: at most one catch-up every 5 min.
      const due = Math.max(0, this.lastRefreshAt + TIMINGS.catchUp - this.now());
      this.schedule('refresh', due, () => this.refresh());
    } else {
      this.scheduleRefresh();
    }
    this.liveWasDown = !up;
  }

  // --- Daily energy --------------------------------------------------------------

  scheduleEnergy(delay = TIMINGS.energy) {
    if ([...this.entries.values()].some((e) => hasEnergy(e.equipment))) {
      this.schedule('energy', delay, () => this.readEnergy());
    }
  }

  /** The energy of the last elapsed days, for the water heaters the user added. */
  async readEnergy() {
    const generation = this.generation;
    const created = this.createdDevices();
    const days = energyDays(this.now());
    for (const entry of [...this.entries.values()]) {
      if (!hasEnergy(entry.equipment) || !created.has(entry.ids.device)) {
        continue;
      }
      const intervals = [];
      for (const [i, day] of days.entries()) {
        const key = `${entry.equipment.serial}:${day}`;
        // Only the last day may still change: the older ones are read once.
        if (i > 0 && this.energy.has(key)) {
          continue;
        }
        let kwh;
        try {
          kwh = await this.client.dailyEnergy(entry.equipment, day);
        } catch (err) {
          if (generation !== this.generation) {
            return;
          }
          if (err instanceof EcoNetError && err.kind === 'refused') {
            await this.apiFailed(err);
            return;
          }
          if (err instanceof EcoNetError && err.kind === 'rate_limited') {
            // No more requests during the pause: the next reading will do.
            this.logger.warn('EcoNet rate limit: energy reading stopped');
            this.scheduleEnergy();
            return;
          }
          this.logger.warn(`"${nameOf(entry.equipment)}": energy not read (${errorReason(err)})`);
          break;
        }
        if (generation !== this.generation) {
          return;
        }
        if (kwh !== null && this.energy.get(key) !== kwh) {
          intervals.push({ date: day, kwh, key });
        }
      }
      if (intervals.length > 0) {
        try {
          await this.gladys.publishEnergyConsumption(
            entry.ids.feature(FEATURES.ENERGY_DAILY),
            intervals.map(({ date, kwh }) => ({ date, kwh })),
          );
          for (const { key, kwh } of intervals) {
            this.energy.set(key, kwh);
          }
        } catch (err) {
          this.logger.warn(`Publishing the energy failed: ${err.message}`);
        }
      }
    }
    if (generation === this.generation) {
      this.scheduleEnergy();
    }
  }

  // --- Publication ---------------------------------------------------------------

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  /** Publishes the devices when they changed (or always with `force`). */
  async publishDevices({ force = false } = {}) {
    const devices = [...this.entries.values()].map((entry) => this.deviceOf(entry));
    const key = JSON.stringify(devices);
    if (!force && key === this.devicesKey) {
      return;
    }
    this.devicesKey = key;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the discovered devices failed: ${err.message}`));
  }

  /** Queues the states of an equipment the user added (Gladys drops the others). */
  pushStates(entry) {
    if (!this.createdDevices().has(entry.ids.device)) {
      return;
    }
    for (const [key, value] of statesOf(entry.equipment)) {
      // Only the features of the device: a field a live update brings later
      // (a unit unknown at the discovery) has no feature to receive it.
      const id = entry.ids.feature(key);
      if (this.routes.get(id)?.entry === entry) {
        this.publisher.push(id, value);
      }
    }
  }

  async publishAllStates() {
    for (const entry of this.entries.values()) {
      this.pushStates(entry);
    }
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
  }

  transportOf(entry) {
    if (!this.liveUp && !this.apiOk) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (entry.equipment.info['@CONNECTED'] === false) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE, degraded: true, message: T.badge.offline };
    }
    if (!this.liveUp) {
      return { transport: DEVICE_TRANSPORTS.CLOUD, degraded: true, message: T.badge.liveDown };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }

  async publishTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const entry of this.entries.values()) {
      const externalId = entry.ids.device;
      const transport = { external_id: externalId, ...this.transportOf(entry) };
      const key = JSON.stringify(transport);
      if (created.has(externalId) && this.transports.get(externalId) !== key) {
        this.transports.set(externalId, key);
        entries.push(transport);
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  /** Gladys reconnected: publish again what it may have lost. */
  async resync() {
    this.transports.clear();
    this.lastStatus = undefined;
    if (this.refused) {
      await this.setStatus(false, T.refused);
      return;
    }
    if (!this.apiOk && !this.liveUp) {
      return;
    }
    await this.publishDevices({ force: true });
    this.gladys.forgetPublishedStates();
    await this.publishAllStates();
    await this.reportStatus();
    await this.publishTransports();
  }

  // --- Devices created by the user -------------------------------------------------

  entryOfDevice(externalId) {
    return [...this.entries.values()].find((e) => e.ids.device === externalId);
  }

  async deviceCreated(device) {
    const entry = this.entryOfDevice(device?.external_id);
    if (entry) {
      this.transports.delete(entry.ids.device);
      this.pushStates(entry);
      await this.publisher
        .flush()
        .catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
      await this.publishTransports();
      if (hasEnergy(entry.equipment)) {
        this.scheduleEnergy(0);
      }
    }
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery screen asks for the equipments: read the account again. */
  async scan() {
    if (!this.client || this.refused) {
      return;
    }
    await this.refresh(this.generation, { publish: true });
  }

  // --- Commands ----------------------------------------------------------------------

  /**
   * One command at a time per equipment: the next one waits until the
   * equipment reported the previous one (or its 30 s ran out). Gladys gets
   * its answer as soon as a command is sent.
   */
  setValue(device, feature, value) {
    const route = this.routes.get(feature?.external_id);
    if (!route) {
      return Promise.reject(new Error('unknown EcoNet feature: scan the equipments again'));
    }
    const { entry, key } = route;
    const run = entry.chain.then(() => this.command(entry, key, value));
    entry.chain = run.then(({ confirmed }) => confirmed).catch(() => {});
    return run.then(() => undefined);
  }

  async command(entry, key, value) {
    if (!this.liveUp) {
      throw new Error('the live link to EcoNet is down: commands are unavailable for now');
    }
    if (entry.equipment.info['@CONNECTED'] === false) {
      throw new Error('EcoNet reports this equipment offline: command not sent');
    }
    if (this.now() - entry.updatedAt > TIMINGS.stateMaxAge) {
      throw new Error('the state of this equipment is too old: command not sent, try again later');
    }
    // An UnsupportedError carries the message Gladys shows for the failed command.
    const payload = payloadOf(entry.equipment, key, value, {
      maxWaterSetpoint: this.config.maxWaterSetpoint,
      fahrenheit: !this.unitIssue,
    });
    await this.live.publish(entry.equipment, payload);
    this.logger.info(`"${nameOf(entry.equipment)}": ${key} sent (${JSON.stringify(payload)})`);
    // Wrapped, not awaited: the queue of the equipment waits for it, Gladys does not.
    return { confirmed: this.awaitConfirmation(entry, key, payload) };
  }

  /**
   * Waits (30 s) for the equipment to report the values sent. Not confirmed:
   * logged, and the last reported state is published again, so Gladys does
   * not keep showing a value the equipment never took.
   * @returns {Promise<void>} settled once confirmed or after the 30 s
   */
  awaitConfirmation(entry, key, payload) {
    if (confirms(entry.equipment.info, payload)) {
      return Promise.resolve();
    }
    this.commands += 1;
    return new Promise((resolve) => {
      const waiter = {
        payload,
        name: `confirm:${entry.equipment.serial}:${this.commands}`,
        resolve,
      };
      entry.waiters.add(waiter);
      this.schedule(waiter.name, TIMINGS.commandConfirm, () => {
        resolve();
        if (!entry.waiters.delete(waiter)) {
          return;
        }
        this.logger.warn(
          `"${nameOf(entry.equipment)}": ${key} not confirmed by the equipment within ${TIMINGS.commandConfirm / 1000} s`,
        );
        this.gladys.forgetPublishedStates(entry.ids.device);
        this.publisher.forget(entry.ids.device);
        this.pushStates(entry);
      });
    });
  }

  // --- Configuration screen button ---------------------------------------------------

  /** Logs in with the saved configuration (a real login) and lists the equipments. */
  async testConnection() {
    if (this.config.missing.length > 0) {
      return T.notConfigured;
    }
    const client = this.newClient();
    // The 429 pause of the running client applies to the test too, and back.
    client.blockedUntil = this.client?.blockedUntil ?? 0;
    try {
      const { equipments } = equipmentsOf(await client.locations());
      if (this.refused) {
        // The credentials work now: start again.
        this.start(this.rawConfig, { force: true }).catch((e) =>
          this.logger.error(`Start failed: ${e.message}`),
        );
      }
      return T.test.ok(equipments.map((e) => nameOf(e)));
    } catch (err) {
      if (err instanceof EcoNetError && err.kind === 'refused') {
        return T.test.refused;
      }
      if (err instanceof EcoNetError && err.kind === 'rate_limited') {
        return T.rateLimited(err.retryAfter ?? TIMINGS.rateLimit);
      }
      return T.test.failed(errorReason(err));
    } finally {
      if (this.client) {
        this.client.blockedUntil = Math.max(this.client.blockedUntil, client.blockedUntil);
      }
    }
  }
}
