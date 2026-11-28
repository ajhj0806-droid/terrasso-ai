// Ferramentas da recepcionista IA. Toda ação passa pelo banco com tenant_id
// explícito e fica registrada no audit_log.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { db, audit } from "./db.js";
import { freeSlots, type Interval } from "./slots.js";
import { formatBr, localToUtc, parseRange, toRange, utcToLocal } from "./time.js";

export interface Ctx {
  tenantId: string;
  timeZone: string;
  clientId: string;
  conversationId: string;
  unitId: string | null;
  /** Antecedência mínima (min) para marcar pelo WhatsApp; vem de tenants.settings.antecedencia_min. */
  leadMin?: number;
}

const MIN_LEAD_MIN = 60; // antecedência mínima padrão para agendar pelo WhatsApp
const leadOf = (ctx: Ctx) => (Number.isFinite(ctx.leadMin) && (ctx.leadMin as number) >= 0 ? (ctx.leadMin as number) : MIN_LEAD_MIN);
const nullableStr = { type: ["string", "null"] } as const;

export const toolDefs: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "listar_servicos",
    description: "Lista os serviços ativos do salão com id, duração, preço, descrição e quais profissionais fazem cada um. Use antes de falar de preço ou buscar horário.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "buscar_horarios",
    description: "Busca horários livres para um serviço numa data (horário local do salão). Se profissional_id for null, procura em todos que fazem o serviço.",
    input_schema: {
      type: "object",
      properties: {
        servico_id: { type: "string" },
        data: { type: "string", description: "YYYY-MM-DD" },
        profissional_id: { ...nullableStr },
      },
      required: ["servico_id", "data", "profissional_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "agendar",
    description: "Cria o agendamento depois que o cliente confirmou serviço, profissional, data e hora. Só use horários vindos de buscar_horarios.",
    input_schema: {
      type: "object",
      properties: {
        servico_id: { type: "string" },
        profissional_id: { type: "string" },
        data: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "HH:MM, horário local" },
      },
      required: ["servico_id", "profissional_id", "data", "hora"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "meus_agendamentos",
    description: "Lista os próximos agendamentos deste cliente, com id.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "remarcar_agendamento",
    description: "Muda data/hora (e opcionalmente o profissional) de um agendamento do cliente. Confirme o novo horário com buscar_horarios antes.",
    input_schema: {
      type: "object",
      properties: {
        agendamento_id: { type: "string" },
        data: { type: "string", description: "YYYY-MM-DD" },
        hora: { type: "string", description: "HH:MM" },
        profissional_id: { ...nullableStr },
      },
      required: ["agendamento_id", "data", "hora", "profissional_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "cancelar_agendamento",
    description: "Cancela um agendamento do cliente depois que ele confirmou que quer cancelar.",
    input_schema: {
      type: "object",
      properties: { agendamento_id: { type: "string" } },
      required: ["agendamento_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "salvar_nome",
    description: "Guarda o nome completo do cliente quando ele informar.",
    input_schema: {
      type: "object",
      properties: { nome: { type: "string" } },
      required: ["nome"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "avisar_equipe",
    description: "Registra um pedido para a equipe decidir depois (ex.: desconto, encaixe fora do horário, preferência especial) SEM tirar você da conversa. Você continua atendendo normalmente.",
    input_schema: {
      type: "object",
      properties: { pedido: { type: "string" } },
      required: ["pedido"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "chamar_atendente",
    description: "Passa a conversa inteira para uma pessoa da equipe e deixa a IA em silêncio. Use só para reclamação, dúvida de saúde/contraindicação, pagamento, algo que você não consegue resolver, ou quando o cliente pedir para falar com uma pessoa.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string" } },
      required: ["motivo"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const schemas = {
  listar_servicos: z.object({}),
  buscar_horarios: z.object({ servico_id: z.uuid(), data: z.iso.date(), profissional_id: z.uuid().nullable() }),
  agendar: z.object({ servico_id: z.uuid(), profissional_id: z.uuid(), data: z.iso.date(), hora: z.string().regex(/^\d\d:\d\d$/) }),
  meus_agendamentos: z.object({}),
  remarcar_agendamento: z.object({ agendamento_id: z.uuid(), data: z.iso.date(), hora: z.string().regex(/^\d\d:\d\d$/), profissional_id: z.uuid().nullable() }),
  cancelar_agendamento: z.object({ agendamento_id: z.uuid() }),
  salvar_nome: z.object({ nome: z.string().min(2).max(120) }),
  avisar_equipe: z.object({ pedido: z.string().max(500) }),
  chamar_atendente: z.object({ motivo: z.string().max(500) }),
};

type Result = { ok: boolean; [k: string]: unknown };

export async function runTool(name: string, input: unknown, ctx: Ctx): Promise<Result> {
  const schema = schemas[name as keyof typeof schemas];
  if (!schema) return { ok: false, erro: `ferramenta desconhecida: ${name}` };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, erro: "parâmetros inválidos", detalhes: parsed.error.issues };
  const args: any = parsed.data;
  switch (name) {
    case "listar_servicos": return listServices(ctx);
    case "buscar_horarios": return searchSlots(ctx, args.servico_id, args.data, args.profissional_id);
    case "agendar": return book(ctx, args);
    case "meus_agendamentos": return myAppointments(ctx);
    case "remarcar_agendamento": return reschedule(ctx, args);
    case "cancelar_agendamento": return cancel(ctx, args.agendamento_id);
    case "salvar_nome": return saveName(ctx, args.nome);
    case "avisar_equipe": return notifyTeam(ctx, args.pedido);
    case "chamar_atendente": return handoff(ctx, args.motivo);
  }
  return { ok: false, erro: "não implementado" };
}

// ---------------------------------------------------------------------------

/**
 * Preço e duração próprios de cada profissional por serviço (professional_services.price_cents / duration_min).
 * Em branco vale o padrão do serviço. Se a migração ainda não rodou (colunas inexistentes), devolve vazio
 * e tudo segue com o padrão do serviço.
 */
type Override = { price_cents: number | null; duration_min: number | null };
async function overrides(ctx: Ctx, serviceId?: string): Promise<Map<string, Override>> {
  let q = db.from("professional_services").select("professional_id, service_id, price_cents, duration_min").eq("tenant_id", ctx.tenantId);
  if (serviceId) q = q.eq("service_id", serviceId);
  const { data, error } = await q;
  const m = new Map<string, Override>();
  if (error) return m;
  for (const r of (data ?? []) as any[]) m.set(`${r.professional_id}:${r.service_id}`, { price_cents: r.price_cents, duration_min: r.duration_min });
  return m;
}
const priceFor = (ov: Map<string, Override>, s: { id: string; price_cents: number }, proId: string) => ov.get(`${proId}:${s.id}`)?.price_cents ?? s.price_cents;
const durationFor = (ov: Map<string, Override>, s: { id: string; duration_min: number }, proId: string) => ov.get(`${proId}:${s.id}`)?.duration_min ?? s.duration_min;
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function listServices(ctx: Ctx): Promise<Result> {
  const { data, error } = await db
    .from("services")
    .select("id, name, category, duration_min, price_cents, description, professional_services(professionals(id, name, active))")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("category")
    .order("name");
  if (error) throw error;
  const ov = await overrides(ctx);
  return {
    ok: true,
    observacao: "Quando um profissional tem preço ou duração próprios, eles aparecem nele; senão valem o preço e a duração do serviço.",
    servicos: (data ?? []).map((s: any) => ({
      id: s.id,
      nome: s.name,
      categoria: s.category,
      duracao_min: s.duration_min,
      preco: brl(s.price_cents),
      descricao: s.description,
      profissionais: (s.professional_services ?? [])
        .map((ps: any) => ps.professionals)
        .filter((p: any) => p?.active)
        .map((p: any) => {
          const pc = priceFor(ov, s, p.id), du = durationFor(ov, s, p.id);
          return { id: p.id, nome: p.name, ...(pc !== s.price_cents ? { preco: brl(pc) } : {}), ...(du !== s.duration_min ? { duracao_min: du } : {}) };
        }),
    })),
  };
}

async function getService(ctx: Ctx, serviceId: string) {
  const { data } = await db.from("services").select("id, name, duration_min, price_cents")
    .eq("tenant_id", ctx.tenantId).eq("id", serviceId).eq("active", true).maybeSingle();
  return data;
}

async function professionalsFor(ctx: Ctx, serviceId: string, onlyId: string | null) {
  let q = db.from("professional_services")
    .select("professional_id, professionals!inner(id, name, active)")
    .eq("tenant_id", ctx.tenantId).eq("service_id", serviceId).eq("professionals.active", true);
  if (onlyId) q = q.eq("professional_id", onlyId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.professionals.id as string, name: r.professionals.name as string }));
}

/** Horários livres de UM profissional num dia; ignora um agendamento (para remarcar). */
async function slotsFor(ctx: Ctx, professionalId: string, date: string, durationMin: number, ignoreAppointmentId?: string) {
  const dayStart = localToUtc(date, "00:00", ctx.timeZone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
  const weekday = utcToLocal(new Date(dayStart.getTime() + 12 * 3600_000), ctx.timeZone).weekday;
  const range = toRange(dayStart, dayEnd);

  const [shifts, appts, blocks] = await Promise.all([
    db.from("work_schedules").select("start_time, end_time")
      .eq("tenant_id", ctx.tenantId).eq("professional_id", professionalId).eq("weekday", weekday),
    db.from("appointments").select("id, period")
      .eq("tenant_id", ctx.tenantId).eq("professional_id", professionalId)
      .not("status", "in", "(cancelled,no_show)").overlaps("period", range),
    db.from("blocks").select("period")
      .eq("tenant_id", ctx.tenantId).eq("professional_id", professionalId).overlaps("period", range),
  ]);
  for (const r of [shifts, appts, blocks]) if (r.error) throw r.error;

  const busy: Interval[] = [
    ...(appts.data ?? []).filter((a: any) => a.id !== ignoreAppointmentId).map((a: any) => parseRange(a.period)),
    ...(blocks.data ?? []).map((b: any) => parseRange(b.period)),
  ];
  const slots = freeSlots({
    date, timeZone: ctx.timeZone, shifts: shifts.data ?? [], busy, durationMin,
    stepMin: 15, notBefore: new Date(Date.now() + leadOf(ctx) * 60_000),
  });
  return Object.assign(slots, {
    expediente: (shifts.data ?? []).map((s: any) => `${s.start_time.slice(0, 5)}-${s.end_time.slice(0, 5)}`).sort(),
    ocupados: busy.map((b) => `${utcToLocal(b.start, ctx.timeZone).time}-${utcToLocal(b.end, ctx.timeZone).time}`).sort(),
  });
}

async function searchSlots(ctx: Ctx, serviceId: string, date: string, professionalId: string | null): Promise<Result> {
  const service = await getService(ctx, serviceId);
  if (!service) return { ok: false, erro: "serviço não encontrado" };
  const pros = await professionalsFor(ctx, serviceId, professionalId);
  if (pros.length === 0) return { ok: false, erro: "nenhum profissional ativo faz esse serviço" };
  const result = [];
  const lead = leadOf(ctx), hoje = utcToLocal(new Date(), ctx.timeZone).date;
  const ov = await overrides(ctx, serviceId);
  for (const p of pros) {
    const dur = durationFor(ov, service, p.id);
    const slots = await slotsFor(ctx, p.id, date, dur);
    result.push({
      profissional_id: p.id,
      profissional: p.name,
      preco: brl(priceFor(ov, service, p.id)),
      duracao_min: dur,
      // todos os inícios possíveis (passo de 15 min); não cortar, senão a tarde some
      horarios: slots.map((s) => utcToLocal(s, ctx.timeZone).time),
      expediente_no_dia: slots.expediente.length ? slots.expediente : "não trabalha nesse dia (sem horário cadastrado)",
      ocupados: slots.ocupados,
    });
  }
  return {
    ok: true, servico: service.name, data: date, duracao_min: service.duration_min, opcoes: result,
    regras: [
      `Só aparecem inícios em que o serviço inteiro (a duração de cada profissional, em 'duracao_min' da opção) cabe antes do fim do expediente e não encosta em 'ocupados'.`,
      "Se o preço for diferente entre os profissionais, informe o preço de quem a cliente escolher.",
      date === hoje ? `Pelo WhatsApp só dá para marcar com ${lead} min de antecedência: hoje, nada antes de ${utcToLocal(new Date(Date.now() + lead * 60_000), ctx.timeZone).time}.` : "",
      "Se o horário pedido não estiver em 'horarios', explique o motivo real com esses dados (fora do expediente, antecedência mínima, ocupado ou o serviço não cabe até o fim do expediente). Nunca diga que a agenda mudou ou que há bloqueio se 'ocupados' estiver vazio.",
    ].filter(Boolean),
  };
}

async function book(ctx: Ctx, a: { servico_id: string; profissional_id: string; data: string; hora: string }): Promise<Result> {
  const service = await getService(ctx, a.servico_id);
  if (!service) return { ok: false, erro: "serviço não encontrado" };
  const pros = await professionalsFor(ctx, a.servico_id, a.profissional_id);
  if (pros.length === 0) return { ok: false, erro: "esse profissional não faz esse serviço" };
  const start = localToUtc(a.data, a.hora, ctx.timeZone);
  const ov = await overrides(ctx, a.servico_id);
  const dur = durationFor(ov, service, a.profissional_id);
  const free = await slotsFor(ctx, a.profissional_id, a.data, dur);
  if (!free.some((s) => s.getTime() === start.getTime())) {
    return { ok: false, erro: "horário indisponível; busque os horários de novo" };
  }
  const end = new Date(start.getTime() + dur * 60_000);
  const { data, error } = await db.from("appointments").insert({
    tenant_id: ctx.tenantId,
    unit_id: ctx.unitId,
    client_id: ctx.clientId,
    professional_id: a.profissional_id,
    service_id: a.servico_id,
    period: toRange(start, end),
    price_cents: priceFor(ov, service, a.profissional_id),
    source: "whatsapp_ai",
  }).select("id").single();
  if (error) {
    // 23P01 = exclusion_violation: alguém ocupou o horário no meio do caminho
    if (error.code === "23P01") return { ok: false, erro: "horário acabou de ser ocupado; ofereça outro" };
    throw error;
  }
  await audit(ctx.tenantId, "ai", "appointment.create", "appointments", data.id, { conversation: ctx.conversationId, ...a });
  return {
    ok: true,
    agendamento_id: data.id,
    resumo: `${service.name} com ${pros[0].name}, ${formatBr(start, ctx.timeZone)}`,
  };
}

async function myAppointments(ctx: Ctx): Promise<Result> {
  const { data, error } = await db.from("appointments")
    .select("id, period, status, services(name), professionals(name)")
    .eq("tenant_id", ctx.tenantId).eq("client_id", ctx.clientId)
    .in("status", ["scheduled", "confirmed"])
    .overlaps("period", toRange(new Date(), new Date(Date.now() + 365 * 86400_000)))
    .order("period");
  if (error) throw error;
  return {
    ok: true,
    agendamentos: (data ?? []).map((a: any) => ({
      id: a.id,
      quando: formatBr(parseRange(a.period).start, ctx.timeZone),
      servico: a.services?.name,
      profissional: a.professionals?.name,
      status: a.status,
    })),
  };
}

async function ownAppointment(ctx: Ctx, id: string) {
  const { data } = await db.from("appointments")
    .select("id, period, status, service_id, professional_id, price_cents, services(name, duration_min, price_cents)")
    .eq("tenant_id", ctx.tenantId).eq("client_id", ctx.clientId).eq("id", id).maybeSingle();
  return data as any;
}

async function reschedule(ctx: Ctx, a: { agendamento_id: string; data: string; hora: string; profissional_id: string | null }): Promise<Result> {
  const appt = await ownAppointment(ctx, a.agendamento_id);
  if (!appt || !["scheduled", "confirmed"].includes(appt.status)) return { ok: false, erro: "agendamento não encontrado" };
  const proId = a.profissional_id ?? appt.professional_id;
  if (proId !== appt.professional_id) {
    const pros = await professionalsFor(ctx, appt.service_id, proId);
    if (pros.length === 0) return { ok: false, erro: "esse profissional não faz esse serviço" };
  }
  const ov = await overrides(ctx, appt.service_id);
  const serv = { id: appt.service_id as string, duration_min: appt.services.duration_min as number, price_cents: appt.services.price_cents as number };
  const duration = durationFor(ov, serv, proId);
  // trocou de profissional: o preço passa a ser o do novo profissional
  const novoPreco = proId !== appt.professional_id ? priceFor(ov, serv, proId) : appt.price_cents;
  const start = localToUtc(a.data, a.hora, ctx.timeZone);
  const free = await slotsFor(ctx, proId, a.data, duration, appt.id);
  if (!free.some((s) => s.getTime() === start.getTime())) return { ok: false, erro: "horário indisponível" };
  const { error } = await db.from("appointments").update({
    professional_id: proId,
    period: toRange(start, new Date(start.getTime() + duration * 60_000)),
    price_cents: novoPreco,
    status: "scheduled",
    updated_at: new Date().toISOString(),
  }).eq("tenant_id", ctx.tenantId).eq("id", appt.id);
  if (error) {
    if (error.code === "23P01") return { ok: false, erro: "horário acabou de ser ocupado" };
    throw error;
  }
  await audit(ctx.tenantId, "ai", "appointment.reschedule", "appointments", appt.id, { from: appt.period, ...a });
  return { ok: true, resumo: `${appt.services.name} remarcado para ${formatBr(start, ctx.timeZone)}` };
}

async function cancel(ctx: Ctx, id: string): Promise<Result> {
  const appt = await ownAppointment(ctx, id);
  if (!appt || !["scheduled", "confirmed"].includes(appt.status)) return { ok: false, erro: "agendamento não encontrado" };
  const { error } = await db.from("appointments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("id", id);
  if (error) throw error;
  await audit(ctx.tenantId, "ai", "appointment.cancel", "appointments", id, { conversation: ctx.conversationId });
  return { ok: true, resumo: `${appt.services.name} de ${formatBr(parseRange(appt.period).start, ctx.timeZone)} cancelado` };
}

async function saveName(ctx: Ctx, name: string): Promise<Result> {
  const { error } = await db.from("clients").update({ full_name: name })
    .eq("tenant_id", ctx.tenantId).eq("id", ctx.clientId);
  if (error) throw error;
  return { ok: true };
}

async function notifyTeam(ctx: Ctx, request: string): Promise<Result> {
  const { error } = await db.from("conversations").update({
    handoff_reason: request, handoff_at: new Date().toISOString(),
  }).eq("tenant_id", ctx.tenantId).eq("id", ctx.conversationId);
  if (error) throw error;
  await audit(ctx.tenantId, "ai", "conversation.team_request", "conversations", ctx.conversationId, { request });
  return { ok: true, instrucao: "diga ao cliente que a equipe vai analisar o pedido e retornar; continue o atendimento normalmente" };
}

async function handoff(ctx: Ctx, reason: string): Promise<Result> {
  const { error } = await db.from("conversations").update({
    ai_paused: true, handoff_reason: reason, handoff_at: new Date().toISOString(),
  }).eq("tenant_id", ctx.tenantId).eq("id", ctx.conversationId);
  if (error) throw error;
  await audit(ctx.tenantId, "ai", "conversation.handoff", "conversations", ctx.conversationId, { reason });
  return { ok: true, instrucao: "avise o cliente que uma pessoa da equipe vai responder em breve" };
}
