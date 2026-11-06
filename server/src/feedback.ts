// Avaliação do atendimento: modelo "avaliacao_atendimento" aprovado na Meta, enviado
// algumas horas depois do atendimento concluído, com 3 botões (payload aval:<id>:<nota>).
// Só roda para salões com settings.avaliacao_pos = true.
import { db, audit } from "./db.js";
import { sendTemplate, sendText } from "./whatsapp.js";
import { parseRange, toRange, utcToLocal } from "./time.js";

export const FEEDBACK_TEMPLATE = process.env.FEEDBACK_TEMPLATE ?? "avaliacao_atendimento";
const LANG = process.env.FEEDBACK_TEMPLATE_LANG ?? "pt_BR";
const WAIT_H = 2, MAX_H = 20, FIRST_HOUR = 9, LAST_HOUR = 20;
const NOTAS: Record<string, number> = { "5": 5, "3": 3, "1": 1 };
const failed = new Set<string>();

export function feedbackText(nome: string, servico: string, prof: string) {
  return `Olá, ${nome}! Como foi seu atendimento de ${servico} com ${prof} hoje? Sua opinião ajuda muito a gente.`;
}

export async function runFeedback(): Promise<void> {
  const { data: tenants, error } = await db.from("tenants").select("id, timezone, settings");
  if (error) return console.error("avaliação: tenants", error.message);
  for (const t of tenants ?? []) {
    if (t.settings?.avaliacao_pos !== true) continue;
    try { await feedbackTenant(t); } catch (e) { console.error("avaliação", t.id, e); }
  }
}

async function feedbackTenant(t: { id: string; timezone: string }) {
  const hour = Number(utcToLocal(new Date(), t.timezone).time.slice(0, 2));
  if (hour < FIRST_HOUR || hour >= LAST_HOUR) return;
  const { data: num } = await db.from("wa_numbers").select("id, phone_number_id").eq("tenant_id", t.id).order("created_at").limit(1).maybeSingle();
  if (!num) return;
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const { data: aps, error } = await db.from("appointments")
    .select("id, period, client_id, professional_id, clients(full_name, phone_e164), services(name), professionals(name)")
    .eq("tenant_id", t.id).eq("status", "done").is("feedback_sent_at", null).overlaps("period", toRange(new Date(since), new Date())).limit(50);
  if (error) throw error;
  const sentTo = new Set<string>();
  for (const a of (aps ?? []) as any[]) {
    if (failed.has(a.id) || sentTo.has(a.client_id)) continue; // uma pesquisa por cliente por vez
    const fim = parseRange(a.period).end, h = (Date.now() - fim.getTime()) / 3600_000;
    if (h < WAIT_H) continue;
    if (h > MAX_H) { await db.from("appointments").update({ feedback_sent_at: new Date().toISOString() }).eq("id", a.id); continue; } // passou da hora: não manda
    const { data: consent } = await db.from("consents").select("granted")
      .eq("tenant_id", t.id).eq("client_id", a.client_id).eq("purpose", "service_messages")
      .order("recorded_at", { ascending: false }).limit(1).maybeSingle();
    if (consent && consent.granted === false) continue;
    const nome = (a.clients?.full_name || "").split(" ")[0] || "tudo bem";
    const servico = a.services?.name || "atendimento", prof = (a.professionals?.name || "nossa equipe").split(" ")[0];
    try {
      const waId = await sendTemplate(num.phone_number_id, a.clients.phone_e164, FEEDBACK_TEMPLATE, LANG,
        [nome, servico, prof], [`aval:${a.id}:5`, `aval:${a.id}:3`, `aval:${a.id}:1`]);
      sentTo.add(a.client_id);
      await db.from("appointments").update({ feedback_sent_at: new Date().toISOString() }).eq("id", a.id);
      const { data: conv } = await db.from("conversations")
        .upsert({ tenant_id: t.id, client_id: a.client_id, wa_number_id: num.id }, { onConflict: "wa_number_id,client_id", ignoreDuplicates: false })
        .select("id").single();
      if (conv) {
        await db.from("messages").insert({ tenant_id: t.id, conversation_id: conv.id, direction: "outbound", author: "system",
          wa_message_id: waId, body: feedbackText(nome, servico, prof) + " [botões: Ótimo | Bom | Pode melhorar]", status: "sent" });
        await db.from("conversations").update({ last_outbound_at: new Date().toISOString() }).eq("id", conv.id);
      }
      await audit(t.id, "system", "appointment.feedback_sent", "appointments", a.id);
    } catch (e: any) {
      failed.add(a.id);
      console.error("avaliação falhou", a.id, e?.message ?? e);
      await audit(t.id, "system", "appointment.feedback_failed", "appointments", a.id, { erro: String(e?.message ?? e).slice(0, 500) });
    }
  }
}

