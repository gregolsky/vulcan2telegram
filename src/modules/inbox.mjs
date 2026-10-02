import { WIADOMOSCI_BASE, THREADS } from '../config.mjs';
import { htmlToText, esc } from '../text.mjs';

const GROUP_WINDOW_MS = 120_000;

export const cleanSender = (s = '') => s.replace(/\s*(\[.*?\])?\s*-\s*[A-Z]\s*-.*$/, '').trim() || s;

// "Nowak Piotr - R - Nowak Adam - (SP01)" -> "Adam" (surname first)
export const childName = (box = '') => {
  const m = box.match(/-\s*R\s*-\s*(.+?)\s*-\s*\(/);
  return m ? (m[1].trim().split(/\s+/)[1] ?? m[1].trim()) : box;
};

/** One message is delivered once per child mailbox; merge those copies into a single group. */
export function groupCopies(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.data) - new Date(b.data)); // oldest first
  const groups = [];
  for (const r of sorted) {
    const t = new Date(r.data).getTime();
    const g = groups.find(g => g.sender === r.korespondenci && g.subject === r.temat && Math.abs(g.t - t) <= GROUP_WINDOW_MS);
    if (g) g.rows.push(r);
    else groups.push({ sender: r.korespondenci, subject: r.temat, t, rows: [r] });
  }
  return groups;
}

export function formatMessage(m) {
  const when = new Date(m.date).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' });
  const head = [
    `📬 <b>${esc(m.subject || '(bez tematu)')}</b>`,
    `👤 Od: <b>${esc(m.sender)}</b>`,
    `🧒 Dla: ${esc(m.children.join(', '))}`,
    `🕒 ${esc(when)}`,
  ].join('\n');
  const body = esc(m.body || '(brak treści)');
  const att = m.attachments.length
    ? '\n\n📎 <b>Załączniki:</b>\n' + m.attachments.map(a => `• ${esc(a.name)}\n  ${esc(a.url)}`).join('\n')
    : '';
  return `${head}\n\n${body}${att}`;
}

async function api(ctx, path) {
  const res = await ctx.request.get(`${WIADOMOSCI_BASE}/api/${path}`);
  if (!res.ok()) throw new Error(`Wiadomości API ${path.split('?')[0]} -> HTTP ${res.status()}`);
  return res.json();
}

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

/**
 * Inbox rows (one per child mailbox copy of each message), newest first. Always reads the newest
 * page; keeps paging back (by message id) until `enough(page)` says the older ones are not needed,
 * so a burst of messages or a long downtime does not push messages off the first page unseen.
 */
async function listRows(session, enough = () => true) {
  await session.ensureWiadomosci();
  const rows = [];
  const keys = new Set();
  let cursor = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api(session.ctx, `Odebrane?idLastWiadomosc=${cursor}&pageSize=${PAGE_SIZE}`);
    if (!Array.isArray(page)) throw new Error('Inbox API returned an unexpected response');
    const added = page.filter(r => !keys.has(r.apiGlobalKey)); // the cursor row is repeated on the next page
    added.forEach(r => keys.add(r.apiGlobalKey));
    rows.push(...added);
    if (!added.length || page.length < PAGE_SIZE || enough(page)) break;
    cursor = page.at(-1).id;
  }
  return rows;
}

/** Full message (with body) for one group of per-child copies. Does not mark it as read. */
async function toMessage(session, g) {
  const d = await api(session.ctx, `WiadomoscSzczegoly?apiGlobalKey=${encodeURIComponent(g.rows[0].apiGlobalKey)}`);
  return {
    keys: g.rows.map(r => r.apiGlobalKey),
    sender: cleanSender(d.nadawca || g.sender),
    subject: d.temat || g.subject,
    date: d.data || g.rows[0].data,
    children: [...new Set(g.rows.map(r => childName(r.skrzynka)))],
    body: htmlToText(d.tresc),
    attachments: (d.zalaczniki ?? []).map(a => ({ name: a.nazwaPliku, url: a.url })),
  };
}

/**
 * Reads the inbox (paging back until a fully seen page) and fetches bodies only for groups that are entirely unseen.
 * A group where some copies were already seen (a copy for another child arrived late) is not
 * posted again; its new keys are just recorded (`silent`).
 */
async function fetch(session, { isSeen }) {
  const rows = await listRows(session, page => page.every(r => isSeen(r.apiGlobalKey)));
  const fresh = [];
  for (const g of groupCopies(rows)) {
    const unseen = g.rows.filter(r => !isSeen(r.apiGlobalKey));
    if (!unseen.length) continue;
    if (unseen.length < g.rows.length) fresh.push({ keys: unseen.map(r => r.apiGlobalKey), silent: true });
    else fresh.push(await toMessage(session, g));
  }
  return { allKeys: rows.map(r => r.apiGlobalKey), fresh };
}

/** Messages of the last `days` days with bodies, oldest first. Read-only. */
export async function recentMessages(session, days) {
  const cutoff = Date.now() - days * 86_400_000;
  const out = [];
  const rows = await listRows(session, page => page.some(r => new Date(r.data).getTime() < cutoff));
  for (const g of groupCopies(rows).filter(g => g.t >= cutoff)) out.push(await toMessage(session, g));
  return out;
}

export default { name: 'inbox', thread: () => THREADS.inbox, alwaysOn: true, fetch, format: formatMessage };
