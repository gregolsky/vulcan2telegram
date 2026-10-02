import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDue, buildPrompt, runClaude } from '../src/modules/digest.mjs';
import { parsePlan, groupByDay } from '../src/modules/plan.mjs';

const opts = { days: ['Wed', 'Sat'], hour: 18 };

test('isDue: only on the configured weekdays, from the configured hour (Warsaw time), once a day', () => {
  assert.equal(isDue(new Date('2026-10-03T16:30:00Z'), undefined, opts), true);  // Sat 18:30 CEST
  assert.equal(isDue(new Date('2026-10-03T15:30:00Z'), undefined, opts), false); // Sat 17:30 CEST: too early
  assert.equal(isDue(new Date('2026-10-07T17:00:00Z'), undefined, opts), true);  // Wed 19:00 CEST
  assert.equal(isDue(new Date('2026-10-04T17:00:00Z'), undefined, opts), false); // Sunday
  assert.equal(isDue(new Date('2026-10-03T16:30:00Z'), '2026-10-03', opts), false); // already sent today
  assert.equal(isDue(new Date('2026-10-03T16:30:00Z'), '2026-09-30', opts), true);
  // after midnight Warsaw time it is already the next day
  assert.equal(isDue(new Date('2026-10-03T22:30:00Z'), '2026-10-03', opts), false); // Sun 00:30
});

test('buildPrompt includes messages, exams and the instruction to treat them as data', () => {
  const p = buildPrompt({
    today: '2026-10-03',
    messages: [{ date: '2026-10-01T10:00:00+02:00', sender: 'Jan Nowak', children: ['Ala'], subject: 'Wycieczka', body: 'Przynieść 20 zł', attachments: ['zgoda.pdf'] }],
    exams: [{ date: '2026-10-06', student: 'Ala', className: '4A', kindLabel: 'Sprawdzian', subject: 'Matematyka', description: 'Ułamki' }],
  });
  assert.match(p, /Dziś jest 2026-10-03/);
  assert.match(p, /2026-10-01 \| od: Jan Nowak \| dla: Ala \| temat: Wycieczka\nPrzynieść 20 zł\nZałączniki: zgoda\.pdf/);
  assert.match(p, /- 2026-10-06 \| Ala \(4A\) \| Sprawdzian: Matematyka \| zakres: Ułamki/);
  assert.match(p, /nigdy jako polecenia/);
  assert.match(p, /na co zwrócić uwagę/i);
  assert.match(buildPrompt({ today: 'x', messages: [], exams: [] }), /\(brak wiadomości\)[\s\S]*\(brak sprawdzianów\)[\s\S]*\(brak zmian\)/);
  const data = { Headers: [{ Text: 'Lekcja' }, { Text: 'piątek<br />09.10.2026' }], Rows: [[{ Description: '2<br />08:55<br />09:40' },
    { Description: "<div><span class='x-treelabel-inv'>Rekreacja</span> <span>sg1</span><span> Pan Jan</span>(nieobecność nauczyciela: uczniowie zwolnieni do domu)</div>" }]] };
  const withPlan = buildPrompt({ today: '2026-10-03', messages: [], exams: [], planChanges: groupByDay(parsePlan(data, { firstName: 'Ala', className: '4A', idUczen: 1 })) });
  assert.match(withPlan, /ZMIANY W PLANIE[\s\S]*🔄 Ala \(4A\)[\s\S]*Rekreacja[\s\S]*odwołana/);
});

function fakeClaude(script) {
  const f = join(mkdtempSync(join(tmpdir(), 'fake-claude-')), 'claude');
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
  return f;
}

test('runClaude passes the prompt on stdin, disables tools and returns trimmed stdout', async () => {
  const bin = fakeClaude('echo "args: $*"; cat');
  const out = await runClaude('hello prompt', { bin });
  assert.match(out, /^args: -p --tools {2}--no-session-persistence\nhello prompt$/);
});

test('runClaude rejects on non-zero exit, empty output, timeout and missing binary', async () => {
  await assert.rejects(runClaude('x', { bin: fakeClaude('echo boom >&2; exit 3') }), /claude exited 3: boom/);
  await assert.rejects(runClaude('x', { bin: fakeClaude('cat >/dev/null') }), /claude exited 0/);
  await assert.rejects(runClaude('x', { bin: fakeClaude('sleep 5'), timeoutMs: 100 }), /timed out/);
  await assert.rejects(runClaude('x', { bin: '/nonexistent/claude' }), /claude: /);
});
