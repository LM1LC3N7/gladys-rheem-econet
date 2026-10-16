// -----------------------------------------------------------------------------
// The integration: one EcoNet account, its water heaters and thermostats as
// Gladys devices, their live state, the commands sent back, the daily energy
// and the status shown in Gladys. index.js only wires the SDK handlers to it
// (src/handlers.js).
//
//   start ─► login ─► equipment list (getUserDataForApp) ─► devices + states
//              └► live events: MQTT, user/<account>/device/reported|desired
//   timers: full reading (30 min, 5 min while the live events are down),
//   daily energy (6 h), retries with backoff. A refused password is never
//   retried by itself.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { FEATURES, LIMITS, TIMINGS } from './constants.js';
import { buildDevice, hasEnergy, idsOf, payloadOf, statesOf } from './devices.js';
import { EcoNetClient, EcoNetError, errorReason } from './econet.js';
import { equipmentsOf, mergeUpdate, nameOf } from './equipment.js';
import { T } from './i18n.js';
import { LiveLink } from './live.js';
import { StatePublisher } from './publisher.js';

const DAY = 24 * 3600_000;

/** YYYY-MM-DD of a time (UTC). */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The days whose energy is published: the last LIMITS.energyDays elapsed ones.
 * "Yesterday" is counted from 12 hours ago, so the day is over in the
 * timezones of North America (UTC-3 to UTC-10) when it is published.
 */
export function energyDays(now) {
  const base = now - 12 * 3600_000;
  return Array.from({ length: LIMITS.energyDays }, (_, i) => dayOf(base - (i + 1) * DAY));
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
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.sleep = sleep;
    this.spacing = spacing;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.configKey = undefined;
    this.rawConfig = {};
    this.generation = 0;
    this.client = null;
    this.live = null;
    /** serial -> { equipment, ids } */
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
    this.skippedLogged = new Set();
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
      onUpdate: (update) => current() && this.onUpdate(update),
      onChange: () => current() && this.liveChanged(),
      onRefused: (err) => current() && this.apiFailed(err),
      onTokenRefused: (token) => client.invalidate(token),
      logger: this.logger,
      now: this.now,
      timers: this.timers,
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
    this.entries.clear();
    this.routes.clear();
    this.devicesKey = undefined;
    this.apiOk = false;
    this.refused = false;
    this.backoff = 0;
    this.configKey = undefined;
    this.liveWasDown = false;
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

  /** The status once EcoNet answered: the live events decide. */
  async reportStatus() {
    if (this.refused) {
      await this.setStatus(false, T.refused);
    } else if (this.entries.size === 0) {
      await this.setStatus(true, T.noEquipment);
    } else if (this.liveUp) {
      await this.setStatus(true, T.connected(this.entries.size));
    } else {
      const wait = Math.max(0, (this.live?.nextAttempt ?? this.now()) - this.now());
      await this.setStatus(false, T.liveDown(this.entries.size, wait));
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
    const { equipments, skipped } = equipmentsOf(locations);
    for (const type of skipped) {
      if (!this.skippedLogged.has(type)) {
        this.skippedLogged.add(type);
        this.logger.info(`EcoNet equipment not supported: ${type}`);
      }
    }
    this.setEquipments(equipments.slice(0, LIMITS.equipments));
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

  setEquipments(equipments) {
    const entries = new Map();
    for (const equipment of equipments) {
      entries.set(equipment.serial, { equipment, ids: idsOf(this.gladys, equipment) });
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

  deviceOf(entry) {
    return buildDevice(this.gladys, entry.equipment, this.config.language);
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
        this.timers.clearTimeout(this.scheduled.get(name));
        this.scheduled.delete(name);
      }
      this.logger.warn('EcoNet refused the e-mail or the password');
      await this.setStatus(false, T.refused);
      await this.publishTransports();
      return;
    }
    this.apiOk = false;
    let wait;
    if (err instanceof EcoNetError && err.kind === 'rate_limited') {
      wait = Math.max(err.retryAfter ?? 0, TIMINGS.rateLimit);
      this.logger.warn(`EcoNet rate limit: next attempt in ${Math.round(wait / 1000)} s`);
      if (!this.liveUp) {
        await this.setStatus(false, T.rateLimited(wait));
      }
    } else {
      this.backoff = this.backoff ? Math.min(this.backoff * 2, TIMINGS.retryMax) : TIMINGS.retryMin;
      wait = this.backoff;
      this.logger.warn(`EcoNet: ${errorReason(err)}`);
      if (!this.liveUp) {
        await this.setStatus(false, T.unreachable(errorReason(err), wait));
      }
    }
    if (retry) {
      this.timers.clearTimeout(this.scheduled.get('refresh'));
      this.scheduled.delete('refresh');
      this.schedule('api', wait, retry);
    }
    await this.publishTransports();
  }

  // --- Live events -------------------------------------------------------------

  /** A message of the broker: the fields that changed on one equipment. */
  onUpdate(update) {
    const entry = this.entries.get(String(update.serial_number ?? ''));
    if (!entry || String(update.device_name ?? '') !== entry.equipment.deviceName) {
      this.logger.debug('EcoNet update of an unknown equipment ignored');
      return;
    }
    const { info, changed } = mergeUpdate(entry.equipment.info, update);
    if (!changed) {
      return;
    }
    entry.equipment = { ...entry.equipment, info };
    this.pushStates(entry);
    if ('@CONNECTED' in update) {
      this.publishTransports().catch(() => {});
    }
  }

  async liveChanged() {
    const up = this.liveUp;
    await this.reportStatus();
    await this.publishTransports();
    if (up && this.liveWasDown) {
      // What changed while the live events were down.
      this.schedule('refresh', 0, () => this.refresh());
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
      this.publisher.push(entry.ids.feature(key), value);
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

  async setValue(device, feature, value) {
    const route = this.routes.get(feature?.external_id);
    if (!route) {
      throw new Error('unknown EcoNet feature: scan the equipments again');
    }
    if (!this.liveUp) {
      throw new Error('the live link to EcoNet is down: commands are unavailable for now');
    }
    const { entry, key } = route;
    // An UnsupportedError carries the message Gladys shows for the failed command.
    const payload = payloadOf(entry.equipment, key, value);
    await this.live.publish(entry.equipment, payload);
    this.logger.info(`"${nameOf(entry.equipment)}": ${key} set (${JSON.stringify(payload)})`);
  }

  // --- Configuration screen button ---------------------------------------------------

  /** Logs in with the saved configuration (a real login) and lists the equipments. */
  async testConnection() {
    if (this.config.missing.length > 0) {
      return T.notConfigured;
    }
    const client = this.newClient();
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
      return T.test.failed(errorReason(err));
    }
  }
}
