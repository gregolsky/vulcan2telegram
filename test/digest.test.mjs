import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDue, buildPrompt, runClaude, toTelegramHtml, buildDigest, maybeDigest } from '../src/modules/digest.mjs';
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
    messages: [{ date: '2026-10-01T10:00:00+02:00', sender: 'Jan Nowak', children: ['Ala'], subject: 'Wycieczka', body: 'Przynieść 20 zł', attachments: [{ name: 'zgoda.pdf', url: 'https://x/z' }] }],
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

test('toTelegramHtml escapes markup from school messages and converts **bold** to <b>', () => {
  assert.equal(toTelegramHtml('**Środa 7.10**: sprawdzian <b>x</b> & more'), '<b>Środa 7.10</b>: sprawdzian &lt;b&gt;x&lt;/b&gt; &amp; more');
  assert.equal(toTelegramHtml('a **b** c **d**'), 'a <b>b</b> c <b>d</b>');
  assert.equal(toTelegramHtml('unpaired ** stays'), 'unpaired ** stays');
  assert.equal(toTelegramHtml('**a**\n**b**'), '<b>a</b>\n<b>b</b>'); // bold never spans lines
});

test('buildPrompt asks for emoji and bold only', () => {
  const p = buildPrompt({ today: 'x', messages: [], exams: [] });
  assert.match(p, /\*\*pogrubienie\*\*/);
  assert.match(p, /emoji/);
});

test('runClaude decodes multi-byte characters that arrive split across chunks', async () => {
  const bin = fakeClaude("cat >/dev/null; printf '\\304'; sleep 0.3; printf '\\205\\360\\237'; sleep 0.3; printf '\\223\\235 ok'");
  assert.equal(await runClaude('x', { bin }), 'ą📝 ok');
});

// ---- buildDigest -----------------------------------------------------------------------------
const now = new Date('2026-10-03T16:30:00Z'); // Saturday 18:30 Warsaw
const ex = (date, name) => ({ date, student: 'Ala', className: '4A', kindLabel: 'Sprawdzian', subject: name, description: '', keys: [`e:${name}`] });
const pl = (date, lesson) => ({ student: 'Ala', className: '4A', date, lesson, from: '08:00', to: '08:45', subject: 'WF', room: '', teacher: 'A B', kind: 'cancel', note: 'odwołane', subTeacher: '', keys: [`p:${date}:${lesson}`] });

function digestSession() {
  return {
    exams: Promise.resolve([ex('2026-10-02', 'wczoraj'), ex('2026-10-03', 'dzis'), ex('2026-10-10', 'za-7-dni'), ex('2026-10-11', 'za-8-dni')]),
    plan: Promise.resolve([pl('2026-10-02', '1'), pl('2026-10-10', '2'), pl('2026-10-11', '3')]),
    ensureWiadomosci: async () => {},
    ctx: { request: { get: async () => ({ ok: () => true, status: () => 200, json: async () => [] }) } },
  };
}

test('buildDigest passes exams and schedule changes from today through today+7 only', async () => {
  let prompt;
  const out = await buildDigest(digestSession(), { now, run: async (p) => { prompt = p; return 'summary'; } });
  assert.equal(out, 'summary');
  assert.match(prompt, /Dziś jest 2026-10-03/);
  assert.match(prompt, /dzis/);
  assert.match(prompt, /za-7-dni/);
  assert.doesNotMatch(prompt, /wczoraj|za-8-dni/);
  assert.match(prompt, /10 października 2026/); // the plan change on the 10th
  assert.doesNotMatch(prompt, /11 października|2 października/);
});

// ---- maybeDigest -----------------------------------------------------------------------------
function digestHarness(over = {}) {
  const h = { state: { failures: 0, modules: {} }, sent: [], logs: [], persisted: 0, built: 0 };
  h.args = {
    session: {}, state: h.state, persist: () => { h.persisted++; }, deliver: async (t, th) => { h.sent.push([t, th]); },
    enabled: true, now, log: m => h.logs.push(m), build: async () => { h.built++; return '**Ala** <b>'; }, ...over,
  };
  return h;
}

test('maybeDigest posts to General with a header and HTML-safe text, then records the day', async () => {
  const h = digestHarness();
  await maybeDigest(h.args);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1], '');
  assert.match(h.sent[0][0], /^📋 <b>Podsumowanie na kolejne 7 dni<\/b>\n\n<b>Ala<\/b> &lt;b&gt;$/);
  assert.equal(h.state.digest.last, '2026-10-03');
  assert.ok(h.persisted > 0);
  await maybeDigest(h.args); // same day: not due again
  assert.equal(h.sent.length, 1);
});

test('maybeDigest does nothing off-schedule, with --only (skip) or in dry-run, unless forced', async () => {
  for (const over of [{ now: new Date('2026-10-02T16:30:00Z') }, { skip: true }, { dryRun: true }]) {
    const h = digestHarness(over);
    await maybeDigest(h.args);
    assert.equal(h.built, 0);
  }
  const forced = digestHarness({ now: new Date('2026-10-02T16:30:00Z'), force: true, skip: true, dryRun: true });
  await maybeDigest(forced.args);
  assert.equal(forced.sent.length, 1);
  assert.equal(forced.state.digest.last, '2026-10-02');
});

test('maybeDigest without a Claude token logs once a day and does not build or send', async () => {
  const h = digestHarness({ enabled: false });
  await maybeDigest(h.args);
  await maybeDigest(h.args);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /skipped: CLAUDE_CODE_OAUTH_TOKEN .* not set/);
  assert.equal(h.built, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.state.digest.last, undefined);

  await maybeDigest({ ...h.args, now: new Date('2026-10-07T17:00:00Z') }); // the next due day logs again
  assert.equal(h.logs.length, 2);

  const forced = digestHarness({ enabled: false, force: true });
  await maybeDigest(forced.args); // --digest uses the local login even without a token
  assert.equal(forced.sent.length, 1);
});

test('maybeDigest propagates a failing build and then retries on the next run (day not recorded)', async () => {
  const h = digestHarness({ build: async () => { throw new Error('claude exited 1'); } });
  await assert.rejects(maybeDigest(h.args), /claude exited 1/);
  assert.equal(h.state.digest?.last, undefined);
  assert.equal(h.sent.length, 0);
});
