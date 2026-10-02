import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');

test('loadState of a missing file is a fresh state', () => {
  assert.deepEqual(loadState(tmp()), { failures: 0, modules: {} });
});

test('saveState round-trips, keeps unrelated keys like the digest, and leaves no temp file', () => {
  const f = tmp();
  const state = { failures: 2, modules: { a: { seen: ['x'], initialized: true } }, digest: { last: '2026-10-03' } };
  saveState(f, state);
  assert.deepEqual(loadState(f), state);
  assert.ok(!existsSync(f + '.tmp'));
  assert.deepEqual(readdirSync(join(f, '..')), ['state.json']);
});

test('saveState keeps only the newest 2000 seen keys per module', () => {
  const f = tmp();
  const seen = Array.from({ length: 2500 }, (_, i) => `k${i}`);
  saveState(f, { failures: 0, modules: { a: { seen, initialized: true } } });
  const back = loadState(f).modules.a.seen;
  assert.equal(back.length, 2000);
  assert.equal(back[0], 'k500');
  assert.equal(back.at(-1), 'k2499');
});
