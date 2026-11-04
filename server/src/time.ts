// Conversões entre horário local do salão e UTC sem dependências externas.

/** Diferença (ms) entre o horário local do fuso e UTC no instante dado. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** "2026-11-10" + "14:30" no fuso do salão -> Date (UTC). */
export function localToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(new Date(guess), timeZone);
  // segunda passada cobre virada de horário de verão
  return new Date(guess - tzOffsetMs(new Date(first), timeZone));
}

/** Date -> { date: "2026-11-10", time: "14:30", weekday: 0..6 } no fuso do salão. */
export function utcToLocal(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: weekdays.indexOf(get("weekday")),
  };
}

/** Texto amigável em pt-BR, ex.: "ter., 10/11 às 14:30". */
export function formatBr(instant: Date, timeZone: string): string {
  const d = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short", day: "2-digit", month: "2-digit" }).format(instant);
  const t = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(instant);
  return `${d} às ${t}`;
}

/** Lê um tstzrange do Postgres: ["2026-11-10 17:30:00+00","2026-11-10 18:30:00+00") */
export function parseRange(r: string): { start: Date; end: Date } {
  const m = r.match(/^[\[(]"?([^",]+)"?,"?([^"\])]+)"?[\])]$/);
  if (!m) throw new Error(`tstzrange inválido: ${r}`);
  const fix = (s: string) => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return { start: fix(m[1]), end: fix(m[2]) };
}

export function toRange(start: Date, end: Date): string {
  return `[${start.toISOString()},${end.toISOString()})`;
}
