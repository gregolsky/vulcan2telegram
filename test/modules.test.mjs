import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGrades, formatGrade } from '../src/modules/grades.mjs';
import { parseExams, formatExam, mondayOf } from '../src/modules/exams.mjs';
import { currentPeriod, toStudent } from '../src/uczen.mjs';
import { migrateState } from '../src/state.mjs';

const adam = { firstName: 'Adam', className: '7B', idUczen: 1001, okres: 2001 };

test('parseGrades: partial grades become items keyed by student, column and value', () => {
  const data = { IsOstatniSemestr: false, Oceny: [
    { Przedmiot: 'Język polski', ProponowanaOcenaRoczna: ' ', OcenaRoczna: ' ', OcenyCzastkowe: [
      { Nauczyciel: 'Dąbrowska Alicja', Wpis: '4+', Waga: 1.0, IdKolumny: 5001, NazwaKolumny: 'Rozprawka - budowa', KodKolumny: 'K2', DataOceny: '25.09.2026', IdOcenaPoprawiona: null },
    ] },
    { Przedmiot: 'Zachowanie', ProponowanaOcenaRoczna: ' ', OcenaRoczna: ' ', OcenyCzastkowe: [] },
  ] };
  const items = parseGrades(data, adam);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].keys, ['g:1001:5001:4+']);
  assert.equal(items[0].student, 'Adam');
  assert.equal(items[0].className, '7B');
});

test('parseGrades: changing a grade value yields a new key; blank term grades are ignored', () => {
  const mk = (wpis) => ({ Oceny: [{ Przedmiot: 'X', ProponowanaOcenaRoczna: ' ', OcenaRoczna: ' ', OcenyCzastkowe: [{ Wpis: wpis, Waga: 2, IdKolumny: 1, NazwaKolumny: 'c', DataOceny: '01.10.2026', Nauczyciel: 'N', IdOcenaPoprawiona: null }] }] });
  assert.notEqual(parseGrades(mk('3'), adam)[0].keys[0], parseGrades(mk('4'), adam)[0].keys[0]);
});

test('parseGrades: proposed and final term grades, labelled by semester', () => {
  const data = { IsOstatniSemestr: true, Oceny: [{ Przedmiot: 'Matematyka', ProponowanaOcenaRoczna: '5', OcenaRoczna: '4 ', OcenyCzastkowe: [] }] };
  const [p, f] = parseGrades(data, adam);
  assert.equal(p.kind, 'proposed');
  assert.equal(f.kind, 'final');
  assert.equal(f.value, '4');
  assert.match(formatGrade(f), /^🏁 Adam \(7B\) — Matematyka\nOcena roczna: 4$/);
  assert.match(formatGrade({ ...p, term: 'semestralna' }), /Proponowana ocena semestralna: 5/);
});

test('formatGrade names the student, class and subject and shows weight without decimals', () => {
  const [g] = parseGrades({ Oceny: [{ Przedmiot: 'Matematyka', ProponowanaOcenaRoczna: '', OcenaRoczna: '', OcenyCzastkowe: [
    { Wpis: '5', Waga: 3.0, IdKolumny: 9, NazwaKolumny: 'Sprawdzian', KodKolumny: 'S', DataOceny: '02.10.2026', Nauczyciel: 'Kowalski Jan', IdOcenaPoprawiona: 8 }] }] }, adam);
  const out = formatGrade(g);
  assert.match(out, /^🎓 Adam \(7B\) — Matematyka\n/);
  assert.match(out, /Poprawa oceny: 5 {3}\(waga 3\)/);
  assert.match(out, /Za: Sprawdzian \[S\]/);
});

const weekData = [{ SprawdzianyGroupedByDayList: [
  { Data: '2026-09-28 00:00:00', Sprawdziany: [{ Id: 5002, Nazwa: 'Matematyka', Pracownik: 'Wiśniewska Ewa [WE]', Opis: 'Ułamki', Rodzaj: 2 }] },
  { Data: '2026-09-30 00:00:00', Sprawdziany: [] },
  { Data: '2026-10-02 00:00:00', Sprawdziany: [{ Id: 1, Nazwa: 'Historia', Pracownik: 'Mazur Piotr [PM]', Opis: null, Rodzaj: 3 }, { Id: 2, Nazwa: 'Plastyka', Pracownik: '', Opis: '', Rodzaj: 9 }] },
] }];

