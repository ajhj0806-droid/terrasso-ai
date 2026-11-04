import { createServer, type IncomingMessage } from "node:http";
import { config } from "./config.js";
import { validSignature } from "./whatsapp.js";
import { handleWebhook } from "./inbound.js";
import { pendingJobs } from "./queue.js";
import { privacyHtml } from "./pages/privacidade.js";

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

    if (req.method === "GET" && (url.pathname === "/privacidade" || url.pathname === "/exclusao-de-dados")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(privacyHtml);
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

    res.writeHead(404).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(config.port, () => console.log(`Terrasso.AI ouvindo na porta ${config.port}`));
