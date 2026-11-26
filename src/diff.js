// The exact changes a plan would make in Flagsmith, per phase, in the order the applier
// makes them. Two phases, each approved separately:
//   create: create the flag (with its variations), the metric and the experiment (not started)
//   start:  start that experiment, only once the app using the flag is deployed
// A person approves one phase's list; its hash (diffSha256) goes into that phase's approval.
// Built only from the plan, so the same plan and phase always give the same diff.
import { validatePlan, canonicalJson, sha256Hex } from './plan.js';

export const PHASES = ['create', 'start'];
const CONTROL_KEY = 'control';
const EXPECTED_DIRECTION = { up: 'increase', down: 'decrease' };

export function assertPhase(phase) {
  if (!PHASES.includes(phase)) throw new TypeError(`phase must be "create" or "start", got ${JSON.stringify(phase)}`);
}

export function buildDiff(plan, phase) {
  assertPhase(phase);
  const shape = validatePlan(plan);
  if (!shape.ok) throw new TypeError(`cannot build a diff from an invalid plan: ${shape.errors.join('; ')}`);

  const env = `environment ${plan.environment}`;

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
