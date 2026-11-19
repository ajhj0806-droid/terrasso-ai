-- Bloquear número: a Kiara, os lembretes e a pesquisa de avaliação ignoram a cliente bloqueada.
-- Só acrescenta colunas; não remove nada.
alter table public.clients add column blocked_at timestamptz;
alter table public.clients add column blocked_by uuid references auth.users(id) on delete set null;
