// Rotas usadas pelo painel com o login da equipe (token da Supabase no cabeçalho).
import { db, audit } from "./db.js";
import { sendText, setWhatsAppBlock } from "./whatsapp.js";

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Confere o token do painel e devolve o usuário. */
async function staffUser(authHeader: string | undefined) {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new HttpError(401, "Faça login de novo.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Sessão expirada. Faça login de novo.");
  return data.user;
}

/** A equipe responde a cliente pelo painel. A conversa fica com quem respondeu (a Kiara para de responder nela). */
export async function staffReply(authHeader: string | undefined, body: any) {
  const user = await staffUser(authHeader);
  const conversationId = String(body?.conversation_id ?? "");
  const text = String(body?.text ?? "").trim();
  if (!conversationId || !text) throw new HttpError(400, "Escreva a mensagem.");
  if (text.length > 4000) throw new HttpError(400, "Mensagem longa demais.");

  const { data: conv } = await db.from("conversations")
    .select("id, tenant_id, last_inbound_at, clients(phone_e164, blocked_at), wa_numbers(phone_number_id)")
    .eq("id", conversationId).maybeSingle();
  const c: any = conv;
  if (!c) throw new HttpError(404, "Conversa não encontrada.");

  const { data: staff } = await db.from("staff_members").select("full_name")
    .eq("tenant_id", c.tenant_id).eq("user_id", user.id).eq("active", true).maybeSingle();
  if (!staff) throw new HttpError(403, "Sem acesso a este salão.");

  if (c.clients?.blocked_at) throw new HttpError(409, "Este número está bloqueado. Desbloqueie para responder.");
  if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > 24 * 3600_000) {
    throw new HttpError(409, "Já passaram 24 horas desde a última mensagem da cliente. O WhatsApp só deixa responder depois que ela escrever de novo.");
  }

  const waId = await sendText(c.wa_numbers.phone_number_id, c.clients.phone_e164, text);
  const now = new Date().toISOString();
  await db.from("messages").insert({
    tenant_id: c.tenant_id, conversation_id: c.id, direction: "outbound", author: "staff",
    author_user_id: user.id, wa_message_id: waId, body: text, status: "sent",
  });
  await db.from("conversations").update({ assigned_user_id: user.id, ai_paused: true, last_outbound_at: now }).eq("id", c.id);
  await audit(c.tenant_id, "staff", "conversation.staff_reply", "conversations", c.id, { user: user.id });
  return { ok: true };
}

/** Excluir a conversa (só administrador) ou bloquear/desbloquear o número (administrador e recepção). */
export async function staffConversationAction(authHeader: string | undefined, body: any) {
  const user = await staffUser(authHeader);
  const conversationId = String(body?.conversation_id ?? "");
  const acao = String(body?.acao ?? "");
  if (!conversationId || !["excluir", "bloquear", "desbloquear"].includes(acao)) throw new HttpError(400, "Pedido inválido.");

  const { data: conv } = await db.from("conversations")
    .select("id, tenant_id, client_id, clients(phone_e164, blocked_at), wa_numbers(phone_number_id)")
    .eq("id", conversationId).maybeSingle();
  const c: any = conv;
  if (!c) throw new HttpError(404, "Conversa não encontrada.");

  const { data: staff } = await db.from("staff_members").select("role")
    .eq("tenant_id", c.tenant_id).eq("user_id", user.id).eq("active", true).maybeSingle();
  if (!staff) throw new HttpError(403, "Sem acesso a este salão.");
  const admin = ["owner", "manager"].includes(staff.role);
  if (acao === "excluir" && !admin) throw new HttpError(403, "Só o administrador pode excluir conversas.");
  if (acao !== "excluir" && !admin && staff.role !== "reception") throw new HttpError(403, "Sem permissão para bloquear.");

  if (acao === "excluir") {
    const { error } = await db.from("conversations").delete().eq("id", c.id).eq("tenant_id", c.tenant_id);
    if (error) throw error;
    await audit(c.tenant_id, "staff", "conversation.delete", "conversations", c.id, { user: user.id, client: c.client_id });
    return { ok: true };
  }

  const bloquear = acao === "bloquear";
  const { error } = await db.from("clients")
    .update(bloquear ? { blocked_at: new Date().toISOString(), blocked_by: user.id } : { blocked_at: null, blocked_by: null })
    .eq("id", c.client_id).eq("tenant_id", c.tenant_id);
  if (error) throw error;
  if (bloquear) await db.from("conversations").update({ ai_paused: true }).eq("id", c.id);
  // No WhatsApp também (a Meta só bloqueia quem escreveu nas últimas 24 h); se não der, o bloqueio no sistema continua valendo.
  let whatsapp = true;
  try { await setWhatsAppBlock(c.wa_numbers.phone_number_id, c.clients.phone_e164, bloquear); }
  catch (e: any) { whatsapp = false; console.warn("block_users", e?.message ?? e); }
  await audit(c.tenant_id, "staff", bloquear ? "client.block" : "client.unblock", "clients", c.client_id, { user: user.id, whatsapp });
  return { ok: true, whatsapp };
}
