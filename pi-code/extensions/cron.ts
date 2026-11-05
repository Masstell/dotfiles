// Five-field cron ("minute hour day-of-month month day-of-week"), evaluated in
// a named time zone. Shared by the in-session scheduler (schedule.ts) and the
// routine runner (routines/runner.ts), so both read a schedule the same way.
//
// Supported per field: *, n, a-b, lists (a,b), steps (*/n, a-b/n, n/step),
// month and weekday names (jan, mon), and 7 for Sunday. When both day fields
// are restricted, a day matches if either does (standard cron).

export type Cron = {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  domAny: boolean; dowAny: boolean; source: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, lo: number, hi: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const val = (s: string): number => {
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    const n = i >= 0 ? i + nameBase : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`"${s}" is out of range ${lo}-${hi}`);
    return n;
  };
  for (const part of text.split(",")) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad field "${text}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`bad step in "${part}"`);
    let a: number, b: number;
    if (m[1] === "*") { a = lo; b = hi; }
    else if (m[1].includes("-")) { const [x, y] = m[1].split("-"); a = val(x); b = val(y); if (a > b) throw new Error(`bad range "${m[1]}"`); }
    else { a = val(m[1]); b = m[2] === undefined ? a : hi; }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(source: string): Cron {
  const f = source.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${f.length}`);
  const dow = field(f[4], 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31),
    month: field(f[3], 1, 12, MONTHS, 1), dow,
    domAny: f[2] === "*", dowAny: f[4] === "*", source: f.join(" "),
  };
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock fields of an instant in a time zone. */
export function wallClock(t: number, tz: string) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", weekday: "short",
    });
    fmtCache.set(tz, fmt);
  }
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)),
  };
}

export type Wall = ReturnType<typeof wallClock>;

/** A sortable key for a wall-clock minute ("2026-11-01 01:30"). */
export function wallKey(w: Wall): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

/** The wall-clock minute after w (calendar arithmetic, no time zone). */
export function nextWall(w: Wall): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Does a wall-clock minute match? */
export function matchesWall(c: Cron, w: Wall): boolean {
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  const d = c.dom.has(w.day), wd = c.dow.has(w.dow);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return wd;
  if (c.dowAny) return d;
  return d || wd;
}

/** Does the minute containing instant t match? */
export function matches(c: Cron, t: number, tz: string): boolean {
  return matchesWall(c, wallClock(t, tz));
}

/** Runs more often than hourly: such jobs keep running through a DST change
 *  (the repeated hour runs twice, the skipped hour is not made up), as in cron. */
export function everyHour(c: Cron): boolean { return c.hour.size === 24; }

const MIN = 60_000;
/** The first matching minute strictly after t (ms, at :00 seconds), or
 *  undefined if none within ~4 years (e.g. "0 0 31 2 *"). Walks minutes, but
 *  skips hours that cannot match, so it stays cheap. Time zones with
 *  non-hour offsets (e.g. +5:30) still work: the walk checks every minute of
 *  an hour that can match. */
export function nextRun(c: Cron, after: number, tz: string): number | undefined {
  let t = Math.floor(after / MIN) * MIN + MIN;
  const limit = after + 4 * 366 * 24 * 60 * MIN;
  // When clocks fall back, an hour of wall time repeats: a job pinned to an
  // hour runs in the first pass only (a wall time it has already passed
  // doesn't count again), like cron.
  const afterKey = wallKey(wallClock(after, tz));
  const pinned = !everyHour(c);
  while (t <= limit) {
    const w = wallClock(t, tz);
    if (pinned && wallKey(w) <= afterKey) { t += MIN; continue; }
    const dayOk = c.month.has(w.month) && (c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(w.dow)
      : c.dowAny ? c.dom.has(w.day) : c.dom.has(w.day) || c.dow.has(w.dow));
    // Skip to the next hour boundary, never a whole day: around a DST change a
    // day is 23 or 25 hours long, and a day-sized jump could pass a match.
    if (!dayOk || !c.hour.has(w.hour)) { t += (60 - w.minute) * MIN; continue; }
    if (c.minute.has(w.minute)) return t;
    t += MIN;
  }
  return undefined;
}

/** Plain-English-ish description for listings: the expression plus the next run. */
export function describeNext(t: number | undefined, tz: string): string {
  if (t === undefined) return "never";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(t)) + ` (${tz})`;
}
