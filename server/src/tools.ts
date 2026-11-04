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
}

const MIN_LEAD_MIN = 60; // antecedência mínima para agendar pelo WhatsApp
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
    name: "chamar_atendente",
    description: "Passa a conversa para uma pessoa da equipe e deixa a IA em silêncio. Use para reclamação, pedido de desconto, dúvida de saúde/contraindicação, pagamento, algo que você não consegue resolver, ou quando o cliente pedir uma pessoa.",
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
    case "chamar_atendente": return handoff(ctx, args.motivo);
  }
  return { ok: false, erro: "não implementado" };
}

// ---------------------------------------------------------------------------

async function listServices(ctx: Ctx): Promise<Result> {
  const { data, error } = await db
    .from("services")
    .select("id, name, category, duration_min, price_cents, description, professional_services(professionals(id, name, active))")
    .eq("tenant_id", ctx.tenantId)
    .eq("active", true)
    .order("category")
    .order("name");
  if (error) throw error;
  return {
    ok: true,
    servicos: (data ?? []).map((s: any) => ({
      id: s.id,
      nome: s.name,
      categoria: s.category,
      duracao_min: s.duration_min,
      preco: (s.price_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      descricao: s.description,
      profissionais: (s.professional_services ?? [])
        .map((ps: any) => ps.professionals)
        .filter((p: any) => p?.active)
        .map((p: any) => ({ id: p.id, nome: p.name })),
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
  return freeSlots({
    date, timeZone: ctx.timeZone, shifts: shifts.data ?? [], busy, durationMin,
    stepMin: 15, notBefore: new Date(Date.now() + MIN_LEAD_MIN * 60_000),
  });
}

async function searchSlots(ctx: Ctx, serviceId: string, date: string, professionalId: string | null): Promise<Result> {
  const service = await getService(ctx, serviceId);
  if (!service) return { ok: false, erro: "serviço não encontrado" };
  const pros = await professionalsFor(ctx, serviceId, professionalId);
  if (pros.length === 0) return { ok: false, erro: "nenhum profissional ativo faz esse serviço" };
  const result = [];
  for (const p of pros) {
    const slots = await slotsFor(ctx, p.id, date, service.duration_min);
    result.push({
      profissional_id: p.id,
      profissional: p.name,
      horarios: slots.slice(0, 12).map((s) => utcToLocal(s, ctx.timeZone).time),
      total_livres: slots.length,
    });
  }
  return { ok: true, servico: service.name, data: date, duracao_min: service.duration_min, opcoes: result };
}

async function book(ctx: Ctx, a: { servico_id: string; profissional_id: string; data: string; hora: string }): Promise<Result> {
  const service = await getService(ctx, a.servico_id);
  if (!service) return { ok: false, erro: "serviço não encontrado" };
  const pros = await professionalsFor(ctx, a.servico_id, a.profissional_id);
  if (pros.length === 0) return { ok: false, erro: "esse profissional não faz esse serviço" };
  const start = localToUtc(a.data, a.hora, ctx.timeZone);
  const free = await slotsFor(ctx, a.profissional_id, a.data, service.duration_min);
  if (!free.some((s) => s.getTime() === start.getTime())) {
    return { ok: false, erro: "horário indisponível; busque os horários de novo" };
  }
  const end = new Date(start.getTime() + service.duration_min * 60_000);
  const { data, error } = await db.from("appointments").insert({
    tenant_id: ctx.tenantId,
    unit_id: ctx.unitId,
    client_id: ctx.clientId,
    professional_id: a.profissional_id,
    service_id: a.servico_id,
    period: toRange(start, end),
    price_cents: service.price_cents,
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
    .select("id, period, status, service_id, professional_id, services(name, duration_min)")
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
  const duration = appt.services.duration_min as number;
  const start = localToUtc(a.data, a.hora, ctx.timeZone);
  const free = await slotsFor(ctx, proId, a.data, duration, appt.id);
  if (!free.some((s) => s.getTime() === start.getTime())) return { ok: false, erro: "horário indisponível" };
  const { error } = await db.from("appointments").update({
    professional_id: proId,
    period: toRange(start, new Date(start.getTime() + duration * 60_000)),
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

async function handoff(ctx: Ctx, reason: string): Promise<Result> {
  const { error } = await db.from("conversations").update({
    ai_paused: true, handoff_reason: reason, handoff_at: new Date().toISOString(),
  }).eq("tenant_id", ctx.tenantId).eq("id", ctx.conversationId);
  if (error) throw error;
  await audit(ctx.tenantId, "ai", "conversation.handoff", "conversations", ctx.conversationId, { reason });
  return { ok: true, instrucao: "avise o cliente que uma pessoa da equipe vai responder em breve" };
}
