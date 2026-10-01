import { THREADS, EXAMS_WEEKS } from '../config.mjs';
import { getUczen } from '../uczen.mjs';

const KINDS = { 2: 'Kartkówka', 3: 'Sprawdzian' };
const cleanTeacher = (s = '') => s.replace(/\s*\[.*?\]\s*$/, '').trim();

/** Flattens one Sprawdziany.mvc response (a week, grouped by day) into items. */
export function parseExams(data, student) {
  const items = [];
  for (const week of data ?? []) {
    for (const day of week.SprawdzianyGroupedByDayList ?? []) {
      for (const e of day.Sprawdziany ?? []) {
        items.push({
          student: student.firstName, className: student.className,
          kindLabel: KINDS[e.Rodzaj] ?? 'Sprawdzian / kartkówka',
          subject: e.Nazwa, date: day.Data.slice(0, 10), teacher: cleanTeacher(e.Pracownik),
          description: (e.Opis ?? '').trim(),
          keys: [`e:${student.idUczen}:${e.Id}`],
        });
      }
    }
  }
  return items;
}

export function formatExam(e) {
  const when = new Date(`${e.date}T12:00:00Z`).toLocaleDateString('pl-PL', {
    timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  return [
    `📝 ${e.student} (${e.className}) — ${e.kindLabel}: ${e.subject}`,
    `Termin: ${when}`,
    e.description ? `Zakres: ${e.description}` : null,
    e.teacher ? `Nauczyciel: ${e.teacher}` : null,
  ].filter(Boolean).join('\n');
}

/** Monday (YYYY-MM-DD) of the week containing `ymd`, plus `weeks` weeks. */
export function mondayOf(ymd, weeks = 0) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + weeks * 7);
  return d.toISOString().slice(0, 10);
}

async function fetch(session, { isSeen }) {
  const { students, call } = await getUczen(session);
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Warsaw' });
  const all = [];
  for (const s of students) {
    for (let w = 0; w < EXAMS_WEEKS; w++) {
      const data = await call(s, 'Sprawdziany.mvc/Get', { data: `${mondayOf(today, w)}T00:00:00`, rokSzkolny: s.year });
      all.push(...parseExams(data, s));
    }
  }
  return {
    allKeys: all.flatMap(i => i.keys),
    fresh: all.filter(i => i.keys.some(k => !isSeen(k))).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export default { name: 'exams', thread: () => THREADS.exams, fetch, format: formatExam };