async function reply(tenantId: string, phoneNumberId: string, conversationId: string, phone: string, text: string) {
  const waId = await sendText(phoneNumberId, phone, text);
  await db.from("messages").insert({ tenant_id: tenantId, conversation_id: conversationId, direction: "outbound", author: "system",
    wa_message_id: waId, body: text, status: "sent" });
  await db.from("conversations").update({ last_outbound_at: new Date().toISOString() }).eq("id", conversationId);
}

/** Botão da pesquisa. Devolve true se tratou (a IA não responde). */
export async function handleFeedbackButton(tenantId: string, phoneNumberId: string, clientId: string, conversationId: string, phone: string, payload: string) {
  const [, apId, n] = payload.split(":");
  const rating = NOTAS[n]; if (!rating) return false;
  const { data: ap } = await db.from("appointments").select("id, professional_id, professionals(name)")
    .eq("tenant_id", tenantId).eq("client_id", clientId).eq("id", apId).maybeSingle();
  if (!ap) return false;
  const { error } = await db.from("feedbacks").upsert({ tenant_id: tenantId, appointment_id: ap.id, professional_id: ap.professional_id,
    client_id: clientId, rating, awaiting_comment: rating < 5 }, { onConflict: "appointment_id" });
  if (error) throw error;
  await audit(tenantId, "system", "feedback.rating", "appointments", ap.id, { rating });
  await reply(tenantId, phoneNumberId, conversationId, phone, rating === 5
    ? "Que bom! Muito obrigada pelo carinho 💛 Vamos contar para a equipe."
    : "Obrigada por contar. O que poderia ter sido melhor? Pode escrever aqui que eu passo direto para a gerência.");
  return true;
}

/** Texto logo depois de uma nota baixa vira o comentário da avaliação. */
export async function handleFeedbackComment(tenantId: string, phoneNumberId: string, clientId: string, conversationId: string, phone: string, text: string) {
  if (!text || text.startsWith("[")) return false;
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: fb } = await db.from("feedbacks").select("id, rating").eq("tenant_id", tenantId).eq("client_id", clientId)
    .eq("awaiting_comment", true).gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!fb) return false;
  await db.from("feedbacks").update({ comment: text.slice(0, 2000), awaiting_comment: false }).eq("id", fb.id);
  await db.from("conversations").update({ handoff_reason: "Avaliação do atendimento: " + text.slice(0, 200), handoff_at: new Date().toISOString() })
    .eq("id", conversationId);
  await reply(tenantId, phoneNumberId, conversationId, phone, "Obrigada, de verdade. Já passei para a gerência, e alguém da equipe pode te chamar por aqui.");
  return true;
}

export function startFeedback() {
  const every = Number(process.env.FEEDBACK_INTERVAL_MS ?? 15 * 60_000);
  setTimeout(() => runFeedback().catch((e) => console.error("avaliação", e)), 60_000);
  setInterval(() => runFeedback().catch((e) => console.error("avaliação", e)), every);
}
