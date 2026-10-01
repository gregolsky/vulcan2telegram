import { TG_TOKEN, TG_CHAT } from './config.mjs';

const LIMIT = 4000; // Telegram hard limit is 4096

export function chunk(text) {
  const out = [];
  let rest = text;
  while (rest.length > LIMIT) {
    let cut = rest.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT / 2) cut = LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function send(text, thread, attempt = 0) {
  if (!TG_TOKEN || !TG_CHAT) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const payload = { chat_id: TG_CHAT, text, disable_web_page_preview: true };
  if (thread) payload.message_thread_id = Number(thread);
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 429 && attempt < 3) {
    const j = await res.json().catch(() => ({}));
    await new Promise(r => setTimeout(r, ((j.parameters?.retry_after ?? 5) + 1) * 1000));
    return send(text, thread, attempt + 1);
  }
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

/** Posts `text` to the given topic (message_thread_id); no thread = the group's General topic. */
export async function sendText(text, thread) {
  for (const part of chunk(text)) await send(part, thread);
}
