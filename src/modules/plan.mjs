import { THREADS } from '../config.mjs';
import { collectWeeks } from '../uczen.mjs';
import { htmlToText, esc, cleanTeacher } from '../text.mjs';
import { ymd, plDate } from '../dates.mjs';

const PLAN_WEEKS = 2; // this week and the next
const text = (html = '') => htmlToText(html).replace(/\s+/g, ' ').trim();

/** 'sub' | 'cancel' | 'change', or null for a plain lesson (no highlight class and no note). */
function kindOf(cls, note) {
  if (/^zastępstwo/i.test(note) || /x-treelabel-zas/.test(cls)) return 'sub';
  if (/x-treelabel-inv/.test(cls) || /nieobecność|odwoł|zwolnion/i.test(note)) return 'cancel';
  return note ? 'change' : null;
}

/**
 * Flattens one PlanZajec.mvc response (a week as a table) into the lessons that carry a change:
 * a substitute teacher or a cancellation. Plain lessons are skipped. The note stays after the
 * lesson has taken place (the highlighting classes do not), so the key is built from the note.
 */
export function parsePlan(data, student) {
  const dates = (data?.Headers ?? []).slice(1).map(h => h.Text.match(/(\d\d)\.(\d\d)\.(\d{4})/)).map(m => m && `${m[3]}-${m[2]}-${m[1]}`);
  const items = [];
  for (const [lessonCell, ...days] of data?.Rows ?? []) {
    const [lesson, from, to] = (lessonCell?.Description ?? '').split(/<br\s*\/?>/).map(s => s.trim());
    for (const [i, cell] of days.entries()) {
      for (const [, inner] of (cell?.Description ?? '').matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)) {
        const [subject, ...rest] = [...inner.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/g)].map(m => ({ cls: m[1], text: text(m[2]) }));
        const note = text(inner.split('</span>').at(-1).match(/\(([^)]*)\)/)?.[1]);
        const kind = subject && dates[i] && kindOf(subject.cls, note);
        if (!kind) continue;
        const subTeacher = kind === 'sub' ? cleanTeacher(note.replace(/^zastępstwo:\s*/i, '')) : '';
        items.push({
          student: student.firstName, className: student.className, date: dates[i], lesson, from, to,
          subject: subject.text, room: rest.slice(0, -1).map(r => r.text).filter(Boolean).at(-1) ?? '',
          teacher: cleanTeacher(rest.at(-1)?.text), kind, note, subTeacher,
          keys: [`p:${student.idUczen}:${dates[i]}:${lesson}:${note}`],
        });
      }
    }
  }
  return items;
}

/** One item per student and day, so a day with five substituted lessons is one message. */
export function groupByDay(changes) {
  const days = new Map();
  for (const c of changes) {
    const k = `${c.student}|${c.date}`;
    if (!days.has(k)) days.set(k, { student: c.student, className: c.className, date: c.date, lessons: [], keys: [] });
    const d = days.get(k);
    d.lessons.push(c);
    d.keys.push(...c.keys);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function formatLesson(l) {
  const when = l.from && l.to ? ` (${l.from}–${l.to})` : '';
  const where = l.room ? `, s. ${l.room}` : '';
  const head = `<b>${esc(l.lesson)}. lekcja</b>${esc(when)} ${esc(l.subject)}${esc(where)}`;
  if (l.kind === 'sub') {
    const was = l.teacher && l.teacher !== l.subTeacher ? ` (zamiast ${esc(l.teacher)})` : '';
    return `🔄 ${head}\n    zastępstwo: <b>${esc(l.subTeacher)}</b>${was}`;
  }
  if (l.kind === 'cancel') return `❌ ${head}\n    <b>odwołana</b> — ${esc(l.note)}`;
  return `⚠️ ${head}\n    ${esc(l.note)}`;
}

export function formatPlan(d) {
  const when = plDate(d.date);
  return [`🔄 <b>${esc(d.student)} (${esc(d.className)})</b> — <b>${esc(when)}</b>`, ...d.lessons.map(formatLesson)].join('\n');
}

/** Schedule changes of this and next week for all students, fetched once per session (shared with the digest). */
export function loadPlan(session, today) {
  return (session.plan ??= collectWeeks(session, { path: 'PlanZajec.mvc/Get', weeks: PLAN_WEEKS, today, parse: parsePlan }));
}

async function fetch(session, { isSeen, now = new Date() }) {
  const today = ymd(now);
  const all = await loadPlan(session, today);
  // Only upcoming changes are announced; past ones are recorded as seen.
  const fresh = all.filter(c => c.date >= today && c.keys.some(k => !isSeen(k)));
  return { allKeys: all.flatMap(i => i.keys), fresh: groupByDay(fresh) };
}

export default { name: 'plan', thread: () => THREADS.plan, fetch, format: formatPlan };
