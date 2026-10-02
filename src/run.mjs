import { STATE_FILE, MAX_PER_RUN, THREADS, DIGEST_ENABLED, assertConfig } from './config.mjs';
import { openSession } from './session.mjs';
import { sendText } from './telegram.mjs';
import { loadState, saveState } from './state.mjs';
import { esc } from './text.mjs';
import { runAll } from './runner.mjs';
import { maybeDigest } from './modules/digest.mjs';
import inbox from './modules/inbox.mjs';
import grades from './modules/grades.mjs';
import exams from './modules/exams.mjs';
import plan from './modules/plan.mjs';

const MODULES = [inbox, grades, exams, plan];

const args = new Set(process.argv.slice(2));
const flags = {
  dryRun: args.has('--dry-run'),
  sendExisting: args.has('--send-existing'),
  only: [...args].find(a => a.startsWith('--only='))?.slice(7).split(','),
};
const stamp = (f) => (msg) => f(`${new Date().toISOString()} ${msg}`);

// All messages are Telegram HTML: plain text goes through esc().
const deliver = flags.dryRun ? async (t, thread) => console.log(`\n${'─'.repeat(60)}\n[topic ${thread || 'General'}]\n${t}`) : sendText;
const alert = (msg) => sendText(`⚠️ ${esc(msg)}`, THREADS.inbox);

if (args.has('--test-telegram')) {
  for (const m of MODULES) if (m.thread() || m.alwaysOn) await sendText(`✅ vulcan-telegram: test message (${m.name})`, m.thread());
  console.log('sent');
} else {
  assertConfig();
  const state = loadState(STATE_FILE);
  const persist = flags.dryRun ? () => {} : () => saveState(STATE_FILE, state);
  process.exitCode = await runAll({
    modules: MODULES, state, persist, deliver, alert, openSession, flags, maxPerRun: MAX_PER_RUN,
    digest: (session, now) => maybeDigest({
      session, state, persist, deliver, now, dryRun: flags.dryRun, skip: Boolean(flags.only),
      force: args.has('--digest'), enabled: DIGEST_ENABLED, log: stamp(console.log),
    }),
    log: stamp(console.log), logError: stamp(console.error),
  });
}
