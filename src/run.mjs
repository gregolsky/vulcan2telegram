import { STATE_FILE, MAX_PER_RUN, THREADS, DIGEST_ENABLED, assertConfig } from './config.mjs';
import { openSession } from './session.mjs';
import { sendText } from './telegram.mjs';
import { loadState, saveState } from './state.mjs';
import inbox from './modules/inbox.mjs';
import grades from './modules/grades.mjs';
import exams from './modules/exams.mjs';
import plan from './modules/plan.mjs';
import { isDue, buildDigest, toTelegramHtml } from './modules/digest.mjs';

const FAIL_ALERT_AT = 3;
const MODULES = [inbox, grades, exams, plan];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const sendExisting = args.has('--send-existing');
const forceDigest = args.has('--digest');
const only = [...args].find(a => a.startsWith('--only='))?.slice(7).split(',');

const deliver = dryRun ? async (t, thread) => console.log(`\n${'─'.repeat(60)}\n[topic ${thread || 'General'}]\n${t}`) : sendText;

async function runModule(m, ms, session, persist) {
  const firstRun = !ms.initialized;
  const seedOnly = firstRun && !sendExisting;
  const seen = new Set(ms.seen);
  const { allKeys, fresh } = await m.fetch(session, { isSeen: k => seen.has(k), seedOnly });

  if (seedOnly) {
    ms.seen = allKeys;
    ms.initialized = true;
    persist();
    console.log(`${new Date().toISOString()} [${m.name}] ${dryRun ? 'dry-run: would initialize' : 'initialized'} with ${allKeys.length} existing item(s); nothing sent`);
    return;
  }

  // oldest first; items beyond the cap stay unseen and go out next run
  const batch = fresh.slice(0, MAX_PER_RUN);
  for (const item of batch) {
    await deliver(m.format(item), m.thread(), { html: true });
    item.keys.forEach(k => seen.add(k));
    ms.seen = [...seen];
    persist(); // after each send, so a crash never causes duplicates
  }
  ms.initialized = true;
  persist();
  console.log(`${new Date().toISOString()} [${m.name}] sent ${batch.length} new item(s)`);
}

async function main() {
  if (args.has('--test-telegram')) {
    for (const m of MODULES) if (m.thread() || m.alwaysOn) await sendText(`✅ vulcan-telegram: test message (${m.name})`, m.thread());
    console.log('sent');
    return;
  }
  assertConfig();

  const state = loadState(STATE_FILE);
  const persist = dryRun ? () => {} : () => saveState(STATE_FILE, state);
  // Modules without a topic stay off (except the inbox, which falls back to General).
  const active = MODULES.filter(m => (!only || only.includes(m.name)) && (dryRun || m.alwaysOn || m.thread()));
  for (const m of MODULES) if (!active.includes(m)) console.log(`[${m.name}] skipped`);

  const errors = [];
  let session;
  try {
    session = await openSession();
    for (const m of active) {
      state.modules[m.name] ??= { seen: [], initialized: false };
      try {
        await runModule(m, state.modules[m.name], session, persist);
      } catch (e) {
        errors.push(`${m.name}: ${e.message}`);
      }
    }
    // Weekly summary: Wed/Sat evening, once a day; `--digest` forces it. Without a Claude token it is skipped with a log line.
    const digestDue = forceDigest || (!only && !dryRun && isDue(new Date(), state.digest?.last));
    if (digestDue && !forceDigest && !DIGEST_ENABLED) {
      console.log(`${new Date().toISOString()} [digest] skipped: CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) not set, weekly summary unavailable`);
    } else if (digestDue) {
      try {
        const text = await buildDigest(session);
        await deliver(`📋 <b>Podsumowanie na kolejne 7 dni</b>\n\n${toTelegramHtml(text)}`, '', { html: true });
        if (!dryRun) { state.digest = { last: new Date().toLocaleDateString('sv', { timeZone: 'Europe/Warsaw' }) }; persist(); }
        console.log(`${new Date().toISOString()} [digest] sent`);
      } catch (e) {
        errors.push(`digest: ${e.message}`);
      }
    }
  } catch (e) {
    errors.push(`login: ${e.message}`);
  } finally {
    await session?.close();
  }

  if (!errors.length) {
    state.failures = 0;
    persist();
    return;
  }
  for (const e of errors) console.error(`${new Date().toISOString()} ERROR: ${e}`);
  process.exitCode = 1;
  if (dryRun) return;
  state.failures = (state.failures ?? 0) + 1;
  persist();
  if (state.failures === FAIL_ALERT_AT) {
    await sendText(`⚠️ vulcan-telegram failed ${FAIL_ALERT_AT} runs in a row:\n${errors.join('\n')}`, THREADS.inbox).catch(() => {});
  }
}

await main();
