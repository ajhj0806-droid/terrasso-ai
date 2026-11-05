import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** Confere a assinatura que a Meta envia em X-Hub-Signature-256. */
export function validSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.waAppSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice(7), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function graph(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.waAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Graph API ${res.status}: ${JSON.stringify(json?.error ?? json)}`);
  }
  return json;
}

/** Envia texto livre. Só funciona dentro da janela de 24h após a última mensagem do cliente. */
export async function sendText(phoneNumberId: string, toE164: string, text: string): Promise<string | null> {
  const json = await graph(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164.replace(/^\+/, ""),
    type: "text",
    text: { preview_url: false, body: text },
  });
  return json?.messages?.[0]?.id ?? null;
}

/** Envia um modelo aprovado pela Meta (funciona fora da janela de 24h). */
export async function sendTemplate(
  phoneNumberId: string, toE164: string, name: string, language: string,
  bodyParams: string[], buttonPayloads: string[] = [],
): Promise<string | null> {
  const components: any[] = [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }];
  buttonPayloads.forEach((payload, index) => components.push({
    type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }],
  }));
  const json = await graph(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to: toE164.replace(/^\+/, ""),
    type: "template",
    template: { name, language: { code: language }, components },
  });
  return json?.messages?.[0]?.id ?? null;
}

/** Marca como lida e mostra "digitando..." enquanto a IA pensa. */
export async function markReadTyping(phoneNumberId: string, waMessageId: string): Promise<void> {
  await graph(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: waMessageId,
    typing_indicator: { type: "text" },
  }).catch((e) => console.warn("markRead", e.message));
}
