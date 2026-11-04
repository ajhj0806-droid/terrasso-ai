-- Transbordo para humano: a IA pausa a conversa e a recepção vê o motivo.
alter table public.conversations
  add column ai_paused      boolean not null default false,
  add column handoff_reason text,
  add column handoff_at     timestamptz;

create index conversations_handoff on public.conversations (tenant_id, handoff_at)
  where ai_paused;

-- Consultas frequentes da recepcionista IA
create index work_schedules_pro_weekday on public.work_schedules (professional_id, weekday);
create index blocks_pro_period on public.blocks using gist (professional_id, period);
