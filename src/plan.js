// Plan file: shape check, canonical JSON and planSha256.
// The shape check only asks "is every field there, with the right type?". Whether the plan
// is a safe experiment is the guard's job (src/guard.js, rules G1 to G10).
import { createHash } from 'node:crypto';

// Used as a file name (approvals/<id>.json), so it must not be able to leave the folder.
export const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const TOP_LEVEL = ['id', 'sentence', 'hypothesis', 'environment', 'flag', 'metric', 'split',
  'identity', 'stopRule', 'decisionRule', 'traffic'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string';
const isText = (v) => isString(v) && v.trim() !== '';

export function validatePlan(plan) {
  const errors = [];
  const need = (ok, message) => { if (!ok) errors.push(message); };

  if (!isObject(plan)) return { ok: false, errors: ['plan must be a JSON object'] };

  for (const field of TOP_LEVEL) need(field in plan, `${field} is missing`);
  for (const field of Object.keys(plan)) need(TOP_LEVEL.includes(field), `${field} is not a plan field`);

  if ('id' in plan) need(isString(plan.id) && PLAN_ID_PATTERN.test(plan.id), 'id must be 1 to 64 characters: a-z, 0-9, "_" or "-", starting with a letter or digit');
  for (const field of ['sentence', 'hypothesis', 'environment']) {
    if (field in plan) need(isText(plan[field]), `${field} must be non-empty text`);
  }

  const { flag, metric, split, identity, stopRule, decisionRule, traffic } = plan;
  if ('flag' in plan) {
    if (!isObject(flag)) errors.push('flag must be an object');
    else {
      need(isString(flag.key), 'flag.key must be text');
      need(isString(flag.type), 'flag.type must be text (for example "multivariate")');
      if (!Array.isArray(flag.variants)) errors.push('flag.variants must be a list');
      else flag.variants.forEach((v, i) => {
        need(isObject(v), `flag.variants[${i}] must be an object`);
        if (isObject(v)) {
          need(isString(v.key), `flag.variants[${i}].key must be text`);
          need(isString(v.value), `flag.variants[${i}].value must be text`);
        }
      });
    }
  }
  if ('metric' in plan) {
    if (!isObject(metric)) errors.push('metric must be an object');
    else for (const f of ['name', 'event', 'direction']) need(isString(metric[f]), `metric.${f} must be text`);
  }
  if ('split' in plan) {
    if (!isObject(split)) errors.push('split must be an object of variation key to percentage');
    else for (const [k, v] of Object.entries(split)) need(typeof v === 'number', `split.${k} must be a number`);
  }
  if ('identity' in plan) {
    if (!isObject(identity)) errors.push('identity must be an object');
    else {
      need(isString(identity.source), 'identity.source must be text');
      need(Array.isArray(identity.usedFor) && identity.usedFor.every(isString), 'identity.usedFor must be a list of text');
      need(isString(identity.prefixReal), 'identity.prefixReal must be text');
      need(isString(identity.prefixScripted), 'identity.prefixScripted must be text');
    }
  }
  if ('stopRule' in plan) {
    if (!isObject(stopRule)) errors.push('stopRule must be an object');
    else {
      need(isString(stopRule.type), 'stopRule.type must be text');
      need(typeof stopRule.value === 'number' || isString(stopRule.value), 'stopRule.value must be a number or text');
    }
  }
  if ('decisionRule' in plan) {
    if (!isObject(decisionRule)) errors.push('decisionRule must be an object');
    else {
      need(isString(decisionRule.primaryMetric), 'decisionRule.primaryMetric must be text');
      const p = decisionRule.winProbabilityAtLeast;
      need(typeof p === 'number' && p > 0 && p < 1, 'decisionRule.winProbabilityAtLeast must be a number between 0 and 1');
      need(decisionRule.intervalExcludesZero === true, 'decisionRule.intervalExcludesZero must be true');
    }
  }
  if ('traffic' in plan) {
    if (!isObject(traffic)) errors.push('traffic must be an object');
    else for (const f of ['real', 'scripted']) need(typeof traffic[f] === 'boolean', `traffic.${f} must be true or false`);
  }

  return { ok: errors.length === 0, errors };
}

// Keys sorted recursively (by UTF-16 code unit, which matches code point order for all
// characters below U+10000), arrays in their given order, no whitespace.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: cannot represent a value of type ${typeof value}`);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function planSha256(plan) {
  return sha256Hex(canonicalJson(plan));
}
