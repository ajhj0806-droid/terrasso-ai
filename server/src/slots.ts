import { localToUtc } from "./time.js";

export interface Interval { start: Date; end: Date }
export interface Shift { start_time: string; end_time: string } // "09:00:00"

/**
 * Horários livres de um profissional num dia: turnos da escala menos
 * atendimentos e bloqueios, em passos fixos. Função pura para ser testável.
 */
export function freeSlots(opts: {
  date: string;              // dia local "YYYY-MM-DD"
  timeZone: string;
  shifts: Shift[];           // escala desse dia da semana
  busy: Interval[];          // atendimentos ativos + bloqueios
  durationMin: number;
  stepMin?: number;
  notBefore?: Date;          // ex.: agora + antecedência mínima
}): Date[] {
  const step = (opts.stepMin ?? 15) * 60_000;
  const dur = opts.durationMin * 60_000;
  const out: Date[] = [];
  for (const s of opts.shifts) {
    const shiftStart = localToUtc(opts.date, s.start_time.slice(0, 5), opts.timeZone).getTime();
    const shiftEnd = localToUtc(opts.date, s.end_time.slice(0, 5), opts.timeZone).getTime();
    for (let t = shiftStart; t + dur <= shiftEnd; t += step) {
      if (opts.notBefore && t < opts.notBefore.getTime()) continue;
      const end = t + dur;
      const clash = opts.busy.some((b) => t < b.end.getTime() && end > b.start.getTime());
      if (!clash) out.push(new Date(t));
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}
