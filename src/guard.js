// Guard: plain code, no AI. Checks an experiment plan against rules G1 to G10 and returns
// EVERY violated rule with a reason, so a person (or the planner) can fix all of them at once.
// It is pure: no network, no file access. The caller passes the app source and Flagsmith state.
//
//   checkPlan(plan, {
//     appSource,                  // text of the app file holding the event and fallback constants
//     allowProduction,            // true only when a person explicitly allows Production
//     startedExperimentFlagKeys,  // flag keys already used by a started experiment
//   }) -> { ok: boolean, violations: [{ rule: 'G1'..'G10', reason: string }] }

export const RULES = {
  G1: 'the flag is multivariate',
  G2: 'at least 2 variations with unique, non-empty keys; exactly one control; "control" not reused',
  G3: 'split percentages sum to 100 and each is above 0',
  G4: 'exactly one primary metric, fully defined, fixed before the start',
  G5: 'one stable identifier for flag and events; real ids web_, scripted ids sim_, reported separately',
  G6: 'a stop rule exists and is not "stop when significant"',
  G7: 'no "decide early" or peeking language anywhere in the plan',
  G8: "the metric's event name equals the app's event constant exactly",
  G9: 'the environment is allowed and the flag key is not used by a started experiment',
  G10: 'the app code has a fallback default',
};

const CONTROL_KEY = 'control';
const DIRECTIONS = ['up', 'down'];
const METRIC_FIELDS = ['name', 'event', 'direction'];
const STOP_RULE_TYPES = ['minExposuresPerVariant', 'fixedEnd'];
const PREFIX_REAL = 'web_';
const PREFIX_SCRIPTED = 'sim_';
const DEFAULT_ENVIRONMENT = 'Development';
const PRODUCTION = 'Production';

// Phrases that mean "look at the results before the stop rule and act on them".
const PEEKING_PATTERNS = [
  /\bpeek(s|ed|ing)?\b/i,
  /\b(stop|stopping|end|ending|decide|deciding|call|calling)\s+(it\s+|the\s+(test|experiment)\s+)?early\b/i,
  /\bearly\s+(stop|stopping|decision|winner|call|look)\b/i,
  /\b(as\s+soon\s+as|once|when|whenever)\b[^.]{0,40}\bsignifican(t|ce)\b/i,
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const show = (v) => JSON.stringify(v);

function variantsOf(plan) {
  return Array.isArray(plan.flag?.variants) ? plan.flag.variants : [];
}

function variantKeys(plan) {
  return variantsOf(plan).filter((v) => isObject(v) && isText(v.key)).map((v) => v.key);
}

function controlValue(plan) {
  const control = variantsOf(plan).find((v) => isObject(v) && v.key === CONTROL_KEY);
  return control?.value;
}

// String constants declared in the app source: const|let|var NAME = '...' (or "..." or `...` without ${}).
function stringConstants(source) {
  const found = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of source.matchAll(re)) {
    if (m[2] === '`' && m[3].includes('${')) continue;
    found.push({ name: m[1], value: m[3] });
  }
  return found;
}

