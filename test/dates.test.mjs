import test from 'node:test';
import assert from 'node:assert/strict';
import { ymd, addDays, mondayOf, plDate } from '../src/dates.mjs';

test('ymd uses Warsaw time, so late evening UTC is already the next day', () => {
  assert.equal(ymd(new Date('2026-10-03T21:30:00Z')), '2026-10-03'); // 23:30 CEST
  assert.equal(ymd(new Date('2026-10-03T22:30:00Z')), '2026-10-04'); // 00:30 CEST
  assert.equal(ymd(new Date('2026-01-15T23:30:00Z')), '2026-01-16'); // CET (UTC+1)
});

test('addDays crosses month and year boundaries, also backwards', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-10-03', 7), '2026-10-10');
});

test('mondayOf across a month boundary and with a negative offset', () => {
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); // Sunday
  assert.equal(mondayOf('2026-10-03', -1), '2026-09-21');
});

test('plDate is a long Polish date with weekday', () => {
  assert.equal(plDate('2026-10-02'), 'piątek, 2 października 2026');
});
