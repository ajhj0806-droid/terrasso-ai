-- Vários caixas por dia (Caixa 1, Caixa 2...). Só o administrador abre e fecha os caixas e escolhe o
-- responsável de cada um; fica gravado o login de quem abriu e fechou, com data e horário.
-- O pagamento recebido na comanda fica ligado ao caixa aberto do responsável que recebeu.
-- Pode ser rodado mais de uma vez sem problema.

create table if not exists public.cash_registers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  name                  text not null,
  business_date         date not null,
  opening_cents         integer not null default 0 check (opening_cents >= 0),
  opened_by             uuid not null default auth.uid() references auth.users(id),
  opened_by_name        text,
  opened_at             timestamptz not null default now(),
  closed_at             timestamptz,
  closed_by             uuid references auth.users(id),
  closed_by_name        text,
  closing_counted_cents integer check (closing_counted_cents >= 0),
  notes                 text,
  unique (tenant_id, business_date, name)
);
alter table public.cash_registers add column if not exists responsible_id uuid references auth.users(id);
alter table public.cash_registers add column if not exists responsible_name text;
create index if not exists cash_registers_tenant_date_idx on public.cash_registers (tenant_id, business_date);
alter table public.cash_registers enable row level security;

drop policy if exists cash_registers_read on public.cash_registers;
drop policy if exists cash_registers_insert on public.cash_registers;
drop policy if exists cash_registers_update on public.cash_registers;
drop policy if exists cash_registers_delete on public.cash_registers;
-- recepção só enxerga (para saber em qual caixa está); abrir, fechar e apagar é só do administrador
create policy cash_registers_read on public.cash_registers for select using (private.is_desk(tenant_id));
create policy cash_registers_insert on public.cash_registers for insert with check (private.is_admin(tenant_id) and opened_by = auth.uid());
create policy cash_registers_update on public.cash_registers for update using (private.is_admin(tenant_id)) with check (private.is_admin(tenant_id));
create policy cash_registers_delete on public.cash_registers for delete using (private.is_admin(tenant_id));
grant select, insert, update, delete on public.cash_registers to authenticated;
revoke all on public.cash_registers from anon;

alter table public.payments add column if not exists cash_register_id uuid references public.cash_registers(id) on delete set null;
create index if not exists payments_cash_register_idx on public.payments (cash_register_id);
