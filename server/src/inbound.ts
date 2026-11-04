// Recebe o payload do webhook da Meta, grava no banco de forma idempotente
// e agenda a resposta da IA.
import { db, audit } from "./db.js";
import { schedule } from "./queue.js";
import { processConversation } from "./worker.js";

interface WaNumber { id: string; tenant_id: string; phone_number_id: string }
const numberCache = new Map<string, WaNumber | null>();

async function findNumber(phoneNumberId: string): Promise<WaNumber | null> {
  if (numberCache.has(phoneNumberId)) return numberCache.get(phoneNumberId)!;
  const { data } = await db.from("wa_numbers").select("id, tenant_id, phone_number_id")
    .eq("phone_number_id", phoneNumberId).maybeSingle();
  numberCache.set(phoneNumberId, data ?? null);
  return data ?? null;
}

function describe(msg: any): string {
  switch (msg.type) {
    case "text": return msg.text?.body ?? "";
    case "button": return msg.button?.text ?? "[botão]";
    case "interactive":
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? "[resposta interativa]";
    case "reaction": return `[reagiu com ${msg.reaction?.emoji ?? "emoji"}]`;
    case "audio": return "[o cliente mandou um áudio, que você não consegue ouvir]";
    case "image": return `[o cliente mandou uma foto${msg.image?.caption ? `: ${msg.image.caption}` : ""}]`;
    case "document": return "[o cliente mandou um documento]";
    case "location": return "[o cliente mandou uma localização]";
    case "sticker": return "[figurinha]";
    default: return `[mensagem do tipo ${msg.type}]`;
  }
}

async function upsertClient(tenantId: string, phoneE164: string, profileName: string | undefined) {
  const { data: existing } = await db.from("clients").select("id, full_name")
    .eq("tenant_id", tenantId).eq("phone_e164", phoneE164).maybeSingle();
  if (existing) return existing.id as string;

  const { data, error } = await db.from("clients")
    .upsert({ tenant_id: tenantId, phone_e164: phoneE164, full_name: profileName ?? null },
      { onConflict: "tenant_id,phone_e164" })
    .select("id").single();
  if (error) throw error;
  // Quem escreve primeiro autoriza mensagens de serviço (confirmações, lembretes).
  // Marketing exige opt-in separado.
  await db.from("consents").insert({
    tenant_id: tenantId, client_id: data.id, purpose: "service_messages", granted: true, source: "whatsapp_inbound",
  });
  await audit(tenantId, "system", "client.create", "clients", data.id, { via: "whatsapp" });
  return data.id as string;
}

export async function handleWebhook(payload: any): Promise<void> {
  if (payload?.object !== "whatsapp_business_account") return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const number = await findNumber(value.metadata?.phone_number_id);
      if (!number) {
        console.warn("phone_number_id sem salão cadastrado:", value.metadata?.phone_number_id);
        continue;
      }

      for (const st of value.statuses ?? []) {
        await db.from("messages").update({ status: st.status })
          .eq("tenant_id", number.tenant_id).eq("wa_message_id", st.id);
      }

      for (const msg of value.messages ?? []) {
        try {
          await handleMessage(number, value.contacts ?? [], msg);
        } catch (e) {
          console.error("falha ao gravar mensagem", msg?.id, e);
        }
      }
    }
  }
}

async function handleMessage(number: WaNumber, contacts: any[], msg: any) {
  const phone = `+${msg.from}`;
  const profileName = contacts.find((c) => c.wa_id === msg.from)?.profile?.name;
  const clientId = await upsertClient(number.tenant_id, phone, profileName);

  const { data: conv, error: convErr } = await db.from("conversations")
    .upsert({ tenant_id: number.tenant_id, client_id: clientId, wa_number_id: number.id },
      { onConflict: "wa_number_id,client_id", ignoreDuplicates: false })
    .select("id").single();
  if (convErr) throw convErr;

  const sentAt = new Date(Number(msg.timestamp) * 1000).toISOString();
  const { data: inserted, error } = await db.from("messages")
    .upsert({
      tenant_id: number.tenant_id,
      conversation_id: conv.id,
      direction: "inbound",
      author: "client",
      wa_message_id: msg.id,
      body: describe(msg),
      payload: msg,
      created_at: sentAt,
    }, { onConflict: "wa_message_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw error;
  if (!inserted || inserted.length === 0) return; // reentrega da Meta: já processada

  await db.from("conversations").update({ last_inbound_at: sentAt })
    .eq("tenant_id", number.tenant_id).eq("id", conv.id);

  // Espera o cliente terminar de digitar (várias mensagens curtas viram uma resposta só)
  schedule(conv.id, () => processConversation(conv.id, number.phone_number_id, msg.id));
}
