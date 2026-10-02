import test from 'node:test';
import assert from 'node:assert/strict';
import { runAll, FAIL_ALERT_AT, FAIL_REMIND_EVERY } from '../src/runner.mjs';

const item = (key, over = {}) => ({ keys: [key], text: key, ...over });

/** A fake module whose fetch reports `items` as new unless their keys are already seen. */
const mod = (name, { items = [], thread = '5', alwaysOn = false, fail } = {}) => {
  const m = {
    name, alwaysOn, thread: () => thread, calls: [],
    format: i => `${name}:${i.text}`,
    async fetch(_session, { isSeen, now }) {
      m.calls.push({ seeded: isSeen('anything'), now });
      if (fail) throw new Error(fail);
      return { allKeys: items.flatMap(i => i.keys), fresh: items.filter(i => i.keys.some(k => !isSeen(k))) };
    },
  };
  return m;
};

function harness(over = {}) {
  const h = {
    state: { failures: 0, modules: {} }, sent: [], alerts: [], logs: [], errors: [], persisted: [], closed: 0,
    ...over,
  };
  h.deps = {
    state: h.state,
    persist: () => h.persisted.push(JSON.stringify(h.state.modules)),
    deliver: async (t, thread) => { if (h.deliverError?.(t)) throw h.deliverError(t); h.sent.push([t, thread]); },
    alert: async (m) => { h.alerts.push(m); },
    openSession: async () => { if (h.loginError) throw new Error(h.loginError); return { close: () => { h.closed++; } }; },
    flags: {}, maxPerRun: 20, now: () => new Date('2026-10-03T12:00:00Z'),
    log: m => h.logs.push(m), logError: m => h.errors.push(m),
  };
  return h;
}
const seenOf = (h, name) => h.state.modules[name].seen;

test('first run only records existing items: nothing is delivered and fetch is told everything is seen', async () => {
  const h = harness();
  const m = mod('exams', { items: [item('a'), item('b')] });
  assert.equal(await runAll({ ...h.deps, modules: [m] }), 0);
  assert.deepEqual(h.sent, []);
  assert.equal(m.calls[0].seeded, true);
  assert.deepEqual(h.state.modules.exams, { seen: ['a', 'b'], initialized: true });
});

test('--send-existing delivers on the first run, to the module topic, oldest first as fetched', async () => {
  const h = harness();
  h.deps.flags = { sendExisting: true };
  await runAll({ ...h.deps, modules: [mod('exams', { items: [item('a'), item('b')], thread: '13' })] });
  assert.deepEqual(h.sent, [['exams:a', '13'], ['exams:b', '13']]);
  assert.deepEqual(seenOf(h, 'exams'), ['a', 'b']);
});

test('later runs deliver only unseen items, and a repeat run sends nothing', async () => {
  const h = harness();
  h.state.modules.exams = { seen: ['a'], initialized: true };
  const m = mod('exams', { items: [item('a'), item('b')] });
  await runAll({ ...h.deps, modules: [m] });
  assert.deepEqual(h.sent.map(s => s[0]), ['exams:b']);
  await runAll({ ...h.deps, modules: [m] });
  assert.equal(h.sent.length, 1);
});

test('MAX_PER_RUN caps a run; the rest stays unseen for the next one', async () => {
  const h = harness();
  h.state.modules.m = { seen: [], initialized: true };
  h.deps.maxPerRun = 2;
  const m = mod('m', { items: [item('a'), item('b'), item('c')] });
  await runAll({ ...h.deps, modules: [m] });
  assert.deepEqual(seenOf(h, 'm'), ['a', 'b']);
  await runAll({ ...h.deps, modules: [m] });
  assert.deepEqual(seenOf(h, 'm'), ['a', 'b', 'c']);
});

test('state is persisted after every delivered item, so a crash cannot cause duplicates', async () => {
  const h = harness();
  h.state.modules.m = { seen: [], initialized: true };
  await runAll({ ...h.deps, modules: [mod('m', { items: [item('a'), item('b')] })] });
  const seenAfterEach = h.persisted.map(p => JSON.parse(p).m?.seen.length);
  assert.ok(seenAfterEach.includes(1) && seenAfterEach.includes(2));
});

test('items whose keys are all seen already are not delivered twice; silent items only record keys', async () => {
  const h = harness();
  h.state.modules.m = { seen: [], initialized: true };
  const m = mod('m', { items: [item('a'), item('a'), item('late', { silent: true })] });
  await runAll({ ...h.deps, modules: [m] });
  assert.deepEqual(h.sent.map(s => s[0]), ['m:a']);
  assert.deepEqual(seenOf(h, 'm'), ['a', 'late']);
});

test('an item Telegram permanently rejects is skipped with an alert instead of blocking the queue', async () => {
  const h = harness();
  h.state.modules.m = { seen: [], initialized: true };
  h.deliverError = t => (t === 'm:bad' ? Object.assign(new Error('Telegram 400'), { status: 400 }) : null);
  assert.equal(await runAll({ ...h.deps, modules: [mod('m', { items: [item('bad'), item('good')] })] }), 0);
  assert.deepEqual(h.sent.map(s => s[0]), ['m:good']);
  assert.deepEqual(seenOf(h, 'm'), ['bad', 'good']);
  assert.match(h.alerts[0], /skipped an item Telegram rejects/);
});

