import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { toolDefs, runTool, type Ctx } from "./tools.js";
import { formatBr } from "./time.js";

const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

type Msg = Anthropic.Beta.Messages.BetaMessageParam;

export interface Turn { role: "user" | "assistant"; text: string }

export interface TenantInfo {
  name: string;
  timeZone: string;
  settings: Record<string, any>;
  unitName?: string | null;
  unitAddress?: string | null;
}

/** Parte estável do prompt (fica em cache entre conversas do mesmo salão). */
function stableSystem(t: TenantInfo): string {
  const s = t.settings ?? {};
  return [
    `Você é ${s.nome_assistente ? `${s.nome_assistente}, ` : ""}a recepcionista virtual do ${t.name}, um salão de beleza e clínica de estética, atendendo clientes pelo WhatsApp.`,
    t.unitAddress ? `Endereço: ${t.unitAddress}${t.unitName ? ` (${t.unitName})` : ""}.` : "",
    s.tom_de_voz ? `Tom de voz: ${s.tom_de_voz}` : "Tom: acolhedor, simpático e direto, em português do Brasil. Mensagens curtas, como numa conversa de WhatsApp. No máximo um emoji por mensagem.",
    s.politicas ? `Políticas do salão:\n${s.politicas}` : "",
    s.faq ? `Informações e perguntas frequentes (use só o que estiver aqui; se não souber, diga que vai confirmar com a equipe):\n${s.faq}` : "",
    s.diferenciais ? `Diferenciais do salão (cite com naturalidade quando ajudar, sem exagerar):\n${s.diferenciais}` : "",
    "",
    "O que você faz: tira dúvidas sobre serviços e preços, agenda, remarca e cancela horários, e passa para uma pessoa da equipe quando precisa.",
    "",
    "Regras:",
    "- Preços, durações, profissionais e horários vêm SEMPRE das ferramentas. Nunca invente nem estime.",
    "- Antes de agendar, confirme com o cliente serviço, profissional, dia e hora numa frase só, e só chame `agendar` depois do 'sim'.",
    "- Ofereça no máximo 3 ou 4 horários por mensagem, não a lista inteira.",
    "- Se o cliente não disser o profissional, ofereça os horários de quem estiver livre.",
    "- Se ainda não souber o nome do cliente, pergunte de forma natural e guarde com `salvar_nome`.",
    "- Pedido que depende de aprovação (desconto, encaixe, condição especial): registre com `avisar_equipe`, diga que a equipe vai analisar e retornar, e CONTINUE atendendo. Nunca prometa o desconto.",
    "- Chame `chamar_atendente` (que te tira da conversa) só para: reclamação, dúvida de saúde, alergia ou contraindicação, gestante, pagamento, foto ou áudio que você não consegue ler, ou quando o cliente pedir para falar com uma pessoa. Depois avise que alguém da equipe responde em breve e pare.",
    "- Se perguntarem se você é humano, diga com simpatia que é a assistente virtual do salão e que uma pessoa da equipe pode atender se o cliente preferir.",
    "- Não dê orientação médica. Não fale de assuntos fora do salão.",
    "- Mensagens marcadas com [equipe] foram escritas por uma pessoa da equipe; mantenha coerência com elas.",
    "- Formatação do WhatsApp: *negrito* com um asterisco; nada de markdown com # ou tabelas.",
  ].filter(Boolean).join("\n");
}

function volatileSystem(t: TenantInfo, clientName: string | null): string {
  return [
    `Agora: ${formatBr(new Date(), t.timeZone)} (fuso ${t.timeZone}). Data de hoje em ISO: ${new Intl.DateTimeFormat("en-CA", { timeZone: t.timeZone }).format(new Date())}.`,
    clientName ? `Nome do cliente no cadastro: ${clientName}.` : "O cliente ainda não tem nome no cadastro.",
  ].join("\n");
}

/** Junta mensagens seguidas do mesmo lado e garante que começa e termina no cliente. */
function toMessages(history: Turn[]): Msg[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const h of history) {
    const last = out.at(-1);
    if (last && last.role === h.role) last.text += "\n" + h.text;
    else out.push({ ...h });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.map((m) => ({ role: m.role, content: m.text }));
}

export interface ReplyResult {
  text: string | null;   // null = não responder
  handedOff: boolean;
}

export async function reply(ctx: Ctx, tenant: TenantInfo, clientName: string | null, history: Turn[]): Promise<ReplyResult> {
  const messages = toMessages(history);
  if (messages.length === 0 || messages.at(-1)!.role !== "user") return { text: null, handedOff: false };

  const useFallbacks = config.anthropicModel.startsWith("claude-opus-5");
  let handedOff = false;

  for (let i = 0; i < 8; i++) {
    const response = await client.beta.messages.create({
      model: config.anthropicModel,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: config.anthropicEffort },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      system: [
        { type: "text", text: stableSystem(tenant), cache_control: { type: "ephemeral" } },
        { type: "text", text: volatileSystem(tenant, clientName) },
      ],
      tools: toolDefs,
      messages,
    });

    if (response.stop_reason === "refusal") {
      await runTool("chamar_atendente", { motivo: "IA recusou a mensagem" }, ctx);
      return { text: "Vou pedir para alguém da nossa equipe te responder por aqui, tá bom? Só um instante.", handedOff: true };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use",
    );

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content as any });
      continue;
    }

    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text).join("\n").trim();
      return { text: text || null, handedOff };
    }

    messages.push({ role: "assistant", content: response.content as any });
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let content: string;
      let isError = false;
      try {
        const r = await runTool(tu.name, tu.input, ctx);
        if (tu.name === "chamar_atendente" && r.ok) handedOff = true;
        isError = !r.ok;
        content = JSON.stringify(r);
      } catch (e: any) {
        console.error("tool", tu.name, e);
        isError = true;
        content = JSON.stringify({ ok: false, erro: "falha interna; peça desculpas e chame um atendente" });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  await runTool("chamar_atendente", { motivo: "IA não concluiu em 8 passos" }, ctx);
  return { text: "Deixa eu chamar alguém da equipe para te ajudar com isso, só um instante.", handedOff: true };
}
