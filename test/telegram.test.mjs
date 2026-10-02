import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
process.env.TELEGRAM_CHAT_ID = '-100123';
const { sendText, chunk, TelegramError } = await import('../src/telegram.mjs');

const ok = () => new Response('{"ok":true}', { status: 200 });
const fail = (status, body = 'err') => new Response(body, { status });

function mockFetch(t, ...responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return responses[Math.min(calls.length, responses.length) - 1]();
  });
  return calls;
}

test('sendText posts HTML to the bot API with chat, numeric topic and no link previews', async (t) => {
  const calls = mockFetch(t, ok);
  await sendText('<b>hi</b>', '29');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botTESTTOKEN\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: '-100123', text: '<b>hi</b>', disable_web_page_preview: true, message_thread_id: 29, parse_mode: 'HTML' });
});

test('no topic means General: message_thread_id is omitted', async (t) => {
  const calls = mockFetch(t, ok);
  await sendText('x', '');
  assert.equal('message_thread_id' in calls[0].body, false);
});

test('a 400 (malformed HTML) is resent once as plain text with tags removed and entities decoded', async (t) => {
  const calls = mockFetch(t, () => fail(400, "can't parse entities"), ok);
  await sendText('<b>A</b> &amp; B &lt;i&gt;', '2');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.text, 'A & B <i>');
  assert.equal('parse_mode' in calls[1].body, false);
});

test('errors carry the HTTP status; a failing plain retry and other 4xx/5xx are not retried further', async (t) => {
  let calls = mockFetch(t, () => fail(400), () => fail(400));
  await assert.rejects(sendText('x'), e => e instanceof TelegramError && e.status === 400);
  assert.equal(calls.length, 2);

  t.mock.restoreAll();
  calls = mockFetch(t, () => fail(500));
  await assert.rejects(sendText('x'), e => e.status === 500);
  assert.equal(calls.length, 1);

  t.mock.restoreAll();
  calls = mockFetch(t, () => fail(403, 'bot was kicked'));
  await assert.rejects(sendText('x'), /403: bot was kicked/);
  assert.equal(calls.length, 1);
});

test('a 429 waits for retry_after and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = mockFetch(t, () => new Response('{"parameters":{"retry_after":3}}', { status: 429 }), ok);
  const p = sendText('x');
  await new Promise(r => setImmediate(r));
  t.mock.timers.tick(3999);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1); // 3 s + 1 s margin not reached yet
  t.mock.timers.tick(1);
  await p;
  assert.equal(calls.length, 2);
});

test('long text is split into several messages under the limit', async (t) => {
  const calls = mockFetch(t, ok);
  await sendText(Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n'));
  assert.ok(calls.length > 1);
  assert.ok(calls.every(c => c.body.text.length <= 4000));
});

test('chunk never cuts inside an HTML entity or tag', () => {
  const entity = chunk('a'.repeat(3997) + '&amp;' + 'b'.repeat(100));
  assert.equal(entity.length, 2);
  assert.ok(!entity[0].endsWith('&am') && entity[1].startsWith('&amp;'));
  const tag = chunk('a'.repeat(3998) + '<b>x</b>' + 'c'.repeat(100));
  assert.ok(!/<b?$/.test(tag[0]));
  assert.equal(tag.join(''), 'a'.repeat(3998) + '<b>x</b>' + 'c'.repeat(100));
  // plain text without markers still cuts at the limit
  assert.deepEqual(chunk('x'.repeat(9000)).map(p => p.length), [4000, 4000, 1000]);
});