test('parseExams flattens days, skips empty ones, cleans teacher and labels kinds', () => {
  const items = parseExams(weekData, adam);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].keys, ['e:1001:5002']);
  assert.equal(items[0].teacher, 'Wiśniewska Ewa');
  assert.equal(items[0].kindLabel, 'Kartkówka');
  assert.equal(items[1].kindLabel, 'Sprawdzian');
  assert.equal(items[2].kindLabel, 'Sprawdzian / kartkówka');
  assert.deepEqual(parseExams(undefined, adam), []);
});

test('formatExam shows student, class, subject, weekday date and scope; omits empty lines', () => {
  const [a, , c] = parseExams(weekData, adam);
  const out = formatExam(a);
  assert.match(out, /^📝 Adam \(7B\) — Kartkówka: Matematyka\n/);
  assert.match(out, /Termin: poniedziałek, 28 września 2026/);
  assert.match(out, /Zakres: Ułamki/);
  assert.doesNotMatch(formatExam(c), /Zakres|Nauczyciel/);
});

test('mondayOf finds the Monday of the week and offsets by weeks', () => {
  assert.equal(mondayOf('2026-09-30'), '2026-09-28'); // Wednesday
  assert.equal(mondayOf('2026-09-28'), '2026-09-28'); // Monday
  assert.equal(mondayOf('2026-10-04'), '2026-09-28'); // Sunday belongs to the previous Monday
  assert.equal(mondayOf('2026-09-30', 2), '2026-10-12');
});

test('currentPeriod picks the term containing the date, else the last one', () => {
  const okresy = [
    { Id: 1, DataOd: '2026-09-01 00:00:00', DataDo: '2027-01-24 00:00:00' },
    { Id: 2, DataOd: '2027-01-25 00:00:00', DataDo: '2027-08-31 00:00:00' },
  ];
  assert.equal(currentPeriod(okresy, '2026-09-30').Id, 1);
  assert.equal(currentPeriod(okresy, '2027-03-01').Id, 2);
  assert.equal(currentPeriod(okresy, '2030-01-01').Id, 2);
});

test('toStudent builds the class name from level and symbol', () => {
  const s = toStudent({ UczenImie: 'Beata', Poziom: 5, Symbol: 'B', IdUczen: 1, IdDziennik: 2, DziennikRokSzkolny: 2026,
    Okresy: [{ Id: 2002, DataOd: '2000-01-01 00:00:00', DataDo: '2100-01-01 00:00:00' }] });
  assert.deepEqual(s, { firstName: 'Beata', className: '5B', idUczen: 1, idDziennik: 2, year: 2026, okres: 2002 });
});

test('migrateState: empty, v1 layout and v2 layout', () => {
  assert.deepEqual(migrateState(null), { failures: 0, modules: {} });
  assert.deepEqual(migrateState({ seen: ['a'], failures: 2, initialized: true }), { failures: 2, modules: { inbox: { seen: ['a'], initialized: true } } });
  // v1 state written before the `initialized` flag existed
  assert.equal(migrateState({ seen: ['a'] }).modules.inbox.initialized, true);
  assert.equal(migrateState({ seen: [], failures: 1 }).modules.inbox.initialized, false);
  const v2 = { failures: 0, modules: { grades: { seen: [], initialized: false } } };
  assert.equal(migrateState(v2), v2);
});

import { parsePlan, groupByDay, formatPlan } from '../src/modules/plan.mjs';

