import { createServer, type IncomingMessage } from "node:http";
import { config } from "./config.js";
import { validSignature } from "./whatsapp.js";
import { handleWebhook } from "./inbound.js";
import { pendingJobs } from "./queue.js";
import { privacyHtml } from "./pages/privacidade.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { staffReply, HttpError } from "./staff.js";
import { startReminders } from "./reminders.js";
import { startFeedback } from "./feedback.js";

// Painel do gestor: página estática; os dados vêm da Supabase com login e RLS
const painelHtml = readFileSync(new URL("../public/painel.html", import.meta.url), "utf8");
const supabaseUmd = readFileSync(new URL("../node_modules/@supabase/supabase-js/dist/umd/supabase.js", import.meta.url));

// Portal K.IA.RA (entrada, monitor e música): arquivos estáticos carregados uma vez na memória
const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg",
};
const kiaraDir = fileURLToPath(new URL("../public/kiara/", import.meta.url));
const kiaraFiles = new Map<string, Buffer>();
(function carregar(dir: string, prefixo: string) {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) carregar(caminho, `${prefixo}${nome}/`);
    else if (TIPOS[extname(nome)]) kiaraFiles.set(`${prefixo}${nome}`, readFileSync(caminho));
  }
})(kiaraDir, "");
const KIARA_PAGINAS: Record<string, string> = {
  "/": "index.html", "/kiara": "index.html", "/kiara/": "index.html",
  "/kiara/monitor": "monitor.html", "/kiara/musica": "musica.html",
};

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload grande demais")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: pendingJobs() }));
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const pagina = KIARA_PAGINAS[url.pathname];
      const arquivo = pagina ?? (url.pathname.startsWith("/kiara/") ? url.pathname.slice(7) : null);
      const dados = arquivo ? kiaraFiles.get(arquivo) : undefined;
      if (dados && arquivo) {
        res.writeHead(200, {
          "Content-Type": TIPOS[extname(arquivo)],
          "Content-Length": dados.length,
          "Cache-Control": pagina || arquivo.endsWith(".js") ? "no-cache" : "public, max-age=604800",
          "Referrer-Policy": "same-origin",
        });
        res.end(req.method === "HEAD" ? undefined : dados);
        return;
      }
    }

    if (req.method === "GET" && (url.pathname === "/privacidade" || url.pathname === "/exclusao-de-dados")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(privacyHtml);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/painel" || url.pathname === "/painel/")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
      });
      res.end(painelHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === "/painel/supabase.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(supabaseUmd);
      return;
    }

    // Verificação do webhook pela Meta (feita uma vez no cadastro)
    if (req.method === "GET" && url.pathname === "/webhooks/whatsapp") {
      const ok = url.searchParams.get("hub.mode") === "subscribe"
        && url.searchParams.get("hub.verify_token") === config.waVerifyToken;
      res.writeHead(ok ? 200 : 403, { "Content-Type": "text/plain" });
      res.end(ok ? url.searchParams.get("hub.challenge") ?? "" : "forbidden");
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/whatsapp") {
      const raw = await readBody(req);
      if (!validSignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
        console.warn("webhook recusado: assinatura inválida (confira WHATSAPP_APP_SECRET)");
        res.writeHead(401).end();
        return;
      }
      // Responde 200 já; a Meta reenvia se demorar
      res.writeHead(200).end();
      console.log(`webhook recebido (${raw.length} bytes)`);
      let payload: unknown;
      try { payload = JSON.parse(raw.toString("utf8")); } catch { return; }
      handleWebhook(payload).catch((e) => console.error("webhook", e));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/conversas/responder") {
      let body: unknown;
      try { body = JSON.parse((await readBody(req, 50_000)).toString("utf8")); } catch { body = null; }
      try {
        const out = await staffReply(req.headers.authorization, body);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 502;
        if (!(e instanceof HttpError)) console.error("responder", e);
        res.writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify({ erro: e instanceof HttpError ? e.message : "O WhatsApp recusou o envio. Tente de novo em instantes." }));
      }
      return;
    }

    res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(config.port, () => console.log(`Terrasso.AI ouvindo na porta ${config.port}`));
startReminders();
startFeedback();
