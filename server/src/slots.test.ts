import { test } from "node:test";
import assert from "node:assert/strict";
import { freeSlots } from "./slots.js";
import { localToUtc, parseRange, utcToLocal } from "./time.js";

const TZ = "America/Sao_Paulo";

test("localToUtc converte horário de São Paulo (UTC-3)", () => {
  assert.equal(localToUtc("2026-11-10", "09:00", TZ).toISOString(), "2026-11-10T12:00:00.000Z");
  assert.deepEqual(utcToLocal(new Date("2026-11-10T12:00:00Z"), TZ), { date: "2026-11-10", time: "09:00", weekday: 2 });
});

test("parseRange lê o formato do Postgres", () => {
  const r = parseRange('["2026-11-10 17:30:00+00","2026-11-10 18:30:00+00")');
  assert.equal(r.start.toISOString(), "2026-11-10T17:30:00.000Z");
  assert.equal(r.end.toISOString(), "2026-11-10T18:30:00.000Z");
});

test("freeSlots respeita escala, ocupados e duração", () => {
  const slots = freeSlots({
    date: "2026-11-10",
    timeZone: TZ,
    shifts: [{ start_time: "09:00:00", end_time: "11:00:00" }],
    busy: [{ start: localToUtc("2026-11-10", "09:30", TZ), end: localToUtc("2026-11-10", "10:00", TZ) }],
    durationMin: 30,
    stepMin: 30,
  });
  const times = slots.map((s) => utcToLocal(s, TZ).time);
  assert.deepEqual(times, ["09:00", "10:00", "10:30"]);
});

test("freeSlots não oferece horário que passa do fim do turno", () => {
  const slots = freeSlots({
    date: "2026-11-10", timeZone: TZ,
    shifts: [{ start_time: "09:00:00", end_time: "10:00:00" }],
    busy: [], durationMin: 45, stepMin: 15,
  });
  assert.deepEqual(slots.map((s) => utcToLocal(s, TZ).time), ["09:00", "09:15"]);
});