const cell = (d) => ({ Description: d, Tooltip: '' });
const lessonCell = (n, a, b) => cell(`${n}<br />${a}<br />${b}`);
const planData = (upcoming = true) => ({
  Headers: [{ Text: 'Lekcja' }, { Text: 'czwartek<br />01.10.2026' }, { Text: 'piątek<br />02.10.2026' }],
  Rows: [
    [lessonCell(1, '08:00', '08:45'),
      cell("<div><span class=''>Matematyka</span> <span class=''>120</span><span class=''> Wiśniewska Ewa</span></div>"),
      cell(`<div><span class='${upcoming ? 'x-treelabel-ppl x-treelabel-zas' : ''}'>Edukacja wczesnoszkolna</span> <span class=''>210</span><span class=''> Lewandowska Anna</span>(zastępstwo: Kamińska Barbara)</div>`)],
    [lessonCell(4, '10:45', '11:30'),
      cell("<div><span class=''>Wychowanie fizyczne [CH]</span><span class=''>  </span><span class=''> sg1</span><span class=''> Pawlak Tomasz [TP]</span>(zastępstwo: Zielińska Maria)</div>"),
      cell('')],
    [lessonCell(7, '14:00', '14:45'),
      cell(''),
      cell(`<div><span class='x-treelabel-ppl x-treelabel-inv'>Rekreacja</span> <span class=''>sg1</span><span class=''> Krawczyk Teresa</span>(nieobecność nauczyciela: uczniowie zwolnieni do domu)</div>`)],
  ],
  Additionals: [],
});
const celina = { firstName: 'Celina', className: '2B', idUczen: 7 };

test('parsePlan keeps only changed lessons and reads date, time, room, teachers and kind', () => {
  const items = parsePlan(planData(), celina);
  assert.equal(items.length, 3); // plain Matematyka and empty cells are skipped
  const [sub, wf, cancel] = items;
  assert.deepEqual([sub.date, sub.lesson, sub.from, sub.to, sub.kind], ['2026-10-02', '1', '08:00', '08:45', 'sub']);
  assert.deepEqual([sub.subject, sub.room, sub.teacher, sub.subTeacher], ['Edukacja wczesnoszkolna', '210', 'Lewandowska Anna', 'Kamińska Barbara']);
  assert.deepEqual([wf.date, wf.subject, wf.room, wf.teacher], ['2026-10-01', 'Wychowanie fizyczne [CH]', 'sg1', 'Pawlak Tomasz']);
  assert.equal(cancel.kind, 'cancel');
  assert.equal(cancel.note, 'nieobecność nauczyciela: uczniowie zwolnieni do domu');
  assert.deepEqual(parsePlan(undefined, celina), []);
});

test('parsePlan keys do not change after the lesson has taken place (highlight classes disappear)', () => {
  assert.deepEqual(parsePlan(planData(true), celina).map(i => i.keys), parsePlan(planData(false), celina).map(i => i.keys));
  assert.equal(parsePlan(planData(false), celina)[0].kind, 'sub'); // still recognised from the note
});

test('parsePlan: a different substitute teacher gives a new key', () => {
  const swap = planData();
  swap.Rows[0][2].Description = swap.Rows[0][2].Description.replace('Kamińska Barbara', 'Woźniak Irena');
  assert.notEqual(parsePlan(swap, celina)[0].keys[0], parsePlan(planData(), celina)[0].keys[0]);
});

test('groupByDay makes one item per student and day, ordered by date', () => {
  const days = groupByDay(parsePlan(planData(), celina));
  assert.deepEqual(days.map(d => [d.date, d.lessons.length, d.keys.length]), [['2026-10-01', 1, 1], ['2026-10-02', 2, 2]]);
});

test('formatPlan lists substitutions with the original teacher and cancellations with the reason', () => {
  const out = formatPlan(groupByDay(parsePlan(planData(), celina))[1]);
  assert.match(out, /^🔄 Celina \(2B\) — piątek, 2 października 2026\n/);
  assert.match(out, /• 1\. lekcja \(08:00–08:45\) Edukacja wczesnoszkolna, s\. 210: zastępstwo — Kamińska Barbara \(zamiast Lewandowska Anna\)/);
  assert.match(out, /• 7\. lekcja \(14:00–14:45\) Rekreacja, s\. sg1: ❌ odwołana — nieobecność nauczyciela: uczniowie zwolnieni do domu/);
  // same teacher in the span and the note: no "zamiast"
  const same = formatPlan(groupByDay([{ ...parsePlan(planData(), celina)[0], teacher: 'Kamińska Barbara' }])[0]);
  assert.doesNotMatch(same, /zamiast/);
});
