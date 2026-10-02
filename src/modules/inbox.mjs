import { WIADOMOSCI_BASE, THREADS } from '../config.mjs';
import { htmlToText } from '../text.mjs';

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
    `📬 ${m.subject || '(bez tematu)'}`,
    `Od: ${m.sender}`,
    `Dla: ${m.children.join(', ')}`,
    `Data: ${when}`,
  ].join('\n');
  const body = m.body || '(brak treści)';
  const att = m.attachments.length
    ? '\n\n📎 Załączniki:\n' + m.attachments.map(a => `• ${a.name}\n  ${a.url}`).join('\n')
    : '';
  return `${head}\n\n${body}${att}`;
}

async function api(ctx, path) {
  const res = await ctx.request.get(`${WIADOMOSCI_BASE}/api/${path}`);
  if (!res.ok()) throw new Error(`Wiadomości API ${path.split('?')[0]} -> HTTP ${res.status()}`);
  return res.json();
}

// SSO hop to the Wiadomości Plus host; once per session.
function openHost(session) {
  return (session.inboxHost ??= (async () => {
    await session.page.goto(`${WIADOMOSCI_BASE}/LoginEndpoint.aspx`, { waitUntil: 'networkidle' });
    await session.page.waitForTimeout(3000);
  })());
}

/**
 * Reads the newest inbox page via the portal's JSON API and fetches bodies only for groups
 * with an unseen key. Does not mark messages as read.
 */
async function fetch(session, { isSeen, seedOnly }) {
  await openHost(session);
  const rows = await api(session.ctx, 'Odebrane?idLastWiadomosc=0&pageSize=50');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Inbox API returned no messages');
  const allKeys = rows.map(r => r.apiGlobalKey);
  if (seedOnly) return { allKeys, fresh: [] };

  const fresh = [];
  for (const g of groupCopies(rows)) {
    if (g.rows.every(r => isSeen(r.apiGlobalKey))) continue;
    const d = await api(session.ctx, `WiadomoscSzczegoly?apiGlobalKey=${encodeURIComponent(g.rows[0].apiGlobalKey)}`);
    fresh.push({
      keys: g.rows.map(r => r.apiGlobalKey),
      sender: cleanSender(d.nadawca || g.sender),
      subject: d.temat || g.subject,
      date: d.data || g.rows[0].data,
      children: [...new Set(g.rows.map(r => childName(r.skrzynka)))],
      body: htmlToText(d.tresc),
      attachments: (d.zalaczniki ?? []).map(a => ({ name: a.nazwaPliku, url: a.url })),
    });
  }
  return { allKeys, fresh };
}

/** Messages from the last `days` days with bodies (newest inbox page only), oldest first. Read-only. */
export async function recentMessages(session, days) {
  await openHost(session);
  const rows = await api(session.ctx, 'Odebrane?idLastWiadomosc=0&pageSize=50');
  if (!Array.isArray(rows)) throw new Error('Inbox API returned no list');
  const cutoff = Date.now() - days * 86_400_000;
  const out = [];
  for (const g of groupCopies(rows).filter(g => g.t >= cutoff)) {
    const d = await api(session.ctx, `WiadomoscSzczegoly?apiGlobalKey=${encodeURIComponent(g.rows[0].apiGlobalKey)}`);
    out.push({
      sender: cleanSender(d.nadawca || g.sender),
      subject: d.temat || g.subject,
      date: d.data || g.rows[0].data,
      children: [...new Set(g.rows.map(r => childName(r.skrzynka)))],
      body: htmlToText(d.tresc),
      attachments: (d.zalaczniki ?? []).map(a => a.nazwaPliku),
    });
  }
  return out;
}

export default { name: 'inbox', thread: () => THREADS.inbox, alwaysOn: true, fetch, format: formatMessage };
