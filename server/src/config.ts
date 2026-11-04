// Configuração lida do ambiente (Render). Nada de segredo no código.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  // Token de acesso do usuário de sistema da Meta (WhatsApp Cloud API)
  waAccessToken: required("WHATSAPP_ACCESS_TOKEN"),
  // App secret do app da Meta: valida a assinatura X-Hub-Signature-256
  waAppSecret: required("WHATSAPP_APP_SECRET"),
  // Texto livre que você escolhe e repete no painel da Meta ao cadastrar o webhook
  waVerifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  anthropicEffort: (process.env.ANTHROPIC_EFFORT ?? "low") as "low" | "medium" | "high",
  // Quantas mensagens anteriores a IA lê para ter contexto
  historyLimit: Number(process.env.AI_HISTORY_LIMIT ?? 20),
};
