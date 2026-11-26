// The CreatorDigest test page (site/). Written before site/app.js existed.
// app.js exports its logic and only touches the DOM in a browser, so these tests drive it
// with a fake Flagsmith SDK, a fake document and a fake localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const load = () => import('../site/app.js');
const PLAN = JSON.parse(read('plans/pilot_rehearsal_1.json'));

// --- fakes ----------------------------------------------------------------------

function fakeDocument() {
  const el = (id) => ({
    id, textContent: '', hidden: false, listeners: {},
    classList: { removed: [], remove(c) { this.removed.push(c); } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  });
  const nodes = Object.fromEntries(['headline', 'subline', 'example', 'cta', 'message'].map((id) => [id, el(id)]));
  return { nodes, body: { dataset: {} }, getElementById: (id) => nodes[id] ?? null };
}

function fakeStorage({ broken = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem(k) { if (broken) throw new Error('blocked'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('blocked'); data.set(k, String(v)); },
  };
}

function fakeFlagsmith({ value = 'control', initError = null, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    init: (opts) => { calls.push(['init', opts]); if (hang) return new Promise(() => {}); return initError ? Promise.reject(initError) : Promise.resolve(); },
    identify: (id) => { calls.push(['identify', id]); return Promise.resolve(); },
    getExperimentFlag: (key) => { calls.push(['getExperimentFlag', key]); return value === null ? null : { enabled: true, value }; },
    trackEvent: (name, opts) => { calls.push(['trackEvent', name, opts]); },
    trackExposureEvent: (...a) => { calls.push(['trackExposureEvent', ...a]); },
    flushEvents: () => { calls.push(['flushEvents']); return Promise.resolve(); },
  };
}

const CONFIG = { FLAGSMITH_ENVIRONMENT_KEY: 'fake-client-key', FLAGSMITH_ENVIRONMENT_NAME: 'Development', FLAG_KEY: 'pilot_rehearsal_1' };
const names = (calls) => calls.map((c) => c[0]);

// --- copy and constants -----------------------------------------------------------

test('the guard (G1-G10) passes plans/pilot_rehearsal_1.json with site/app.js as the app', async () => {
  const { checkPlan } = await import('../src/guard.js');
  assert.deepEqual(checkPlan(PLAN, { appSource: read('site/app.js') }), { ok: true, violations: [] });
});

test('one named event constant and one fallback constant', async () => {
  const app = await load();
  assert.equal(app.CTA_EVENT, 'cta_clicked');
  assert.equal(app.FALLBACK_VALUE, 'control');
  assert.equal(app.THANKS_TEXT, 'Thanks. This is a test page; nothing was stored.');
});

test('copy: control and variant_b differ in headline and sub-line; variant_b adds an example line', async () => {
  const { copyFor } = await load();
  const control = copyFor('control');
  const b = copyFor('variant_b');
  assert.equal(control.headline, 'Your creator digest, summarized by AI');
  assert.equal(b.headline, "Yesterday's 5 biggest creator posts, in 60 seconds. See today's.");
  assert.notEqual(control.subline, b.subline);
  assert.equal(control.example, null);
  assert.match(b.example, /^Example: /);
});

test('copy: an unknown or missing value gets the fallback (control) copy', async () => {
  const { copyFor } = await load();
  for (const v of ['variant_c', '', null, undefined, 42]) assert.deepEqual(copyFor(v), copyFor('control'));
});

// --- visitor id ---------------------------------------------------------------------

test('visitor id: "web_" + random, stored and reused; still works if storage is blocked', async () => {
  const { getVisitorId } = await load();
  const storage = fakeStorage();
  const first = getVisitorId(storage, () => 'abc123');
  assert.equal(first, 'web_abc123');
  assert.equal(getVisitorId(storage, () => 'other'), 'web_abc123', 'same browser, same id');
  assert.equal(getVisitorId(fakeStorage({ broken: true }), () => 'xyz'), 'web_xyz');
  assert.ok(!getVisitorId(fakeStorage(), () => 'q').startsWith('sim_'));
});

// --- run: flag, exposure, fallback -------------------------------------------------

test('run: init with enableEvents, identify, then getExperimentFlag; renders variant_b', async () => {
  const { run } = await load();
  const doc = fakeDocument();
  const fs = fakeFlagsmith({ value: 'variant_b' });
  const r = await run({ document: doc, flagsmith: fs, config: CONFIG, storage: fakeStorage(), randomId: () => 'r1' });
  assert.deepEqual(fs.calls.slice(0, 3), [
    ['init', { environmentID: 'fake-client-key', enableEvents: true }],
    ['identify', 'web_r1'],
    ['getExperimentFlag', 'pilot_rehearsal_1'],
  ]);
  assert.equal(r.value, 'variant_b');
  assert.equal(r.source, 'flagsmith');
  assert.equal(doc.nodes.headline.textContent, "Yesterday's 5 biggest creator posts, in 60 seconds. See today's.");
  assert.equal(doc.nodes.example.hidden, false);
  assert.equal(doc.body.dataset.variant, 'variant_b');
  assert.ok(!names(fs.calls).includes('trackExposureEvent'), 'exposure only through getExperimentFlag');
});

test('run: control hides the example line', async () => {
  const { run } = await load();
  const doc = fakeDocument();
  await run({ document: doc, flagsmith: fakeFlagsmith({ value: 'control' }), config: CONFIG, storage: fakeStorage(), randomId: () => 'r' });
  assert.equal(doc.nodes.headline.textContent, 'Your creator digest, summarized by AI');
  assert.equal(doc.nodes.example.hidden, true);
});

test('run: an unknown value or a missing flag shows the fallback copy', async () => {
  const { run } = await load();
  for (const value of ['variant_zzz', null]) {
    const doc = fakeDocument();
    const r = await run({ document: doc, flagsmith: fakeFlagsmith({ value }), config: CONFIG, storage: fakeStorage(), randomId: () => 'r' });
    assert.equal(doc.nodes.headline.textContent, 'Your creator digest, summarized by AI');
    assert.equal(r.value, 'control');
  }
});

test('run: Flagsmith unreachable (init fails) shows the fallback and records nothing', async () => {
  const { run } = await load();
  const doc = fakeDocument();
  const fs = fakeFlagsmith({ initError: new Error('network down') });
  const r = await run({ document: doc, flagsmith: fs, config: CONFIG, storage: fakeStorage(), randomId: () => 'r' });
  assert.equal(r.source, 'fallback');
  assert.equal(doc.nodes.headline.textContent, 'Your creator digest, summarized by AI');
  assert.ok(!names(fs.calls).includes('getExperimentFlag'));
});

test('run: Flagsmith too slow (timeout) shows the fallback', async () => {
  const { run } = await load();
  const doc = fakeDocument();
  const r = await run({ document: doc, flagsmith: fakeFlagsmith({ hang: true }), config: CONFIG, storage: fakeStorage(), randomId: () => 'r', timeoutMs: 20 });
  assert.equal(r.source, 'fallback');
  assert.equal(doc.nodes.headline.textContent, 'Your creator digest, summarized by AI');
});

// --- the button ------------------------------------------------------------------------

test('click: trackEvent(CTA_EVENT) with the same id, then flushEvents, then the thank-you line', async () => {
  const { run, CTA_EVENT, THANKS_TEXT } = await load();
  const doc = fakeDocument();
  const fs = fakeFlagsmith({ value: 'variant_b' });
  await run({ document: doc, flagsmith: fs, config: CONFIG, storage: fakeStorage(), randomId: () => 'r9' });
  await doc.nodes.cta.listeners.click();
  const after = fs.calls.slice(3);
  assert.deepEqual(after, [['trackEvent', CTA_EVENT, { identifier: 'web_r9' }], ['flushEvents']]);
  assert.equal(doc.nodes.message.textContent, THANKS_TEXT);
});

test('click in fallback mode sends no event but still thanks the visitor', async () => {
  const { run, THANKS_TEXT } = await load();
  const doc = fakeDocument();
  const fs = fakeFlagsmith({ initError: new Error('down') });
  await run({ document: doc, flagsmith: fs, config: CONFIG, storage: fakeStorage(), randomId: () => 'r' });
  await doc.nodes.cta.listeners.click();
  assert.ok(!names(fs.calls).includes('trackEvent'));
  assert.equal(doc.nodes.message.textContent, THANKS_TEXT);
});

// --- files ---------------------------------------------------------------------------

test('index.html: elements, the button, the module script and the honest footer line', () => {
  const html = read('site/index.html');
  for (const id of ['headline', 'subline', 'example', 'cta', 'message']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, />\s*Get early access\s*</);
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.ok(html.includes('Test page for a hackathon A/B test. No emails or personal data are collected.'));
  assert.match(html, /CreatorDigest/);
});

test('config.js: committed config is the Production client key and the flag key; Development lives in git-ignored config.local.js', async () => {
  const config = await import('../site/config.js');
  assert.equal(config.FLAG_KEY, 'creatordigest_headline');
  assert.equal(config.FLAGSMITH_ENVIRONMENT_NAME, 'Production');
  assert.match(config.FLAGSMITH_ENVIRONMENT_KEY, /^[A-Za-z0-9]{10,40}$/, 'a client-side key, not a server key or admin token');
  assert.match(read('.gitignore'), /^\*\.local\.js$/m);
});

test('the vendored SDK is byte-identical to the installed @flagsmith/flagsmith 12.6.0', (t) => {
  const installed = fileURLToPath(new URL('../node_modules/@flagsmith/flagsmith/index.mjs', import.meta.url));
  if (!existsSync(installed)) return t.skip('run npm ci first');
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const vendored = fileURLToPath(new URL('../site/vendor/flagsmith-12.6.0.mjs', import.meta.url));
  assert.equal(sha(vendored), sha(installed));
  assert.equal(sha(vendored), '9838a2e93bd8b00675675f7fa20df7119602d0179c84ce91b830e8b3eaaf64c4');
});

// --- local server ---------------------------------------------------------------------

test('serve-site: serves the page, refuses paths outside site/, localhost only', async () => {
  const { startSiteServer } = await import('../scripts/serve-site.mjs');
  const server = await startSiteServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const js = await fetch(`${base}/app.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/nope.js']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    }
    assert.equal(server.host, '127.0.0.1');
  } finally { await server.close(); }
});
