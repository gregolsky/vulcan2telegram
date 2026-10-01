const env = (k, d = '') => process.env[k] || d;

export const USERNAME = env('VULCAN_USERNAME');
export const PASSWORD = env('VULCAN_PASSWORD');
export const PORTAL_URL = env('VULCAN_URL').replace(/\/$/, '');
export const SYMBOL = PORTAL_URL.split('/').pop();
export const SCHOOL_UNIT_ID = env('VULCAN_SCHOOL_UNIT_ID');
export const WIADOMOSCI_BASE = `https://uonetplus-wiadomosciplus.vulcan.net.pl/${SYMBOL}`;
export const UCZEN_BASE = `https://uonetplus-uczen.vulcan.net.pl/${SYMBOL}/${SCHOOL_UNIT_ID}`;

export const TG_TOKEN = env('TELEGRAM_BOT_TOKEN');
export const TG_CHAT = env('TELEGRAM_CHAT_ID');
// One topic per module. The inbox always runs (General topic if unset); grades/exams/plan run only when set.
export const THREADS = {
  inbox: env('TELEGRAM_THREAD_ID'),
  grades: env('TELEGRAM_THREAD_GRADES'),
  exams: env('TELEGRAM_THREAD_EXAMS'),
  plan: env('TELEGRAM_THREAD_PLAN'),
};

export const STATE_FILE = env('STATE_FILE', new URL('../state.json', import.meta.url).pathname);
export const MAX_PER_RUN = Number(env('MAX_PER_RUN', 20));
export const EXAMS_WEEKS = Number(env('EXAMS_WEEKS', 4));
export const CHROMIUM_PATH = env('CHROMIUM_PATH') || undefined; // e.g. /usr/bin/chromium on the Pi

export function assertConfig() {
  for (const k of ['VULCAN_USERNAME', 'VULCAN_PASSWORD', 'VULCAN_URL', 'VULCAN_SCHOOL_UNIT_ID']) {
    if (!process.env[k]) throw new Error(`Missing env var ${k} (see .env.example)`);
  }
}
