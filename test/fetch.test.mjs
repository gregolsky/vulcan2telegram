import test from 'node:test';
import assert from 'node:assert/strict';
import inbox, { recentMessages } from '../src/modules/inbox.mjs';
import grades from '../src/modules/grades.mjs';
import { runModule } from '../src/runner.mjs';
import exams from '../src/modules/exams.mjs';
import plan, { parsePlan } from '../src/modules/plan.mjs';

const now = new Date('2026-10-03T12:00:00Z'); // Saturday
const students = [{ firstName: 'Ala', className: '4A', idUczen: 1, year: 2026 }, { firstName: 'Ola', className: '6B', idUczen: 2, year: 2026 }];

// ---- inbox ---------------------------------------------------------------------------------
const row = (key, box, over = {}) => ({ id: Number(key.replace(/\D/g, '')) || 1, apiGlobalKey: key, korespondenci: 'Jan Nowak - P - (SP01)', temat: 'Temat', skrzynka: box, data: '2026-10-02T10:00:00+02:00', ...over });
const box = (child) => `Nowak Jan - R - Nowak ${child} - (SP01)`;

/** `rows` is one page (or a function of the idLastWiadomosc cursor returning a page). */
function inboxSession(rows, details = {}) {
  const s = { hops: 0, requests: [] };
  s.ensureWiadomosci = async () => { s.hops++; };
  s.ctx = { request: { get: async (url) => {
    s.requests.push(url);
    const cursor = Number(new URL(url).searchParams.get('idLastWiadomosc'));
    const body = url.includes('WiadomoscSzczegoly') ? details : typeof rows === 'function' ? rows(cursor) : rows;
    return { ok: () => true, status: () => 200, json: async () => body };
  } } };
  return s;
}
const detail = { nadawca: 'Jan Nowak - P - (SP01)', temat: 'Temat', data: '2026-10-02T10:00:00+02:00', tresc: '<p>Treść</p>', zalaczniki: [{ nazwaPliku: 'a.pdf', url: 'https://x/a' }] };
const detailCalls = (s) => s.requests.filter(u => u.includes('WiadomoscSzczegoly'));

test('inbox: an unseen message is fetched once for all child copies and returns the full message', async () => {
  const s = inboxSession([row('k1', box('Ala')), row('k2', box('Ola'))], detail);
  const { allKeys, fresh } = await inbox.fetch(s, { isSeen: () => false });
  assert.deepEqual(allKeys, ['k1', 'k2']);
  assert.equal(detailCalls(s).length, 1);
  assert.deepEqual(fresh, [{ keys: ['k1', 'k2'], sender: 'Jan Nowak', subject: 'Temat', date: detail.data, children: ['Ala', 'Ola'], body: 'Treść', attachments: [{ name: 'a.pdf', url: 'https://x/a' }] }]);
  assert.equal(s.hops, 1);
});

test('inbox: seen messages cost no detail request; a first run (everything seen) fetches no bodies', async () => {
  const s = inboxSession([row('k1', box('Ala'))], detail);
  assert.deepEqual((await inbox.fetch(s, { isSeen: () => true })).fresh, []);
  assert.equal(detailCalls(s).length, 0);
});

test('inbox: a late copy for another child of an already posted message is recorded silently, not reposted', async () => {
  const s = inboxSession([row('k1', box('Ala')), row('k2', box('Ola'))], detail);
  const { fresh } = await inbox.fetch(s, { isSeen: k => k === 'k1' });
  assert.deepEqual(fresh, [{ keys: ['k2'], silent: true }]);
  assert.equal(detailCalls(s).length, 0);
});

test('inbox: an empty mailbox is not an error, an unexpected response is', async () => {
  assert.deepEqual(await inbox.fetch(inboxSession([]), { isSeen: () => false }), { allKeys: [], fresh: [] });
  await assert.rejects(inbox.fetch(inboxSession({ error: 'x' }), { isSeen: () => false }), /unexpected response/);
});

test('inbox: HTTP errors surface with the endpoint name', async () => {
  const s = inboxSession([]);
  s.ctx.request.get = async () => ({ ok: () => false, status: () => 503 });
  await assert.rejects(inbox.fetch(s, { isSeen: () => false }), /Odebrane -> HTTP 503/);
});

