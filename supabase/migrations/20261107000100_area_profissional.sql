-- Área do Profissional: comissão paga e fluxo de caixa pessoal.
-- Não remove nada: só acrescenta uma coluna, uma tabela e regras de acesso.

-- ---------- Comissão paga ----------
-- Quando o administrador paga a comissão, o item ganha a data do pagamento.
-- No fluxo do profissional, a comissão paga entra uma única vez, como recebida nessa data.
alter table public.comanda_items add column commission_paid_at timestamptz;
create index comanda_items_prof_paid on public.comanda_items (professional_id, commission_paid_at);

create function private.comanda_items_paid_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_admin(new.tenant_id)
     and new.commission_paid_at is distinct from (case when tg_op = 'UPDATE' then old.commission_paid_at end) then
    raise exception 'Só o administrador marca a comissão como paga.';
  end if;
  return new;
end $$;
create trigger comanda_items_paid_guard before insert or update on public.comanda_items
  for each row execute function private.comanda_items_paid_guard();

-- ---------- Fluxo pessoal do profissional ----------
-- Outras receitas e despesas lançadas pelo próprio profissional, realizadas ou previstas.
-- Só o próprio profissional vê e altera (nem o administrador vê as finanças pessoais).
create table public.pro_ledger (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  professional_id  uuid not null references public.professionals(id) on delete cascade,
  kind             text not null check (kind in ('receita', 'despesa')),
  description      text not null check (length(trim(description)) between 1 and 120),
  amount_cents     integer not null check (amount_cents > 0),
  due_date         date not null,
  status           text not null default 'realizado' check (status in ('previsto', 'realizado')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index pro_ledger_prof_date on public.pro_ledger (professional_id, due_date);
alter table public.pro_ledger enable row level security;
create policy pro_ledger_own on public.pro_ledger for all to authenticated
  using (professional_id in (select private.my_professional_ids()))
  with check (professional_id in (select private.my_professional_ids())
              and tenant_id in (select private.my_tenant_ids()));

create function private.pro_ledger_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger pro_ledger_touch before update on public.pro_ledger
  for each row execute function private.pro_ledger_touch();
