// Lembrete na véspera: modelo "lembrete_vespera" aprovado na Meta, com os botões
// "Confirmar" (payload confirmar:<id>, tratado em inbound.ts) e "Preciso remarcar"
// (vai para a IA como mensagem normal).
// Só roda para salões com settings.lembrete_vespera = true.
import { db, audit } from "./db.js";
import { sendTemplate } from "./whatsapp.js";
import { localToUtc, parseRange, toRange, utcToLocal } from "./time.js";

export const REMINDER_TEMPLATE = process.env.REMINDER_TEMPLATE ?? "lembrete_vespera";
const REMINDER_LANG = process.env.REMINDER_TEMPLATE_LANG ?? "pt_BR";
const FIRST_HOUR = 9, LAST_HOUR = 20; // só manda em horário comercial do salão

const failedToday = new Map<string, string>(); // appointmentId -> data local da falha (não insiste no mesmo dia)

function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function reminderText(nome: string, servico: string, dia: string, hora: string) {
  return `Olá, ${nome}! Passando para lembrar do seu horário de ${servico} amanhã, ${dia}, às ${hora}. Podemos confirmar?`;
}

export async function runReminders(): Promise<void> {
  const { data: tenants, error } = await db.from("tenants").select("id, name, timezone, settings");
  if (error) return console.error("lembretes: tenants", error.message);
  for (const t of tenants ?? []) {
    if (t.settings?.lembrete_vespera !== true) continue;
    try { await remindTenant(t); } catch (e) { console.error("lembretes", t.id, e); }
  }
}

async function remindTenant(t: { id: string; name: string; timezone: string }) {
  const now = utcToLocal(new Date(), t.timezone);
  const hour = Number(now.time.slice(0, 2));
  if (hour < FIRST_HOUR || hour >= LAST_HOUR) return;

  const tomorrow = addDays(now.date, 1);
  const from = localToUtc(tomorrow, "00:00", t.timezone), to = localToUtc(addDays(tomorrow, 1), "00:00", t.timezone);

  const { data: num } = await db.from("wa_numbers").select("id, phone_number_id").eq("tenant_id", t.id).order("created_at").limit(1).maybeSingle();
  if (!num) return;

  const { data: aps, error } = await db.from("appointments")
    .select("id, period, client_id, clients(full_name, phone_e164), services(name)")
    .eq("tenant_id", t.id).eq("status", "scheduled").is("reminder_sent_at", null)
    .overlaps("period", toRange(from, to));
  if (error) throw error;

  for (const a of (aps ?? []) as any[]) {
    if (failedToday.get(a.id) === now.date) continue;
    const start = parseRange(a.period).start;
    if (start < from || start >= to) continue;

    // só para quem autorizou mensagens de serviço
    const { data: consent } = await db.from("consents").select("granted")
      .eq("tenant_id", t.id).eq("client_id", a.client_id).eq("purpose", "service_messages")
      .order("recorded_at", { ascending: false }).limit(1).maybeSingle();
    if (consent && consent.granted === false) continue;

    const nome = (a.clients?.full_name || "").split(" ")[0] || "tudo bem";
    const servico = a.services?.name || "atendimento";
    const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: t.timezone, weekday: "long", day: "2-digit", month: "2-digit" }).format(start);
    const hora = utcToLocal(start, t.timezone).time;

    try {
      const waId = await sendTemplate(num.phone_number_id, a.clients.phone_e164, REMINDER_TEMPLATE, REMINDER_LANG,
        [nome, servico, dia, hora], [`confirmar:${a.id}`, `remarcar:${a.id}`]);
      await db.from("appointments").update({ reminder_sent_at: new Date().toISOString() }).eq("id", a.id);

      const { data: conv } = await db.from("conversations")
        .upsert({ tenant_id: t.id, client_id: a.client_id, wa_number_id: num.id }, { onConflict: "wa_number_id,client_id", ignoreDuplicates: false })
        .select("id").single();
      if (conv) {
        await db.from("messages").insert({
          tenant_id: t.id, conversation_id: conv.id, direction: "outbound", author: "system",
          wa_message_id: waId, body: reminderText(nome, servico, dia, hora) + " [botões: Confirmar | Preciso remarcar]", status: "sent",
        });
        await db.from("conversations").update({ last_outbound_at: new Date().toISOString() }).eq("id", conv.id);
      }
      await audit(t.id, "system", "appointment.reminder_sent", "appointments", a.id);
    } catch (e: any) {
      failedToday.set(a.id, now.date);
      console.error("lembrete falhou", a.id, e?.message ?? e);
      await audit(t.id, "system", "appointment.reminder_failed", "appointments", a.id, { erro: String(e?.message ?? e).slice(0, 500) });
    }
  }
}

export function startReminders() {
  const every = Number(process.env.REMINDER_INTERVAL_MS ?? 10 * 60_000);
  setTimeout(() => runReminders().catch((e) => console.error("lembretes", e)), 30_000);
  setInterval(() => runReminders().catch((e) => console.error("lembretes", e)), every);
}