// Every string in the plan with its path, e.g. ["decisionRule.note", "peeking allowed"].
function stringsWithPaths(value, path = '') {
  if (typeof value === 'string') return [[path || '(plan)', value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsWithPaths(v, `${path}[${i}]`));
  if (isObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => stringsWithPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

const checks = {
  G1(plan) {
    const type = plan.flag?.type;
    if (type === 'multivariate') return [];
    return [`flag.type is ${type === undefined ? 'missing' : show(type)}; only a multivariate flag can be experimented on`];
  },

  G2(plan) {
    const reasons = [];
    const variants = variantsOf(plan);
    if (variants.length < 2) {
      reasons.push(`found ${variants.length} variation(s); need at least 2 (the control plus one or more)`);
    }
    variants.forEach((v, i) => {
      if (!isObject(v) || !isText(v.key)) {
        reasons.push(`variation #${i + 1} has no key; a variation without a key records no exposures`);
      }
    });
    const keys = variantKeys(plan);
    const duplicates = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    for (const key of duplicates) {
      reasons.push(key === CONTROL_KEY
        ? `"${CONTROL_KEY}" is reserved for the control and is reused as a variation key`
        : `variation key ${show(key)} is used more than once`);
    }
    if (!keys.includes(CONTROL_KEY)) {
      reasons.push(`no control: exactly one variation must have the key "${CONTROL_KEY}"`);
    }
    return reasons;
  },

  G3(plan) {
    const split = plan.split;
    if (!isObject(split)) return ['split is missing; give each variation a percentage'];
    const reasons = [];
    const keys = variantKeys(plan);
    for (const key of keys) {
      if (!(key in split)) reasons.push(`variation ${show(key)} has no share in the split`);
    }
    let sum = 0;
    for (const [key, share] of Object.entries(split)) {
      if (!keys.includes(key)) reasons.push(`split names ${show(key)}, which is not a variation`);
      if (typeof share !== 'number' || !Number.isFinite(share)) {
        reasons.push(`split for ${show(key)} is ${show(share)}, not a number`);
        continue;
      }
      if (share <= 0) reasons.push(`split for ${show(key)} is ${share}; every share must be above 0`);
      sum += share;
    }
    if (Math.abs(sum - 100) > 1e-9) reasons.push(`split sums to ${sum}, not 100`);
    return reasons;
  },

  G4(plan) {
    const reasons = [];
    const metric = plan.metric;
    if ('metrics' in plan) {
      reasons.push('plan lists extra metrics under "metrics"; exactly one primary metric is allowed');
    }
    if (!isObject(metric)) {
      reasons.push('metric is missing or not a single object');
      return reasons;
    }
    if (!isText(metric.name)) reasons.push('metric.name is missing');
    if (!isText(metric.event)) reasons.push('metric.event is missing');
    if (!DIRECTIONS.includes(metric.direction)) {
      reasons.push(`metric.direction is ${metric.direction === undefined ? 'missing' : show(metric.direction)}; use "up" or "down"`);
    }
    for (const field of Object.keys(metric)) {
      if (!METRIC_FIELDS.includes(field)) {
        reasons.push(`metric has unexpected field ${show(field)}; the metric is fixed before the start and nothing is added later`);
      }
    }
    const primary = plan.decisionRule?.primaryMetric;
    if (primary !== metric.name) {
      reasons.push(`decisionRule.primaryMetric is ${show(primary)} but the metric is named ${show(metric.name)}`);
    }
    return reasons;
  },

  G5(plan) {
    const reasons = [];
    const id = plan.identity;
    if (!isObject(id)) return ['identity is missing; declare one stable visitor id for flag and events'];
    if (!isText(id.source)) reasons.push('identity.source is missing; say where the stable visitor id comes from');
    const usedFor = Array.isArray(id.usedFor) ? id.usedFor : [];
    for (const use of ['flag', 'events']) {
      if (!usedFor.includes(use)) reasons.push(`identity.usedFor must include "${use}": the same id is used for flag and events`);
    }
    if (id.prefixReal !== PREFIX_REAL) reasons.push(`identity.prefixReal is ${show(id.prefixReal)}; real visitor ids start "${PREFIX_REAL}"`);
    if (id.prefixScripted !== PREFIX_SCRIPTED) reasons.push(`identity.prefixScripted is ${show(id.prefixScripted)}; scripted ids start "${PREFIX_SCRIPTED}"`);
    const traffic = plan.traffic;
    if (!isObject(traffic) || typeof traffic.real !== 'boolean' || typeof traffic.scripted !== 'boolean') {
      reasons.push('traffic must state real: true|false and scripted: true|false, so scripted traffic is reported separately');
    } else if (!traffic.real && !traffic.scripted) {
      reasons.push('traffic says neither real nor scripted; nothing would be measured');
    }
    return reasons;
  },

  G6(plan) {
    const rule = plan.stopRule;
    if (!isObject(rule)) return ['stopRule is missing; pre-register a minimum exposures per variation or a fixed end time'];
    if (!STOP_RULE_TYPES.includes(rule.type)) {
      return [`stopRule.type ${show(rule.type)} is not allowed; use ${STOP_RULE_TYPES.join(' or ')} (stopping when the result looks significant inflates false winners)`];
    }
    if (rule.type === 'minExposuresPerVariant' && !(Number.isInteger(rule.value) && rule.value > 0)) {
      return [`stopRule.value is ${show(rule.value)}; minimum exposures per variation must be a whole number above 0`];
    }
    if (rule.type === 'fixedEnd' && !(typeof rule.value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(rule.value) && !Number.isNaN(Date.parse(rule.value)))) {
      return [`stopRule.value is ${show(rule.value)}; a fixed end must be an ISO date-time such as 2026-11-29T08:00:00+05:30`];
    }
    return [];
  },

  G7(plan) {
    const reasons = [];
    for (const [path, text] of stringsWithPaths(plan)) {
      const hit = PEEKING_PATTERNS.map((re) => text.match(re)).find(Boolean);
      if (hit) reasons.push(`${path} says ${show(hit[0])}; results are read only after the stop rule, never early`);
    }
    return reasons;
  },

  G8(plan, ctx) {
    const event = plan.metric?.event;
    if (!isText(ctx.appSource)) return ['app code was not provided, so the event constant cannot be checked'];
    if (!isText(event)) return ['metric has no event name to compare with the app code'];
    const constants = stringConstants(ctx.appSource);
    const exact = constants.filter((c) => c.value === event);
    if (exact.length === 1) return [];
    if (exact.length > 1) {
      return [`event ${show(event)} is defined in ${exact.length} constants (${exact.map((c) => c.name).join(', ')}); keep exactly one`];
    }
    const nearly = constants.find((c) => c.value.toLowerCase() === event.toLowerCase());
    if (nearly) {
      return [`app constant ${nearly.name} is ${show(nearly.value)} but the metric event is ${show(event)}; event names are case-sensitive and a mismatch is silently ignored`];
    }
    return [`no constant in the app code equals the metric event ${show(event)}; the event would never be counted`];
  },

  G9(plan, ctx) {
    const reasons = [];
    const allowed = ctx.allowProduction === true ? [DEFAULT_ENVIRONMENT, PRODUCTION] : [DEFAULT_ENVIRONMENT];
    if (!allowed.includes(plan.environment)) {
      reasons.push(plan.environment === PRODUCTION
        ? 'environment is Production, which needs an explicit allow-production flag'
        : `environment ${show(plan.environment)} is not allowed; use ${allowed.join(' or ')}`);
    }
    const key = plan.flag?.key;
    if (!isText(key)) {
      reasons.push('flag.key is missing');
    } else if ((ctx.startedExperimentFlagKeys ?? []).includes(key)) {
      reasons.push(`flag ${show(key)} is already used by a started experiment; use a new flag key`);
    }
    return reasons;
  },

  G10(plan, ctx) {
    if (!isText(ctx.appSource)) return ['app code was not provided, so the fallback default cannot be checked'];
    const fallbacks = stringConstants(ctx.appSource).filter((c) => /fallback/i.test(c.name));
    if (fallbacks.length === 0) {
      return ['app code has no FALLBACK constant; the app must still work when Flagsmith is unreachable'];
    }
    const control = controlValue(plan);
    if (control === undefined) return ['the plan has no control value to fall back to'];
    if (!fallbacks.some((c) => c.value === String(control))) {
      return [`fallback ${fallbacks.map((c) => `${c.name} = ${show(c.value)}`).join(', ')} does not equal the control value ${show(control)}`];
    }
    return [];
  },
};

export function checkPlan(plan, ctx = {}) {
  const p = isObject(plan) ? plan : {};
  const c = isObject(ctx) ? ctx : {};
  const violations = [];
  for (const [rule, check] of Object.entries(checks)) {
    for (const reason of check(p, c)) violations.push({ rule, reason });
  }
  return { ok: violations.length === 0, violations };
}
