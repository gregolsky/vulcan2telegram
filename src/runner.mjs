export const FAIL_ALERT_AT = 3;
export const FAIL_REMIND_EVERY = 72; // then roughly daily at a 20 minute interval

// A 4xx other than 429 will not succeed on retry, so such an item must not block the queue.
const isPermanent = (e) => e.status >= 400 && e.status < 500 && e.status !== 429;

/** Fetches one module and delivers its new items, recording each as seen right after it is sent. */
export async function runModule(m, ms, session, { deliver, alert, persist, sendExisting, dryRun, maxPerRun, floodLimit = Infinity, now, log }) {
  const seedOnly = !ms.initialized && !sendExisting;
  let seen = new Set(ms.seen);
  // A first run only records what exists: pretending everything is seen also stops modules from fetching details.
  const { allKeys, fresh } = await m.fetch(session, { isSeen: seedOnly ? () => true : k => seen.has(k), now });

  if (seedOnly) {
    ms.seen = allKeys;
    ms.initialized = true;
    persist();
    log(`[${m.name}] ${dryRun ? 'dry-run: would initialize' : 'initialized'} with ${allKeys.length} existing item(s); nothing sent`);
    return;
  }

  // Keep the keys still visible at the end, so trimming the list in saveState drops only ones that are gone.
  const visible = new Set(allKeys);
  const order = [...seen];
  seen = new Set([...order.filter(k => !visible.has(k)), ...order.filter(k => visible.has(k))]);
  ms.seen = [...seen];

  // A sudden pile of "new" items means the keys stopped matching (changed ids, lost state), not that
  // that much really happened: record them instead of flooding the chat.
  const pending = fresh.filter(i => !i.silent).length;
  if (!sendExisting && pending > floodLimit) {
    fresh.forEach(i => i.keys.forEach(k => seen.add(k)));
    ms.seen = [...seen];
    persist();
    await alert(`[${m.name}] ${pending} new items at once (limit ${floodLimit}): treated as already known, nothing sent`).catch(() => {});
    log(`[${m.name}] flood guard: ${pending} items recorded, not sent`);
    return;
  }

  // oldest first; items beyond the cap stay unseen and go out next run
  let sent = 0;
  for (const item of fresh.slice(0, maxPerRun)) {
    if (item.keys.every(k => seen.has(k))) continue;
    if (!item.silent) {
      try {
        await deliver(m.format(item), m.thread());
        sent++;
      } catch (e) {
        if (!isPermanent(e)) throw e;
        await alert(`[${m.name}] skipped an item Telegram rejects: ${e.message}`).catch(() => {});
      }
    }
    item.keys.forEach(k => seen.add(k));
    ms.seen = [...seen];
    persist(); // after each item, so a crash never causes duplicates
  }
  ms.initialized = true;
  persist();
  log(`[${m.name}] sent ${sent} new item(s)`);
}

/**
 * One pass over all active modules plus the optional digest. Everything external is injected
 * (see run.mjs). Returns the process exit code.
 */
export async function runAll({ modules, state, persist, deliver, alert, openSession, digest, flags, maxPerRun, floodLimit, now = () => new Date(), log = console.log, logError = console.error }) {
  const { dryRun = false, sendExisting = false, only } = flags;
  // Modules without a topic stay off (except the inbox, which falls back to General).
  const active = modules.filter(m => (!only || only.includes(m.name)) && (dryRun || m.alwaysOn || m.thread()));
  for (const m of modules) if (!active.includes(m)) log(`[${m.name}] skipped`);

  const errors = [];
  let session;
  try {
    session = await openSession();
    for (const m of active) {
      state.modules[m.name] ??= { seen: [], initialized: false };
      try {
        await runModule(m, state.modules[m.name], session, { deliver, alert, persist, sendExisting, dryRun, maxPerRun, floodLimit, now: now(), log });
      } catch (e) {
        errors.push(`${m.name}: ${e.message}`);
      }
    }
    try {
      await digest?.(session, now());
    } catch (e) {
      errors.push(`digest: ${e.message}`);
    }
  } catch (e) {
    errors.push(`login: ${e.message}`);
  } finally {
    await session?.close();
  }

  if (!errors.length) {
    state.failures = 0;
    persist();
    return 0;
  }
  for (const e of errors) logError(`ERROR: ${e}`);
  if (dryRun) return 1;
  state.failures = (state.failures ?? 0) + 1;
  persist();
  const n = state.failures;
  if (n === FAIL_ALERT_AT || (n > FAIL_ALERT_AT && (n - FAIL_ALERT_AT) % FAIL_REMIND_EVERY === 0)) {
    await alert(`vulcan-telegram failed ${n} runs in a row:\n${errors.join('\n')}`).catch(() => {});
  }
  return 1;
}
