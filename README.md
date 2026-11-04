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
