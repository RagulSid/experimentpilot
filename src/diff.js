// The exact changes a plan would make in Flagsmith, per phase, in the order the applier
// makes them. Three phases, each approved separately:
//   create: create the flag (with its variations), the metric and the experiment (not started)
//   start:  start that experiment, only once the app using the flag is deployed
//   stop:   complete (end) it once its stop rule is met, and choose what the flag serves afterwards
//           (rollout: control, disable, or variant:<key>; the choice is part of the hashed diff)
// A person approves one phase's list; its hash (diffSha256) goes into that phase's approval.
// Built only from the plan (and, for stop, the rollout choice), so the same inputs always give the same diff.
import { validatePlan, canonicalJson, sha256Hex } from './plan.js';

export const PHASES = ['create', 'start', 'stop'];
export const ROLLOUT_HELP = 'control, disable, or variant:<variant key>';
const CONTROL_KEY = 'control';
const EXPECTED_DIRECTION = { up: 'increase', down: 'decrease' };

export function assertPhase(phase) {
  if (!PHASES.includes(phase)) throw new TypeError(`phase must be "create", "start" or "stop", got ${JSON.stringify(phase)}`);
}

// What the flag serves after the experiment is completed (POST .../complete/, rollout_decision).
export function parseRollout(plan, rollout) {
  if (typeof rollout !== 'string' || !rollout) throw new TypeError(`stop needs a rollout: ${ROLLOUT_HELP}`);
  const control = plan.flag.variants.find((v) => v.key === CONTROL_KEY);
  if (rollout === 'control') return { decision: 'control', variantKey: null, servesAfter: `the control value ${JSON.stringify(control?.value)} to everyone` };
  if (rollout === 'disable') return { decision: 'disable', variantKey: null, servesAfter: 'nothing: the flag is disabled, so the app shows its fallback default' };
  const m = rollout.match(/^variant:(.+)$/);
  if (!m) throw new TypeError(`unknown rollout ${JSON.stringify(rollout)}; use ${ROLLOUT_HELP}`);
  if (m[1] === CONTROL_KEY) throw new TypeError('rollout variant:control is not a variant; use rollout control');
  const variant = plan.flag.variants.find((v) => v.key === m[1]);
  if (!variant) throw new TypeError(`rollout names variant ${JSON.stringify(m[1])}, which is not in the plan`);
  return { decision: 'variant', variantKey: variant.key, servesAfter: `the ${variant.key} value ${JSON.stringify(variant.value)} to everyone` };
}

export function buildDiff(plan, phase, { rollout } = {}) {
  assertPhase(phase);
  const shape = validatePlan(plan);
  if (!shape.ok) throw new TypeError(`cannot build a diff from an invalid plan: ${shape.errors.join('; ')}`);

  const env = `environment ${plan.environment}`;

  if (phase === 'stop') {
    const r = parseRollout(plan, rollout);
    return [{
      phase,
      step: 1,
      action: 'complete_experiment',
      scope: env,
      experiment: plan.id,
      flag: plan.flag.key,
      rollout: r,
      requires: 'the experiment is running or paused; its pre-registered stop rule is met (the readout is not not_ready); a variant rollout only if the readout names that variant as the winner candidate',
      effect: `ends the experiment for good (the OpenAPI spec lists no route to undo it) and removes its rollout override; afterwards the flag serves ${r.servesAfter}`,
    }];
  }

  if (phase === 'start') {
    return [{
      phase,
      step: 1,
      action: 'start_experiment',
      scope: env,
      experiment: plan.id,
      flag: plan.flag.key,
      requires: 'the experiment exists with status created, and the app using this flag and event is deployed',
      effect: 'locks the flag and turns on the rollout',
    }];
  }

  const control = plan.flag.variants.find((v) => v.key === CONTROL_KEY);
  const variations = plan.flag.variants.filter((v) => v.key !== CONTROL_KEY);
  const splitOrder = [control, ...variations].filter(Boolean).map((v) => v.key);

  return [
    {
      phase,
      step: 1,
      action: 'create_flag',
      scope: 'project: the flag appears in every environment, Production included, enabled with the control value',
      flag: {
        key: plan.flag.key,
        type: plan.flag.type,
        enabledByDefault: true,
        control: control ? { key: control.key, value: control.value } : null,
        variations: variations.map((v) => ({ key: v.key, value: v.value })),
      },
    },
    {
      phase,
      step: 2,
      action: 'create_metric',
      scope: env,
      metric: { name: plan.metric.name, event: plan.metric.event, aggregation: 'occurrence', direction: plan.metric.direction },
    },
    {
      phase,
      step: 3,
      action: 'create_experiment',
      scope: env,
      experiment: {
        name: plan.id,
        hypothesis: plan.hypothesis,
        flag: plan.flag.key,
        primaryMetric: plan.metric.name,
        expectedDirection: EXPECTED_DIRECTION[plan.metric.direction] ?? null,
        rolloutPercentage: 100,
        split: splitOrder.map((key) => ({ key, percentage: plan.split[key] ?? null })),
        statusAfter: 'created',
      },
    },
  ];
}