test('recentMessages keeps only the last N days, oldest first, with bodies', async () => {
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const s = inboxSession([row('new', box('Ala'), { data: recent, temat: 'A' }), row('old', box('Ala'), { data: old, temat: 'B' })], detail);
  const msgs = await recentMessages(s, 7);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].keys, ['new']);
  assert.equal(msgs[0].body, 'Treść');
});

test('inbox: pages back until a page with a seen message, so a burst larger than one page is not lost', async () => {
  const mk = (from, n) => Array.from({ length: n }, (_, i) => row(`k${from - i}`, box('Ala'), { temat: `T${from - i}`, data: `2026-10-02T10:${String(59 - i).padStart(2, '0')}:00+02:00` }));
  const pages = { 0: mk(200, 50), 151: mk(151, 50), 102: mk(102, 50), 53: mk(53, 50) }; // keyed by the cursor: the previous page's last id, which the next page repeats
  const s = inboxSession(c => pages[c] ?? [], detail);
  const seen = new Set(Array.from({ length: 60 }, (_, i) => `k${i + 1}`)); // everything up to k60 is known
  const { fresh } = await inbox.fetch(s, { isSeen: k => seen.has(k) });
  const pageRequests = s.requests.filter(u => u.includes('Odebrane'));
  assert.deepEqual(pageRequests.map(u => new URL(u).searchParams.get('idLastWiadomosc')), ['0', '151', '102']);
  assert.equal(fresh.length, 140); // k61..k200; the repeated cursor rows are not duplicated
  assert.equal(new Set(fresh.flatMap(f => f.keys)).size, 140);
});

test('inbox: a message arriving after the first run does not drag the pre-seed history along', async () => {
  const mk = (from, n) => Array.from({ length: n }, (_, i) => row(`k${from - i}`, box('Ala'), { temat: `T${from - i}` }));
  const pages = { 0: mk(151, 50), 102: mk(102, 50), 53: mk(53, 50) }; // k151 is new; k150..k101 is what the seed recorded
  const s = inboxSession(c => pages[c] ?? [], detail);
  const seen = new Set(Array.from({ length: 50 }, (_, i) => `k${150 - i}`));
  const { fresh } = await inbox.fetch(s, { isSeen: k => seen.has(k) });
  assert.equal(s.requests.filter(u => u.includes('Odebrane')).length, 1);
  assert.deepEqual(fresh.map(f => f.keys), [['k151']]);
  assert.equal(detailCalls(s).length, 1);

  // an older page was read anyway (the seen row is not on page 1): its rows are recorded, not posted
  const s2 = inboxSession(c => ({ 0: [...mk(151, 49), row('k102', box('Ala'))], 102: mk(102, 50) })[c] ?? [], detail);
  const seen2 = new Set(['k102']);
  const r2 = await inbox.fetch(s2, { isSeen: k => seen2.has(k) });
  assert.equal(r2.fresh.filter(f => !f.silent).length, 49);
  assert.equal(r2.fresh.filter(f => f.silent).length, 0);
});

test('inbox: a fully seen first page needs no further requests; paging is capped', async () => {
  const page = Array.from({ length: 50 }, (_, i) => row(`k${100 - i}`, box('Ala'), { temat: `T${i}` }));
  const s = inboxSession(page, detail);
  await inbox.fetch(s, { isSeen: () => true });
  assert.equal(s.requests.length, 1);

  const endless = inboxSession(c => Array.from({ length: 50 }, (_, i) => row(`k${(c || 100000) - i}`, box('Ala'), { temat: `T${c}-${i}` })), detail);
  await inbox.fetch(endless, { isSeen: () => false }).catch(() => {});
  assert.ok(endless.requests.filter(u => u.includes('Odebrane')).length <= 10);
});

test('recentMessages pages back to the cutoff and no further', async () => {
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const page1 = Array.from({ length: 50 }, (_, i) => row(`k${1000 - i}`, box('Ala'), { temat: `n${i}`, data: day(1) }));
  const page2 = [row('k951', box('Ala'), { temat: 'n49', data: day(1) }), row('k940', box('Ala'), { temat: 'older', data: day(3) }), ...Array.from({ length: 48 }, (_, i) => row(`k${930 - i}`, box('Ala'), { temat: `o${i}`, data: day(20) }))];
  const s = inboxSession(c => (c === 0 ? page1 : c === 951 ? page2 : []), detail);
  const msgs = await recentMessages(s, 7);
  assert.equal(s.requests.filter(u => u.includes('Odebrane')).length, 2);
  assert.equal(msgs.length, 51); // 50 + 'older' (3 days), the 20-day-old ones are cut
});

