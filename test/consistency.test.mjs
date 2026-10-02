import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the Playwright base image tag matches the exact Playwright version in package.json and the lockfile', () => {
  const image = read('Dockerfile').match(/^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/m)?.[1];
  const wanted = JSON.parse(read('package.json')).dependencies.playwright;
  const locked = JSON.parse(read('package-lock.json')).packages['node_modules/playwright'].version;
  assert.match(wanted, /^\d+\.\d+\.\d+$/, 'package.json must pin playwright exactly');
  assert.equal(image, wanted);
  assert.equal(image, locked);
});

test('.env.example lists every variable the code reads', () => {
  const example = read('.env.example');
  const used = new Set([...read('src/config.mjs').matchAll(/env\('([A-Z_]+)'/g)].map(m => m[1]));
  for (const name of used) assert.match(example, new RegExp(`^#? ?${name}=`, 'm'), `${name} missing from .env.example`);
});
