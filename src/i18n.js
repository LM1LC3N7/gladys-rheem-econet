// -----------------------------------------------------------------------------
// The texts of the integration: names of the features and of their options
// (in the language of the configuration), and the status messages of the
// Configuration screen (always { en, fr }).
// -----------------------------------------------------------------------------

const TEXTS = {
  en: {
    features: {
      mode: 'Mode',
      'target-temperature': 'Water setpoint',
      'remaining-hot-water': 'Hot water available',
      heating: 'Heating',
      'shutoff-valve': 'Shut-off valve',
      'tank-health': 'Tank health',
      'compressor-health': 'Compressor health',
      'energy-daily': 'Energy per day',
      temperature: 'Temperature',
      humidity: 'Humidity',
      'heat-setpoint': 'Heating setpoint',
      'cool-setpoint': 'Cooling setpoint',
      'thermostat-mode': 'Mode',
      'system-mode': 'EcoNet mode',
      'operating-state': 'Running',
      'fan-speed': 'Fan speed',
      'fan-mode': 'Fan',
      alerts: 'Active alerts',
    },
    options: {
      waterHeaterMode: {
        OFF: 'Off',
        ENERGY_SAVING: 'Energy saver',
        HEAT_PUMP_ONLY: 'Heat pump only',
        HIGH_DEMAND: 'High demand',
        PERFORMANCE: 'Performance',
        ELECTRIC: 'Electric',
        GAS: 'Gas',
        VACATION: 'Vacation',
      },
      thermostatMode: {
        HEATING: 'Heating',
        COOLING: 'Cooling',
        AUTO: 'Auto',
        FAN_ONLY: 'Fan only',
        OFF: 'Off',
        EMERGENCY_HEAT: 'Emergency heat',
      },
      fanSpeed: {
        AUTO: 'Auto',
        LOW: 'Low',
        MEDLO: 'Medium-low',
        MEDIUM: 'Medium',
        MEDHI: 'Medium-high',
        HIGH: 'High',
        MAX: 'Max',
      },
      fanMode: { AUTO: 'Auto', ON_CONTINUOUS: 'On (continuous)' },
    },
  },
  fr: {
    features: {
      mode: 'Mode',
      'target-temperature': "Consigne de l'eau",
      'remaining-hot-water': 'Eau chaude disponible',
      heating: 'Chauffe',
      'shutoff-valve': "Vanne d'arrêt",
      'tank-health': 'État de la cuve',
      'compressor-health': 'État du compresseur',
      'energy-daily': 'Énergie par jour',
      temperature: 'Température',
      humidity: 'Humidité',
      'heat-setpoint': 'Consigne de chauffage',
      'cool-setpoint': 'Consigne de climatisation',
      'thermostat-mode': 'Mode',
      'system-mode': 'Mode EcoNet',
      'operating-state': 'Fonctionnement',
      'fan-speed': 'Vitesse de ventilation',
      'fan-mode': 'Ventilation',
      alerts: 'Alertes actives',
    },
    options: {
      waterHeaterMode: {
        OFF: 'Arrêt',
        ENERGY_SAVING: 'Économie d’énergie',
        HEAT_PUMP_ONLY: 'Pompe à chaleur seule',
        HIGH_DEMAND: 'Forte demande',
        PERFORMANCE: 'Performance',
        ELECTRIC: 'Électrique',
        GAS: 'Gaz',
        VACATION: 'Vacances',
      },
      thermostatMode: {
        HEATING: 'Chauffage',
        COOLING: 'Climatisation',
        AUTO: 'Auto',
        FAN_ONLY: 'Ventilation seule',
        OFF: 'Arrêt',
        EMERGENCY_HEAT: 'Chauffage d’appoint',
      },
      fanSpeed: {
        AUTO: 'Auto',
        LOW: 'Basse',
        MEDLO: 'Moyenne-basse',
        MEDIUM: 'Moyenne',
        MEDHI: 'Moyenne-haute',
        HIGH: 'Haute',
        MAX: 'Max',
      },
      fanMode: { AUTO: 'Auto', ON_CONTINUOUS: 'Marche (continue)' },
    },
  },
};

export const texts = (language) => TEXTS[language] ?? TEXTS.en;

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const wait = (ms) =>
  ms >= 60_000
    ? { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` }
    : { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };

/** Status messages and button answers, { en, fr }. */
export const T = {
  notConfigured: {
    en: 'Enter the e-mail address and the password of your EcoNet account.',
    fr: "Saisissez l'adresse e-mail et le mot de passe de votre compte EcoNet.",
  },
  connecting: { en: 'Connecting to EcoNet…', fr: 'Connexion à EcoNet…' },
  refused: {
    en: 'EcoNet refused the e-mail or the password. Fix them and save: the integration does not try again by itself.',
    fr: "EcoNet a refusé l'e-mail ou le mot de passe. Corrigez-les puis enregistrez : l'intégration ne réessaie pas toute seule.",
  },
  unreachable: (reason, ms) => ({
    en: `EcoNet cannot be reached (${reason}). Next attempt in ${wait(ms).en}.`,
    fr: `EcoNet est injoignable (${reason}). Nouvel essai dans ${wait(ms).fr}.`,
  }),
  rateLimited: (ms) => ({
    en: `EcoNet asks to slow down. Next attempt in ${wait(ms).en}.`,
    fr: `EcoNet demande de ralentir. Nouvel essai dans ${wait(ms).fr}.`,
  }),
  connected: (count) => ({
    en: `Connected: ${count} equipment(s), live updates on.`,
    fr: `Connecté : ${count} équipement(s), mises à jour en direct actives.`,
  }),
  noEquipment: {
    en: 'Connected, but the account has no water heater nor thermostat.',
    fr: "Connecté, mais le compte n'a ni chauffe-eau ni thermostat.",
  },
  liveDown: (count, ms) => ({
    en: `Connected: ${count} equipment(s), but the live updates are down (states read every 5 min, commands unavailable). Next attempt in ${wait(ms).en}.`,
    fr: `Connecté : ${count} équipement(s), mais les mises à jour en direct sont coupées (états lus toutes les 5 min, commandes indisponibles). Nouvel essai dans ${wait(ms).fr}.`,
  }),
  badge: {
    liveDown: {
      en: 'Live updates down: states every 5 min, commands unavailable',
      fr: 'Direct coupé : états toutes les 5 min, commandes indisponibles',
    },
    offline: {
      en: 'EcoNet reports this equipment offline',
      fr: 'EcoNet signale cet équipement hors ligne',
    },
  },
  test: {
    ok: (names) => ({
      en: `Connection OK: ${names.length} equipment(s)${names.length ? ` (${names.join(', ')})` : ''}.`,
      fr: `Connexion OK : ${names.length} équipement(s)${names.length ? ` (${names.join(', ')})` : ''}.`,
    }),
    refused: {
      en: 'EcoNet refused the e-mail or the password.',
      fr: "EcoNet a refusé l'e-mail ou le mot de passe.",
    },
    failed: (reason) => ({
      en: `The test failed: ${reason}.`,
      fr: `Le test a échoué : ${reason}.`,
    }),
  },
};