export function diffSha256(diff) {
  return sha256Hex(canonicalJson(diff));
}

// One screen of plain text for the person approving.
export function formatDiff(diff, { planSha256, diffSha256: diffHash } = {}) {
  const phase = diff[0]?.phase ?? 'unknown';
  const production = diff.some((c) => c.scope === 'environment Production');
  const lines = production ? ['PRODUCTION: these changes reach real visitors of the live page.', ''] : [];
  lines.push(`Phase ${phase.toUpperCase()}: changes ExperimentPilot will make in Flagsmith, in this order:`, '');
  for (const change of diff) {
    if (change.action === 'create_flag') {
      const f = change.flag;
      lines.push(`  ${change.step}. CREATE flag ${f.key} (${f.type}), ${f.enabledByDefault ? 'enabled' : 'disabled'}`);
      lines.push(`       scope: ${change.scope}`);
      if (f.control) lines.push(`       control    ${f.control.key.padEnd(12)} value ${JSON.stringify(f.control.value)}`);
      for (const v of f.variations) lines.push(`       variation  ${v.key.padEnd(12)} value ${JSON.stringify(v.value)}`);
    } else if (change.action === 'create_metric') {
      const m = change.metric;
      lines.push(`  ${change.step}. CREATE metric ${JSON.stringify(m.name)} in ${change.scope}`);
      lines.push(`       event ${JSON.stringify(m.event)} (exact, case-sensitive), ${m.aggregation}, higher is ${m.direction === 'up' ? 'better' : 'worse'}`);
    } else if (change.action === 'create_experiment') {
      const e = change.experiment;
      lines.push(`  ${change.step}. CREATE experiment ${e.name} in ${change.scope}, status ${e.statusAfter} (not started)`);
      lines.push(`       flag ${e.flag}, primary metric ${JSON.stringify(e.primaryMetric)} expected to ${e.expectedDirection}`);
      lines.push(`       rollout ${e.rolloutPercentage}%, split ${e.split.map((s) => `${s.key} ${s.percentage}%`).join(' / ')}`);
      lines.push(`       hypothesis: ${e.hypothesis}`);
    } else if (change.action === 'complete_experiment') {
      lines.push(`  ${change.step}. COMPLETE experiment ${change.experiment} (flag ${change.flag}) in ${change.scope}`);
      lines.push(`       rollout: ${change.rollout.decision}${change.rollout.variantKey ? ` (${change.rollout.variantKey})` : ''}; afterwards the flag serves ${change.rollout.servesAfter}`);
      lines.push(`       requires: ${change.requires}`);
      lines.push(`       effect: ${change.effect}`);
    } else if (change.action === 'start_experiment') {
      lines.push(`  ${change.step}. START experiment ${change.experiment} (flag ${change.flag}) in ${change.scope}`);
      lines.push(`       requires: ${change.requires}`);
      lines.push(`       effect: ${change.effect}`);
    }
  }
  lines.push('');
  if (planSha256) lines.push(`plan sha256: ${planSha256}`);
  if (diffHash) lines.push(`diff sha256: ${diffHash}`);
  return lines.join('\n');
}
