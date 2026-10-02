export const TZ = 'Europe/Warsaw';

/** YYYY-MM-DD of `d` in Warsaw time. */
export const ymd = (d = new Date()) => d.toLocaleDateString('sv', { timeZone: TZ });

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the week containing `date`, plus `weeks` weeks. */
export function mondayOf(date, weeks = 0) {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, weeks * 7 - dow);
}

/** "poniedziałek, 28 września 2026" */
export const plDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('pl-PL', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