test('transient delivery errors (5xx, 429, network) keep the item unseen and fail the module', async () => {
  for (const status of [500, 429, undefined]) {
    const h = harness();
    h.state.modules.m = { seen: [], initialized: true };
    h.deliverError = () => Object.assign(new Error('boom'), { status });
    assert.equal(await runAll({ ...h.deps, modules: [mod('m', { items: [item('a')] })] }), 1);
    assert.deepEqual(seenOf(h, 'm'), []);
    assert.match(h.errors[0], /m: boom/);
  }
});

test('one failing module does not stop the others; the session is always closed', async () => {
  const h = harness();
  h.deps.flags = { sendExisting: true };
  const code = await runAll({ ...h.deps, modules: [mod('a', { fail: 'api down' }), mod('b', { items: [item('x')] })] });
  assert.equal(code, 1);
  assert.deepEqual(h.sent.map(s => s[0]), ['b:x']);
  assert.equal(h.closed, 1);
  assert.equal(h.state.failures, 1);
});

test('a login failure fails the run without touching modules', async () => {
  const h = harness({ loginError: 'wrong password' });
  const m = mod('a');
  assert.equal(await runAll({ ...h.deps, modules: [m] }), 1);
  assert.equal(m.calls.length, 0);
  assert.match(h.errors[0], /login: wrong password/);
});

test('failure counter: alert exactly at 3, not at 2 or 4, again after the reminder interval; success resets', async () => {
  const h = harness();
  const failing = [mod('a', { fail: 'x' })];
  const counts = [];
  for (let i = 1; i <= FAIL_ALERT_AT + 1; i++) { await runAll({ ...h.deps, modules: failing }); counts.push(h.alerts.length); }
  assert.deepEqual(counts, [0, 0, 1, 1]);
  assert.match(h.alerts[0], /failed 3 runs in a row/);

  h.state.failures = FAIL_ALERT_AT + FAIL_REMIND_EVERY - 1;
  await runAll({ ...h.deps, modules: failing });
  assert.equal(h.alerts.length, 2);

  await runAll({ ...h.deps, modules: [mod('a')] });
  assert.equal(h.state.failures, 0);
});

test('alert delivery errors never break the run', async () => {
  const h = harness();
  h.state.failures = FAIL_ALERT_AT - 1;
  h.deps.alert = async () => { throw new Error('telegram down'); };
  assert.equal(await runAll({ ...h.deps, modules: [mod('a', { fail: 'x' })] }), 1);
});

test('--only selects modules; modules without a topic stay off unless always-on; dry-run runs them all', async () => {
  const h = harness();
  h.state.modules = { a: { seen: [], initialized: true }, b: { seen: [], initialized: true }, c: { seen: [], initialized: true } };
  const [a, b, c] = [mod('a'), mod('b', { thread: '' }), mod('c', { thread: '', alwaysOn: true })];
  await runAll({ ...h.deps, modules: [a, b, c] });
  assert.deepEqual([a, b, c].map(m => m.calls.length), [1, 0, 1]);

  await runAll({ ...h.deps, modules: [a, b, c], flags: { only: ['a'] } });
  assert.deepEqual([a, b, c].map(m => m.calls.length), [2, 0, 1]);

  await runAll({ ...h.deps, modules: [a, b, c], flags: { dryRun: true } });
  assert.deepEqual([a, b, c].map(m => m.calls.length), [3, 1, 2]);
});

test('dry-run does not count failures or alert, but still reports a failing exit code', async () => {
  const h = harness();
  h.state.failures = FAIL_ALERT_AT - 1;
  assert.equal(await runAll({ ...h.deps, flags: { dryRun: true }, modules: [mod('a', { fail: 'x' })] }), 1);
  assert.equal(h.state.failures, FAIL_ALERT_AT - 1);
  assert.deepEqual(h.alerts, []);
});

test('the digest runs after the modules with the session and the injected clock; its errors fail the run', async () => {
  const h = harness();
  const calls = [];
  const digest = async (session, now) => { calls.push([typeof session.close, now.toISOString()]); };
  assert.equal(await runAll({ ...h.deps, modules: [], digest }), 0);
  assert.deepEqual(calls, [['function', '2026-10-03T12:00:00.000Z']]);

  assert.equal(await runAll({ ...h.deps, modules: [], digest: async () => { throw new Error('claude exited 1'); } }), 1);
  assert.match(h.errors.at(-1), /digest: claude exited 1/);
});

test('fetch receives the injected time', async () => {
  const h = harness();
  const m = mod('a');
  await runAll({ ...h.deps, modules: [m] });
  assert.equal(m.calls[0].now.toISOString(), '2026-10-03T12:00:00.000Z');
});
