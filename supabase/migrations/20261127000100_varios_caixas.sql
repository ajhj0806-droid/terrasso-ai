-- Vários caixas por dia (Caixa 1, Caixa 2...), cada um aberto por um login, com data e horário de abertura e fechamento.
-- O pagamento recebido na comanda fica ligado ao caixa aberto de quem recebeu. Tudo aditivo.

create table public.cash_registers (
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
create index on public.cash_registers (tenant_id, business_date);
alter table public.cash_registers enable row level security;
-- recepção e administrador veem e abrem caixas; cada um abre no próprio login
create policy cash_registers_read on public.cash_registers for select using (private.is_desk(tenant_id));
create policy cash_registers_insert on public.cash_registers for insert with check (private.is_desk(tenant_id) and opened_by = auth.uid());
-- fecha quem abriu; o administrador pode fechar ou corrigir qualquer um
create policy cash_registers_update on public.cash_registers for update
  using (private.is_admin(tenant_id) or (private.is_desk(tenant_id) and opened_by = auth.uid()))
  with check (private.is_admin(tenant_id) or (private.is_desk(tenant_id) and opened_by = auth.uid()));
create policy cash_registers_delete on public.cash_registers for delete using (private.is_admin(tenant_id));
grant select, insert, update, delete on public.cash_registers to authenticated;
revoke all on public.cash_registers from anon;

alter table public.payments add column cash_register_id uuid references public.cash_registers(id) on delete set null;
create index on public.payments (cash_register_id);
