import { db, audit } from "./db.js";
import { config } from "./config.js";
import { reply, type Turn } from "./receptionist.js";
import { markReadTyping, sendText } from "./whatsapp.js";

export async function processConversation(conversationId: string, phoneNumberId: string, lastWaMessageId: string) {
  const { data: conv, error } = await db.from("conversations")
    .select("id, tenant_id, client_id, assigned_user_id, ai_paused, last_inbound_at, clients(full_name, phone_e164), tenants(name, timezone, settings, ai_enabled)")
    .eq("id", conversationId).single();
  if (error) throw error;
  const c: any = conv;

  // Humano assumiu, IA pausada nesta conversa ou Kiara desligada no salão: silêncio total
  if (c.assigned_user_id || c.ai_paused || c.tenants.ai_enabled === false) return;

  // Janela de 24h: texto livre só se o cliente escreveu nas últimas 24h
  if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > 23.5 * 3600_000) return;

  await markReadTyping(phoneNumberId, lastWaMessageId);

  const { data: rows } = await db.from("messages")
    .select("direction, author, body, created_at")
    .eq("tenant_id", c.tenant_id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(config.historyLimit);
  const history: Turn[] = (rows ?? []).reverse()
    .filter((m: any) => m.body)
    .map((m: any) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      text: m.author === "staff" ? `[equipe] ${m.body}` : m.body,
    }));

  const { data: unit } = await db.from("units").select("id, name, address")
    .eq("tenant_id", c.tenant_id).order("created_at").limit(1).maybeSingle();

  const result = await reply(
    { tenantId: c.tenant_id, timeZone: c.tenants.timezone, clientId: c.client_id, conversationId, unitId: unit?.id ?? null },
    { name: c.tenants.name, timeZone: c.tenants.timezone, settings: c.tenants.settings, unitName: unit?.name, unitAddress: unit?.address },
    c.clients.full_name,
    history,
  );
  if (!result.text) return;

  // Alguém da equipe pode ter assumido enquanto a IA pensava
  const { data: again } = await db.from("conversations").select("assigned_user_id, ai_paused, tenants(ai_enabled)")
    .eq("id", conversationId).single();
  const ag: any = again;
  if (ag?.assigned_user_id || ag?.ai_paused || ag?.tenants?.ai_enabled === false) return;

  const waId = await sendText(phoneNumberId, c.clients.phone_e164, result.text);
  await db.from("messages").insert({
    tenant_id: c.tenant_id,
    conversation_id: conversationId,
    direction: "outbound",
    author: "ai",
    wa_message_id: waId,
    body: result.text,
    status: "sent",
  });
  await db.from("conversations").update({ last_outbound_at: new Date().toISOString() }).eq("id", conversationId);
  if (result.handedOff) {
    await audit(c.tenant_id, "ai", "conversation.handoff_notified", "conversations", conversationId);
  }
}
