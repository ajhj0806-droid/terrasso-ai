# Terrasso.AI

Sistema de gestão para salões e clínicas de estética com recepcionista IA no WhatsApp.
Começa na Terrasso e foi desenhado para vários salões (multi-tenant) desde o início.

Plano: https://claude.ai/artifact/PaDontgQbPwKZw1LxyQWHD

## Stack

- **Supabase**: Postgres com RLS por `tenant_id`, Auth da equipe, Realtime, Storage
- **Render**: API e webhook do WhatsApp, worker da IA, cron jobs, painel (PWA)
- **WhatsApp Cloud API** (Meta)

## Banco

As migrações ficam em `supabase/migrations/`. Regras principais:

- Toda tabela de negócio tem `tenant_id` e política RLS: a equipe só vê o próprio salão.
- `appointments` tem uma restrição de exclusão: o banco recusa dois atendimentos
  sobrepostos do mesmo profissional (cancelados e faltas não contam).
- Mensagens do WhatsApp são idempotentes por `wa_message_id`.
- O servidor escreve com a chave `service_role`; o painel usa a chave pública + login.

## Servidor (`server/`)

Node 22 + TypeScript, sem framework. Recebe o webhook do WhatsApp, grava tudo na Supabase e responde com a recepcionista IA (Claude).

- `GET /webhooks/whatsapp`: verificação da Meta (`WHATSAPP_VERIFY_TOKEN`).
- `POST /webhooks/whatsapp`: confere a assinatura `X-Hub-Signature-256`, responde 200 na hora e processa em seguida. Reentregas são ignoradas pelo `wa_message_id`.
- Mensagens picadas do mesmo cliente são juntadas (espera de 2,5 s) e cada conversa é respondida uma de cada vez.
- A IA fica em silêncio quando alguém da equipe assume (`assigned_user_id`) ou quando ela mesma pede ajuda (`ai_paused`).
- Ferramentas da IA: listar serviços, buscar horários, agendar, remarcar, cancelar, salvar nome e chamar atendente. Toda ação vai para o `audit_log`. Conflito de horário é barrado pelo próprio banco.

```bash
cd server
npm ci
npm test        # testes de fuso horário e cálculo de vagas
npm run build && npm start
```

Variáveis de ambiente: ver `render.yaml`. Segredos ficam só no painel do Render.
