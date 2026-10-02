import { TG_TOKEN, TG_CHAT } from './config.mjs';
import { htmlToText } from './text.mjs';

const LIMIT = 4000; // Telegram hard limit is 4096

export class TelegramError extends Error {
  constructor(status, body) {
    super(`Telegram ${status}: ${body}`);
    this.status = status;
  }
}

/** Where to cut `text` (at most LIMIT chars) without splitting an HTML tag or entity. */
function cutPoint(text) {
  let cut = text.lastIndexOf('\n', LIMIT);
  if (cut < LIMIT / 2) cut = LIMIT;
  const head = text.slice(0, cut);
  const lt = head.lastIndexOf('<');
  if (lt > head.lastIndexOf('>') && lt > 0) return lt; // inside a tag
  const amp = head.lastIndexOf('&');
  if (amp > head.lastIndexOf(';') && cut - amp < 12 && amp > 0) return amp; // inside an entity
  return cut;
}

export function chunk(text) {
  const out = [];
  let rest = text;
  while (rest.length > LIMIT) {
    const cut = cutPoint(rest);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function post(text, thread, html, attempt = 0) {
  if (!TG_TOKEN || !TG_CHAT) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const payload = { chat_id: TG_CHAT, text, disable_web_page_preview: true };
  if (thread) payload.message_thread_id = Number(thread);
  if (html) payload.parse_mode = 'HTML';
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 429 && attempt < 3) {
    const j = await res.json().catch(() => ({}));
    await new Promise(r => setTimeout(r, ((j.parameters?.retry_after ?? 5) + 1) * 1000));
    return post(text, thread, html, attempt + 1);
  }
  if (!res.ok) throw new TelegramError(res.status, await res.text());
}

async function send(text, thread) {
  try {
    await post(text, thread, true);
  } catch (e) {
    // Malformed HTML ("can't parse entities"): resend once as plain text rather than block the queue.
    if (e.status !== 400) throw e;
    await post(htmlToText(text), thread, false);
  }
}

/** Posts `text` (Telegram HTML subset: escape plain text with `esc`) to a topic; no thread = General. */
export async function sendText(text, thread) {
  for (const part of chunk(text)) await send(part, thread);
}
