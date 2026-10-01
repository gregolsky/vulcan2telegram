import { THREADS } from '../config.mjs';
import { getUczen } from '../uczen.mjs';

const num = (n) => String(Number(n)); // 1.00 -> "1"
const blank = (s) => !s || !String(s).trim();

/** Turns one student's Oceny.mvc response into items; `keys` are what dedupe is based on. */
export function parseGrades(data, student) {
  const base = { student: student.firstName, className: student.className };
  const items = [];
  for (const subject of data.Oceny ?? []) {
    for (const g of subject.OcenyCzastkowe ?? []) {
      items.push({
        ...base, kind: 'grade', subject: subject.Przedmiot, value: g.Wpis, weight: g.Waga,
        column: g.NazwaKolumny, code: g.KodKolumny, teacher: g.Nauczyciel, date: g.DataOceny,
        corrected: g.IdOcenaPoprawiona != null,
        // the value is part of the key so a teacher changing a grade is announced again
        keys: [`g:${student.idUczen}:${g.IdKolumny}:${g.Wpis}`],
      });
    }
    const term = data.IsOstatniSemestr ? 'roczna' : 'semestralna';
    if (!blank(subject.ProponowanaOcenaRoczna)) {
      items.push({ ...base, kind: 'proposed', term, subject: subject.Przedmiot, value: subject.ProponowanaOcenaRoczna.trim(),
        keys: [`p:${student.idUczen}:${student.okres}:${subject.Przedmiot}:${subject.ProponowanaOcenaRoczna.trim()}`] });
    }
    if (!blank(subject.OcenaRoczna)) {
      items.push({ ...base, kind: 'final', term, subject: subject.Przedmiot, value: subject.OcenaRoczna.trim(),
        keys: [`f:${student.idUczen}:${student.okres}:${subject.Przedmiot}:${subject.OcenaRoczna.trim()}`] });
    }
  }
  return items;
}

export function formatGrade(g) {
  const who = `${g.student} (${g.className})`;
  if (g.kind === 'proposed') return `📋 ${who} — ${g.subject}\nProponowana ocena ${g.term}: ${g.value}`;
  if (g.kind === 'final') return `🏁 ${who} — ${g.subject}\nOcena ${g.term}: ${g.value}`;
  return [
    `🎓 ${who} — ${g.subject}`,
    `${g.corrected ? 'Poprawa oceny' : 'Ocena'}: ${g.value}   (waga ${num(g.weight)})`,
    `Za: ${g.column}${g.code ? ` [${g.code}]` : ''}`,
    `Nauczyciel: ${g.teacher}`,
    `Data: ${g.date}`,
  ].join('\n');
}

const byDate = (a, b) => a.date?.split('.').reverse().join('').localeCompare(b.date?.split('.').reverse().join('') ?? '') || 0;

async function fetch(session, { isSeen }) {
  const { students, call } = await getUczen(session);
  const all = [];
  for (const s of students) {
    all.push(...parseGrades(await call(s, 'Oceny.mvc/Get', { okres: s.okres }), s));
  }
  return {
    allKeys: all.flatMap(i => i.keys),
    fresh: all.filter(i => i.keys.some(k => !isSeen(k))).sort(byDate),
  };
}

export default { name: 'grades', thread: () => THREADS.grades, fetch, format: formatGrade };
