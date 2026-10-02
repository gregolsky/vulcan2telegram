import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/text.mjs';
import { cleanSender, childName, groupCopies, formatMessage } from '../src/modules/inbox.mjs';
import { chunk } from '../src/telegram.mjs';

test('htmlToText: paragraphs, entities, links, lists', () => {
  assert.equal(htmlToText('<p>Dzień&nbsp;dobry,</p><p>Razem &amp; osobno &#380;</p>'), 'Dzień dobry,\nRazem & osobno ż');
  assert.equal(htmlToText('<a href="https://x.pl/a">tutaj</a>'), 'tutaj (https://x.pl/a)');
  assert.equal(htmlToText('<a href="https://x.pl/a">https://x.pl/a</a>'), 'https://x.pl/a');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '• a\n• b');
});

test('htmlToText: strips script/style, collapses blank lines, tolerates empty input', () => {
  assert.equal(htmlToText('<style>p{}</style><script>alert(1)</script>hi'), 'hi');
  assert.equal(htmlToText('a<br><br><br><br>b'), 'a\n\nb');
  assert.equal(htmlToText(undefined), '');
  assert.equal(htmlToText('&unknown; &#xZZ;'), '&unknown; &#xZZ;');
});

test('cleanSender strips role and school suffix', () => {
  assert.equal(cleanSender('Kowalczyk Marek [KM] - P - (SP01)'), 'Kowalczyk Marek');
  assert.equal(cleanSender('Kowalska-Nowak Anna - P - (SP01)'), 'Kowalska-Nowak Anna');
  assert.equal(cleanSender('Jan Kowalski'), 'Jan Kowalski');
  assert.equal(cleanSender(undefined), '');
});

test('childName picks the given name from a parent mailbox (surname first)', () => {
  assert.equal(childName('Nowak Piotr - R - Nowak Adam - (SP01)'), 'Adam');
  assert.equal(childName('Nowak Piotr Jan - R - Nowak Celina - (SP01)'), 'Celina');
  assert.equal(childName('something unexpected'), 'something unexpected');
});

const row = (key, box, over = {}) => ({
  apiGlobalKey: key, korespondenci: 'Kowalczyk Marek', temat: 'opieka', skrzynka: box,
  data: '2026-09-30T19:18:17.500+02:00', ...over,
});

test('groupCopies merges per-mailbox copies of one message', () => {
  const g = groupCopies([row('a', 'A'), row('b', 'B', { data: '2026-09-30T19:18:15.000+02:00' }), row('c', 'C')]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].rows.map(r => r.apiGlobalKey).sort(), ['a', 'b', 'c']);
});

test('groupCopies keeps different subjects, senders and distant times apart', () => {
  const g = groupCopies([
    row('a', 'A'),
    row('b', 'A', { temat: 'inny temat' }),
    row('c', 'A', { korespondenci: 'Ktoś Inny' }),
    row('d', 'A', { data: '2026-09-30T20:18:17.500+02:00' }),
  ]);
  assert.equal(g.length, 4);
});

test('groupCopies returns groups oldest first', () => {
  const g = groupCopies([
    row('new', 'A', { temat: 'n', data: '2026-09-30T20:00:00+02:00' }),
    row('old', 'A', { temat: 'o', data: '2026-09-30T10:00:00+02:00' }),
  ]);
  assert.deepEqual(g.map(x => x.rows[0].apiGlobalKey), ['old', 'new']);
});

test('chunk splits long text under the Telegram limit, preferring newlines', () => {
  assert.deepEqual(chunk('short'), ['short']);
  const text = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
  const parts = chunk(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 4000));
  assert.equal(parts.join('\n'), text);
  const noBreaks = 'x'.repeat(9000);
  assert.equal(chunk(noBreaks).join(''), noBreaks);
});

test('formatMessage includes header, body and attachments; handles empty body', () => {
  const base = { subject: 'Temat', sender: 'Jan', children: ['Adam', 'Beata'], date: '2026-09-30T19:18:17+02:00', body: 'Treść', attachments: [] };
  const out = formatMessage({ ...base, attachments: [{ name: 'a.pdf', url: 'https://x/a' }] });
  assert.match(out, /^📬 <b>Temat<\/b>\n👤 Od: <b>Jan<\/b>\n🧒 Dla: Adam, Beata\n🕒 /);
  assert.match(out, /Treść/);
  assert.match(out, /📎 <b>Załączniki:<\/b>\n• a\.pdf\n {2}https:\/\/x\/a/);
  // message text from school is escaped so it cannot break Telegram's HTML
  const esc = formatMessage({ ...base, subject: 'A & B <i>', body: '1 < 2 & <b>x</b>', attachments: [{ name: 'a&b.pdf', url: 'https://x/?a=1&b=2' }] });
  assert.match(esc, /<b>A &amp; B &lt;i&gt;<\/b>/);
  assert.match(esc, /1 &lt; 2 &amp; &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(esc, /a&amp;b\.pdf\n {2}https:\/\/x\/\?a=1&amp;b=2/);
  assert.match(formatMessage({ ...base, body: '' }), /\(brak treści\)/);
  assert.match(formatMessage({ ...base, subject: '' }), /\(bez tematu\)/);
});
