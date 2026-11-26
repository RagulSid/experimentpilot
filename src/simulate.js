// Helpers for scripted traffic (scripts/simulate.mjs). Scripted visitors always have ids that
// start with "sim_", run only against the Development key this repo is bound to, and convert at
// made-up rates. Their numbers are never reported as real.

export const SIM_PREFIX = 'sim_';

// Made-up conversion rates for the rehearsal. Synthetic, disclosed wherever results appear.
export const MADE_UP_RATES = { control: 0.10, variant_b: 0.14 };

export function simIds(count, runTag) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a whole number above 0, got ${count}`);
  if (!/^[a-z0-9]+$/.test(runTag)) throw new Error(`run tag must be lowercase letters and digits, got ${JSON.stringify(runTag)}`);
  return Array.from({ length: count }, (_, i) => `${SIM_PREFIX}${runTag}_${String(i + 1).padStart(4, '0')}`);
}

export function checkSimTarget(localConfig, boundEnvironmentKey) {
  if (localConfig?.FLAGSMITH_ENVIRONMENT_NAME !== 'Development') {
    throw new Error(`scripted traffic runs only against Development; config says ${JSON.stringify(localConfig?.FLAGSMITH_ENVIRONMENT_NAME)}`);
  }
  if (!boundEnvironmentKey || localConfig.FLAGSMITH_ENVIRONMENT_KEY !== boundEnvironmentKey) {
    throw new Error('the local key is not the environment this repo is bound to (flagsmith.json); refusing');
  }
}

export function converts(value, random = Math.random) {
  const rate = MADE_UP_RATES[value] ?? 0;
  return random() < rate;
}
