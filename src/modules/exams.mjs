import { THREADS, EXAMS_WEEKS } from '../config.mjs';
import { collectWeeks } from '../uczen.mjs';
import { esc, cleanTeacher } from '../text.mjs';
import { ymd, plDate } from '../dates.mjs';

const KINDS = { 2: 'Kartkówka', 3: 'Sprawdzian' };

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
  const when = plDate(e.date);
  return [
    `📝 <b>${esc(e.student)} (${esc(e.className)})</b> — ${esc(e.kindLabel)}: <b>${esc(e.subject)}</b>`,
    `📅 Termin: <b>${esc(when)}</b>`,
    e.description ? `📚 Zakres: ${esc(e.description)}` : null,
    e.teacher ? `🧑‍🏫 Nauczyciel: ${esc(e.teacher)}` : null,
  ].filter(Boolean).join('\n');
}

const EXAM_WEEKS = Math.max(EXAMS_WEEKS, 2); // the weekly digest looks 7 days ahead

/** Exams of the next weeks for all students, fetched once per session (shared with the digest). */
export function loadExams(session, today) {
  return (session.exams ??= collectWeeks(session, {
    path: 'Sprawdziany.mvc/Get', weeks: EXAM_WEEKS, today,
    body: s => ({ rokSzkolny: s.year }), parse: parseExams,
  }));
}

async function fetch(session, { isSeen, now = new Date() }) {
  const all = await loadExams(session, ymd(now));
  return {
    allKeys: all.flatMap(i => i.keys),
    fresh: all.filter(i => i.keys.some(k => !isSeen(k))).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export default { name: 'exams', thread: () => THREADS.exams, fetch, format: formatExam };