// ---- exams / plan (per-student weekly endpoints) ---------------------------------------------
function uczenSession(responses) {
  const calls = [];
  const call = async (student, path, body) => { calls.push({ student: student.firstName, path, body }); return responses(student, path, body); };
  return { calls, uczen: Promise.resolve({ students, call }) };
}
const examsFor = (id, date, name) => [{ SprawdzianyGroupedByDayList: [{ Data: `${date} 00:00:00`, Sprawdziany: [{ Id: id, Nazwa: name, Pracownik: 'Kowalska Ewa [KE]', Opis: '', Rodzaj: 3 }] }] }];

test('exams.fetch: queries every student for each week from this Monday, sorted by date, only unseen', async () => {
  const s = uczenSession((st, path, body) => body.data.startsWith('2026-09-28') ? examsFor(st.idUczen * 10, st.idUczen === 1 ? '2026-10-09' : '2026-10-05', st.firstName) : []);
  const { allKeys, fresh } = await exams.fetch(s, { isSeen: k => k === 'e:2:20', now });
  assert.equal(s.calls.length, students.length * 4);
  assert.deepEqual([...new Set(s.calls.map(c => c.body.data))], ['2026-09-28T00:00:00', '2026-10-05T00:00:00', '2026-10-12T00:00:00', '2026-10-19T00:00:00']);
  assert.ok(s.calls.every(c => c.path === 'Sprawdziany.mvc/Get' && c.body.rokSzkolny === 2026));
  assert.deepEqual(allKeys, ['e:1:10', 'e:2:20']);
  assert.deepEqual(fresh.map(f => f.student), ['Ala']);

  const again = await exams.fetch(s, { isSeen: () => false, now }); // second consumer (e.g. the digest) reuses the data
  assert.equal(s.calls.length, students.length * 4);
  assert.deepEqual(again.fresh.map(f => f.date), ['2026-10-05', '2026-10-09']);
});

const planWeek = (dateText, cellHtml) => ({
  Headers: [{ Text: 'Lekcja' }, { Text: `piątek<br />${dateText}` }],
  Rows: [[{ Description: '1<br />08:00<br />08:45' }, { Description: cellHtml }]],
});
const subCell = "<div><span class='x-treelabel-zas'>Plastyka</span> <span>12</span><span> Mazur Anna</span>(zastępstwo: Lis Ewa)</div>";

test('plan.fetch: announces only today and later, but records past changes as seen keys', async () => {
  const s = uczenSession((st, path, body) => planWeek(body.data.startsWith('2026-09-28') ? '02.10.2026' : '09.10.2026', subCell)); // this week's Friday is past
  const { allKeys, fresh } = await plan.fetch(s, { isSeen: () => false, now });
  assert.equal(s.calls.length, students.length * 2); // this week and next
  assert.ok(allKeys.some(k => k.includes('2026-10-02')));
  assert.deepEqual([...new Set(fresh.map(f => f.date))], ['2026-10-09']);
  assert.equal(fresh.length, 2); // one message per student for that day
});

test('plan.fetch: nothing new when all keys are seen', async () => {
  const s = uczenSession(() => planWeek('09.10.2026', subCell));
  assert.deepEqual((await plan.fetch(s, { isSeen: () => true, now })).fresh, []);
});

// ---- parsePlan edge cases ------------------------------------------------------------------
test('parsePlan: two lessons in one cell, a header without a date and a non-substitution note', () => {
  const two = planWeek('09.10.2026', subCell + "<div><span class=''>Muzyka</span> <span>5</span><span> Nowak Jan</span>(zajęcia przeniesione do sali 7)</div>");
  const items = parsePlan(two, students[0]);
  assert.deepEqual(items.map(i => [i.subject, i.kind]), [['Plastyka', 'sub'], ['Muzyka', 'change']]);
  assert.equal(items[1].note, 'zajęcia przeniesione do sali 7');

  const holiday = { ...two, Headers: [{ Text: 'Lekcja' }, { Text: 'Dzień wolny od zajęć' }] };
  assert.deepEqual(parsePlan(holiday, students[0]), []);
  assert.deepEqual(parsePlan(planWeek('09.10.2026', ''), students[0]), []);
});

