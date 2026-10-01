import { STATE_FILE, MAX_PER_RUN, THREADS, assertConfig } from './config.mjs';
import { openSession } from './session.mjs';
import { sendText } from './telegram.mjs';
import { loadState, saveState } from './state.mjs';
import inbox from './modules/inbox.mjs';
import grades from './modules/grades.mjs';
import exams from './modules/exams.mjs';
import plan from './modules/plan.mjs';

const FAIL_ALERT_AT = 3;
const MODULES = [inbox, grades, exams, plan];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const sendExisting = args.has('--send-existing');
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
    await deliver(m.format(item), m.thread());
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
