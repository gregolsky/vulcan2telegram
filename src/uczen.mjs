import { UCZEN_BASE } from './config.mjs';

const today = () => new Date().toLocaleDateString('sv', { timeZone: 'Europe/Warsaw' }); // YYYY-MM-DD

/** The term (okres) containing `date`, falling back to the last one. */
export function currentPeriod(okresy, date = today()) {
  return okresy.find(o => o.DataOd.slice(0, 10) <= date && date <= o.DataDo.slice(0, 10)) ?? okresy.at(-1);
}

export function toStudent(s) {
  return {
    firstName: s.UczenImie,
    className: `${s.Poziom}${s.Symbol}`,
    idUczen: s.IdUczen,
    idDziennik: s.IdDziennik,
    year: s.DziennikRokSzkolny,
    okres: currentPeriod(s.Okresy).Id,
  };
}

async function load({ ctx, page }) {
  // The app's own first .mvc request carries the anti-forgery headers we must replay.
  const first = page.waitForRequest(r => r.url().includes('.mvc'), { timeout: 30_000 });
  await page.goto(`${UCZEN_BASE}/App`, { waitUntil: 'networkidle' });
  const h = (await first).headers();
  const headers = {
    'x-v-appversion': h['x-v-appversion'],
    'x-v-requestverificationtoken': h['x-v-requestverificationtoken'],
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/json',
  };
  if (!headers['x-v-requestverificationtoken']) throw new Error('Uczeń app: no anti-forgery token found');

  const post = async (path, body) => {
    const res = await ctx.request.post(`${UCZEN_BASE}/${path}`, { headers, data: body });
    if (!res.ok()) throw new Error(`Uczeń API ${path} -> HTTP ${res.status()}`);
    return res.json();
  };

  const dz = await post('UczenDziennik.mvc/Get', {});
  if (!Array.isArray(dz.data) || !dz.data.length) throw new Error('Uczeń API returned no students');
  const students = dz.data.map(toStudent);

  // The server keeps "current student" in two cookies; set them before each per-student call.
  const call = async (student, path, body) => {
    await ctx.addCookies([
      { name: 'idBiezacyUczen', value: String(student.idUczen) },
      { name: 'idBiezacyDziennik', value: String(student.idDziennik) },
    ].map(c => ({ ...c, domain: new URL(UCZEN_BASE).hostname, path: '/' })));
    const json = await post(path, body);
    if (json.data == null) throw new Error(`Uczeń API ${path} returned no data for ${student.firstName}`);
    return json.data;
  };

  return { students, call };
}

/** Shared per session: one page load, used by both grades and exams. */
export function getUczen(session) {
  return (session.uczen ??= load(session));
}