// ---- Uczeń loader: the SSO hop must precede opening the app, whichever module runs first ------
import { getUczen } from '../src/uczen.mjs';

function fakeBrowserSession({ token = 'tok' } = {}) {
  const events = [];
  const s = { events };
  s.ensureWiadomosci = async () => { events.push('sso'); };
  s.page = {
    waitForRequest: async () => ({ headers: () => ({ 'x-v-appversion': 'v', 'x-v-requestverificationtoken': token }) }),
    goto: async () => { events.push('app'); },
  };
  s.ctx = {
    addCookies: async () => {},
    request: { post: async (url) => { events.push(`post ${url.split('/').pop()}`); return { ok: () => true, status: () => 200, json: async () => ({ data: [{ UczenImie: 'Ala', Poziom: 4, Symbol: 'A', IdUczen: 1, IdDziennik: 2, DziennikRokSzkolny: 2026, Okresy: [{ Id: 9, DataOd: '2000-01-01 00:00:00', DataDo: '2100-01-01 00:00:00' }] }] }) }; } },
  };
  return s;
}

test('getUczen does the SSO hop before opening the app and loads only once per session', async () => {
  const s = fakeBrowserSession();
  const [a, b] = await Promise.all([getUczen(s), getUczen(s)]);
  assert.equal(a, b);
  assert.deepEqual(s.events, ['sso', 'app', 'post Get']);
  assert.equal(a.students[0].firstName, 'Ala');
});

test('getUczen fails clearly when no anti-forgery token is found', async () => {
  await assert.rejects(getUczen(fakeBrowserSession({ token: null })), /no anti-forgery token/);
});

test('runModule + inbox: a seed run followed by one new message delivers exactly that message (the 352-message regression)', async () => {
  const mk = (from, n) => Array.from({ length: n }, (_, i) => row(`k${from - i}`, box('Ala'), { temat: `T${from - i}` }));
  let newest = 150;
  const pages = () => ({ 0: mk(newest, 50), [newest - 49]: mk(newest - 49, 50), [newest - 99]: mk(newest - 99, 50) });
  const ms = { seen: [], initialized: false };
  const sent = [];
  const deps = { deliver: async (t) => sent.push(t), alert: async () => {}, persist() {}, maxPerRun: 20, floodLimit: 50, now: new Date(), log() {} };

  await runModule(inbox, ms, inboxSession(c => pages()[c] ?? [], detail), deps);
  assert.equal(ms.seen.length, 50); // the seed recorded only the newest page
  assert.deepEqual(sent, []);

  newest = 151; // one new message arrives
  const s = inboxSession(c => pages()[c] ?? [], detail);
  await runModule(inbox, ms, s, deps);
  assert.equal(sent.length, 1);
  assert.equal(s.requests.filter(u => u.includes('Odebrane')).length, 1);
});

test('grades: only unseen grades are returned, oldest first; a changed value is a new item', async () => {
  const data = { Oceny: [{ Przedmiot: 'Mat', OcenyCzastkowe: [
    { IdKolumny: 1, Wpis: '5', DataOceny: '03.10.2026', Waga: 3 },
    { IdKolumny: 2, Wpis: '4', DataOceny: '01.10.2026', Waga: 1 },
    { IdKolumny: 3, Wpis: '3', DataOceny: '02.10.2026', Waga: 1 },
  ] }] };
  const student = { firstName: 'Ala', className: '4A', idUczen: 7, okres: 9 };
  const session = { uczen: Promise.resolve({ students: [student], call: async () => data }) };
  const { allKeys, fresh } = await grades.fetch(session, { isSeen: k => k === 'g:7:3:3' });
  assert.deepEqual(allKeys, ['g:7:1:5', 'g:7:2:4', 'g:7:3:3']);
  assert.deepEqual(fresh.map(g => g.date), ['01.10.2026', '03.10.2026']);

  data.Oceny[0].OcenyCzastkowe[2].Wpis = '4'; // the teacher changed a grade
  const again = await grades.fetch(session, { isSeen: k => k === 'g:7:3:3' });
  assert.ok(again.fresh.some(g => g.keys[0] === 'g:7:3:4'));
});
