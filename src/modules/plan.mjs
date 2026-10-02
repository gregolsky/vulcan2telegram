import { THREADS } from '../config.mjs';
import { getUczen } from '../uczen.mjs';
import { htmlToText, esc } from '../text.mjs';
import { mondayOf } from './exams.mjs';

const PLAN_WEEKS = 2; // this week and the next
const cleanTeacher = (s = '') => s.replace(/\s*\[.*?\]\s*/g, ' ').trim();
const text = (html = '') => htmlToText(html).replace(/\s+/g, ' ').trim();

function kindOf(cls, note) {
  if (/^zastępstwo/i.test(note) || /x-treelabel-zas/.test(cls)) return 'sub';
  if (/x-treelabel-inv/.test(cls) || /nieobecność|odwoł|zwolnion/i.test(note)) return 'cancel';
  return 'change';
}

/**
 * Flattens one PlanZajec.mvc response (a week as a table) into the lessons that carry a change:
 * a substitute teacher or a cancellation. Plain lessons are skipped. The note stays after the
 * lesson has taken place (the highlighting classes do not), so the key is built from the note.
 */
export function parsePlan(data, student) {
  const dates = (data?.Headers ?? []).slice(1).map(h => h.Text.match(/(\d\d)\.(\d\d)\.(\d{4})/)).map(m => m && `${m[3]}-${m[2]}-${m[1]}`);
  const items = [];
  for (const row of data?.Rows ?? []) {
    const [lessonCell, ...days] = row;
    const [lesson, from, to] = (lessonCell?.Description ?? '').split(/<br\s*\/?>/).map(s => s.trim());
    days.forEach((cell, i) => {
      for (const [, inner] of (cell?.Description ?? '').matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)) {
        const spans = [...inner.matchAll(/<span([^>]*)>([\s\S]*?)<\/span>/g)];
        const note = text((inner.slice(inner.lastIndexOf('</span>') + 7).match(/\(([^)]*)\)/) ?? [])[1] ?? '');
        const cls = spans[0]?.[1] ?? '';
        if (!dates[i] || !spans.length || (!note && !/x-treelabel-(zas|inv)/.test(cls))) continue;
        const parts = spans.map(s => text(s[2]));
        const [subject, ...rest] = parts;
        const teacher = cleanTeacher(rest.at(-1) ?? '');
        const room = rest.slice(0, -1).filter(Boolean).at(-1) ?? '';
        const kind = kindOf(cls, note);
        const subTeacher = kind === 'sub' ? cleanTeacher(note.replace(/^zastępstwo:\s*/i, '')) : '';
        items.push({
          student: student.firstName, className: student.className, date: dates[i],
          lesson, from, to, subject, room, teacher, kind, note, subTeacher,
          keys: [`p:${student.idUczen}:${dates[i]}:${lesson}:${note}`],
        });
      }
    });
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
  const when = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('pl-PL', {
    timeZone: 'Europe/Warsaw', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  return [`🔄 <b>${esc(d.student)} (${esc(d.className)})</b> — <b>${esc(when)}</b>`, ...d.lessons.map(formatLesson)].join('\n');
}

async function fetch(session, { isSeen }) {
  const { students, call } = await getUczen(session);
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Warsaw' });
  const all = [];
  for (const s of students) {
    for (let w = 0; w < PLAN_WEEKS; w++) {
      const data = await call(s, 'PlanZajec.mvc/Get', { data: `${mondayOf(today, w)}T00:00:00` });
      all.push(...parsePlan(data, s));
    }
  }
  // Only upcoming changes are announced; past ones are recorded as seen.
  const fresh = all.filter(c => c.date >= today && c.keys.some(k => !isSeen(k)));
  return { allKeys: all.flatMap(i => i.keys), fresh: groupByDay(fresh) };
}

export default { name: 'plan', thread: () => THREADS.plan, fetch, format: formatPlan };
