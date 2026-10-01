import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const MAX_SEEN = 2000;

/** state = { failures, modules: { [name]: { seen: string[], initialized: boolean } } } */
export function migrateState(raw) {
  if (!raw) return { failures: 0, modules: {} };
  if (raw.modules) return raw;
  // v1 layout: single inbox state at the top level
  return {
    failures: raw.failures ?? 0,
    modules: { inbox: { seen: raw.seen ?? [], initialized: raw.initialized ?? (raw.seen ?? []).length > 0 } },
  };
}

export function loadState(file) {
  return migrateState(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
}

export function saveState(file, state) {
  for (const m of Object.values(state.modules)) m.seen = m.seen.slice(-MAX_SEEN);
  writeFileSync(file + '.tmp', JSON.stringify(state));
  renameSync(file + '.tmp', file);
}
