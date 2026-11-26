// Readout: plain code. Turns Flagsmith's results into one of three decisions:
//   not_ready        the pre-registered stop rule is not met yet (no numbers to act on are shown)
//   no_clear_winner  stop rule met, but no variation clears the decision rule (says why)
//   winner_candidate stop rule met, interval excludes zero in the right direction, chance to win
//                    at or above the plan's threshold, no sample ratio mismatch.
//                    A person still decides what to roll out.
// Fields read (recorded call 26): results.payload.metrics[].{metric_id, variants{n, sum},
// inference{lift, ci_low, ci_high, chance_to_win}}, payload.exposures_timeseries, payload.srm_p_value.
import { canRefresh } from './flagsmith-client.js';

const CONTROL_KEY = 'control';
const SRM_ALPHA = 0.01;

const pct = (x, digits = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
const share = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;

function trafficNote(traffic) {
  if (traffic?.scripted) {
    return 'These results include scripted sim_ traffic with made-up conversion rates. Flagsmith results do not separate sim_ from web_ visitors, so they are not evidence about real users.';
  }
  return 'Real visitors only (web_ ids).';
}

function exposuresFrom(payload, metric, keys) {
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  const points = payload.exposures_timeseries?.points ?? [];
  if (points.length) {
    for (const p of points) for (const [k, n] of Object.entries(p.new_identities ?? {})) if (k in totals) totals[k] += n;
  } else {
    for (const k of keys) totals[k] = metric.variants?.[k]?.n ?? 0;
  }
  return totals;
}

export function readout({ plan, results, metricId, now = new Date() }) {
  const keys = plan.flag.variants.map((v) => v.key);
  const base = { traffic: plan.traffic, trafficNote: trafficNote(plan.traffic), asOf: results?.results?.as_of ?? null };
  const notReady = (reason, extra = {}) => ({ decision: 'not_ready', reasons: [reason], ...extra, ...base });

  const payload = results?.results?.payload;
  if (!payload) return notReady('Flagsmith has not computed results yet.');
  const metric = (payload.metrics ?? []).find((m) => m.metric_id === metricId);
  if (!metric) return notReady(`The results have no data for metric ${metricId} yet.`);

  const exposures = exposuresFrom(payload, metric, keys);
  const rule = plan.stopRule;
  if (rule.type === 'minExposuresPerVariant') {
    if (keys.some((k) => exposures[k] < rule.value)) {
      return notReady(`Stop rule not met: needs ${rule.value} exposures per variation; have ${keys.map((k) => `${k} ${exposures[k]} of ${rule.value}`).join(', ')}. Keep the experiment running.`, { exposures });
    }
  } else if (rule.type === 'fixedEnd') {
    if (now.getTime() < Date.parse(rule.value)) {
      return notReady(`Stop rule not met: the fixed end ${rule.value} has not been reached. Keep the experiment running.`, { exposures });
    }
  } else {
    return notReady(`Unknown stop rule ${JSON.stringify(rule.type)}; refusing to decide.`, { exposures });
  }

  const control = metric.variants?.[CONTROL_KEY] ?? { n: 0, sum: 0 };
  const controlRate = control.n ? control.sum / control.n : null;
  const variants = {};
  for (const k of keys) {
    const v = metric.variants?.[k] ?? { n: 0, sum: 0 };
    const row = { n: v.n, conversions: v.sum, rate: v.n ? v.sum / v.n : null };
    const inf = metric.inference?.[k];
    if (k !== CONTROL_KEY && inf) {
      row.lift = inf.lift;
      row.computedLift = controlRate ? row.rate / controlRate - 1 : null;
      row.interval = [inf.ci_low, inf.ci_high];
      row.chanceToWin = inf.chance_to_win;
    }
    variants[k] = row;
  }

  const reasons = [];
  const threshold = plan.decisionRule.winProbabilityAtLeast;
  const up = plan.metric.direction !== 'down';
  const srm = payload.srm_p_value;
  const srmProblem = typeof srm === 'number' && srm < SRM_ALPHA;
  if (srmProblem) reasons.push(`Sample ratio mismatch (p = ${srm}): traffic did not split as configured. Do not act on these numbers.`);

  const candidates = [];
  for (const k of keys.filter((key) => key !== CONTROL_KEY)) {
    const row = variants[k];
    if (row.interval === undefined) {
      reasons.push(`${k}: no inference from Flagsmith yet.`);
      continue;
    }
    const [lo, hi] = row.interval;
    const ci = `[${pct(lo)}, ${pct(hi)}]`;
    let ok = true;
    if (lo <= 0 && hi >= 0) {
      reasons.push(`${k}: the 95% credible interval ${ci} includes zero.`);
      ok = false;
    } else if ((up && hi < 0) || (!up && lo > 0)) {
      reasons.push(`${k}: the 95% credible interval ${ci} is entirely ${up ? 'below' : 'above'} zero, the wrong direction for this metric.`);
      ok = false;
    }
    if (row.chanceToWin < threshold) {
      reasons.push(`${k}: chance to beat control ${share(row.chanceToWin)} is below ${share(threshold, 0)}.`);
      ok = false;
    }
    if (row.computedLift !== null && row.lift !== undefined && Math.abs(row.computedLift - row.lift) > 1e-6) {
      reasons.push(`${k}: note: Flagsmith's lift ${pct(row.lift)} differs from conversions/exposures ${pct(row.computedLift)}.`);
    }
    if (ok) candidates.push(k);
  }

  if (srmProblem || candidates.length === 0) {
    return { decision: 'no_clear_winner', reasons, exposures, variants, ...base };
  }
  const winner = candidates.sort((a, b) => variants[b].chanceToWin - variants[a].chanceToWin)[0];
  const w = variants[winner];
  reasons.unshift(`${winner}: stop rule met; 95% credible interval [${pct(w.interval[0])}, ${pct(w.interval[1])}] excludes zero; chance to beat control ${share(w.chanceToWin)} is at least ${share(threshold, 0)}. A person decides whether to roll it out.`);
  return { decision: 'winner_candidate', winner, reasons, exposures, variants, ...base };
}

export function formatReadout(r) {
  const lines = [`Decision: ${r.decision}${r.winner ? ` (candidate: ${r.winner})` : ''}`];
  if (r.exposures) lines.push(`Exposures: ${Object.entries(r.exposures).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const [k, v] of Object.entries(r.variants ?? {})) {
    let line = `  ${k.padEnd(10)} ${v.conversions}/${v.n} = ${v.rate === null ? 'n/a' : share(v.rate)}`;
    if (v.interval) line += `  lift ${pct(v.lift)}  95% CI [${pct(v.interval[0])}, ${pct(v.interval[1])}]  chance to beat control ${share(v.chanceToWin)}`;
    lines.push(line);
  }
  if (r.reasons.length) {
    lines.push('Why:');
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
  }
  lines.push(`Traffic: ${r.trafficNote}`);
  if (r.asOf) lines.push(`Results as of ${r.asOf} (Flagsmith).`);
  return lines.join('\n');
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Finds the plan's experiment by name, optionally refreshes its results (respecting the
// 5-minute limit), and returns the readout.
export async function fetchAndRead({ plan, client, refresh = false, now = () => new Date(), waitMs = 90_000, pollMs = 10_000, sleep = sleepMs, log = () => {} }) {
  const matches = (await client.listExperiments(plan.id)).filter((e) => e.name === plan.id);
  if (matches.length !== 1) throw new Error(`expected one experiment named ${JSON.stringify(plan.id)}, found ${matches.length}`);
  const experiment = await client.getExperiment(matches[0].id);
  const metric = (experiment.metrics ?? []).find((m) => m.metric_name === plan.metric.name) ?? experiment.metrics?.[0];
  if (!metric) throw new Error(`experiment ${experiment.id} has no metric`);

  let refreshed = false;
  let stale = false;
  if (refresh) {
    const before = await client.getResults(experiment.id);
    const allowed = canRefresh(before, now());
    if (!allowed.ok) {
      log(`Refresh not allowed for another ${Math.ceil(allowed.waitMs / 1000)} s (at most once every 5 minutes); reading the current results.`);
    } else {
      await client.refreshResults(experiment.id);
      refreshed = true;
      const requestedAt = now().getTime();
      stale = true;
      for (let waited = 0; waited < waitMs; waited += pollMs) {
        await sleep(pollMs);
        const asOf = Date.parse((await client.getResults(experiment.id))?.results?.as_of ?? '');
        if (asOf >= requestedAt - 1000) { stale = false; break; }
      }
    }
  }
  const results = await client.getResults(experiment.id);
  return {
    experimentId: experiment.id,
    experimentStatus: experiment.status,
    metricId: metric.metric,
    refreshed,
    stale,
    readout: readout({ plan, results, metricId: metric.metric, now: now() }),
  };
}
