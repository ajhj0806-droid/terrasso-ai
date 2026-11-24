-- Pacotes de serviços, créditos antecipados, fila do "profissional da vez", brindes,
-- produtos usados no procedimento e base para descontar a taxa do cartão da comissão.
-- Tudo aditivo (tabelas, colunas e funções novas).

alter type public.payment_method add value if not exists 'prepaid';  -- pago com saldo de crédito antecipado

-- ---------- Pacotes ----------
create table public.package_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  validity_days integer not null default 90 check (validity_days > 0),
  price_cents   integer not null check (price_cents >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table public.package_template_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  template_id uuid not null references public.package_templates(id) on delete cascade,
  service_id  uuid not null references public.services(id),
  quantity    integer not null check (quantity > 0)
);
create table public.client_packages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  template_id   uuid references public.package_templates(id) on delete set null,
  name          text not null,
  price_cents   integer not null check (price_cents >= 0),
  bought_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  comanda_id    uuid references public.comandas(id) on delete set null,
  notes         text,
  created_by    uuid references auth.users(id)
);
create table public.client_package_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  client_package_id uuid not null references public.client_packages(id) on delete cascade,
  service_id        uuid not null references public.services(id),
  quantity_total    integer not null check (quantity_total > 0),
  quantity_used     integer not null default 0,
  unit_value_cents  integer not null default 0 check (unit_value_cents >= 0),  -- parte do preço do pacote por sessão
  check (quantity_used between 0 and quantity_total)
);
create index on public.client_packages (tenant_id, client_id);
create index on public.client_package_items (client_package_id);

-- ---------- Comanda: uso de pacote, venda de pacote, brinde, produto usado, taxa do cartão ----------
alter table public.comanda_items
  add column client_package_item_id uuid references public.client_package_items(id),
  add column sold_package_id uuid references public.client_packages(id) on delete set null,
  add column is_gift boolean not null default false,
  add column product_use boolean not null default false,
  add column by_turn boolean not null default false,
  add column card_fee_cents integer not null default 0 check (card_fee_cents >= 0);
alter table public.payments add column comanda_item_id uuid references public.comanda_items(id) on delete cascade;

-- Usar sessão do pacote baixa o saldo; tirar o item devolve. Vender: remover o item cancela o pacote.
create function private.comanda_items_package() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.client_package_item_id is not null then
    update public.client_package_items set quantity_used = greatest(quantity_used - old.quantity::integer, 0)
     where id = old.client_package_item_id;
  end if;
  if tg_op = 'DELETE' and old.sold_package_id is not null then
    if exists (select 1 from public.client_package_items where client_package_id = old.sold_package_id and quantity_used > 0) then
      raise exception 'Este pacote já tem sessões usadas e não pode ser desfeito.';
    end if;
    update public.client_packages set status = 'cancelled' where id = old.sold_package_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.client_package_item_id is not null then
    select true into v_ok
      from public.client_package_items i
      join public.client_packages p on p.id = i.client_package_id
      join public.comandas c on c.id = new.comanda_id
     where i.id = new.client_package_item_id and p.status = 'active' and p.expires_at > now()
       and p.client_id = c.client_id and i.quantity_used + new.quantity::integer <= i.quantity_total
       for update of i;
    if v_ok is null then raise exception 'Pacote vencido, de outra cliente ou sem saldo para este serviço.'; end if;
    update public.client_package_items set quantity_used = quantity_used + new.quantity::integer
     where id = new.client_package_item_id;
  end if;
  return coalesce(new, old);
end $$;
create trigger comanda_items_package after insert or update of client_package_item_id, quantity or delete
  on public.comanda_items for each row execute function private.comanda_items_package();

-- ---------- Créditos antecipados (conta corrente da cliente) ----------
create table public.client_credits (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  amount_cents integer not null check (amount_cents <> 0),  -- + entrada, - uso
  kind         text not null check (kind in ('deposit', 'use', 'refund', 'adjust')),
  comanda_id   uuid references public.comandas(id) on delete set null,
  payment_id   uuid references public.payments(id) on delete cascade,
  notes        text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id)
);
create index on public.client_credits (tenant_id, client_id);

create view public.client_credit_balances with (security_invoker = true) as
  select tenant_id, client_id, sum(amount_cents)::bigint as balance_cents, max(created_at) as last_move
    from public.client_credits group by tenant_id, client_id;

-- Pagamento "Crédito antecipado" na comanda debita o saldo (e devolve se o pagamento for removido).
create function private.payments_prepaid() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_saldo bigint;
begin
  if new.method::text <> 'prepaid' then return new; end if;
  select client_id into v_client from public.comandas where id = new.comanda_id;
  if v_client is null then raise exception 'Comanda sem cliente não usa crédito.'; end if;
  perform pg_advisory_xact_lock(hashtext(v_client::text));
  select coalesce(sum(amount_cents), 0) into v_saldo from public.client_credits where client_id = v_client;
  if v_saldo < new.amount_cents then
    raise exception 'Saldo de crédito insuficiente (R$ %).', to_char(v_saldo / 100.0, 'FM999G990D00');
  end if;
  insert into public.client_credits (tenant_id, client_id, amount_cents, kind, comanda_id, payment_id, created_by)
    values (new.tenant_id, v_client, -new.amount_cents, 'use', new.comanda_id, new.id, auth.uid());
  return new;
end $$;
create trigger payments_prepaid after insert on public.payments for each row execute function private.payments_prepaid();

-- Receber crédito antecipado: gera uma comanda fechada (entra no caixa do dia) e lança a entrada no saldo.
create function public.receive_credit(p_client uuid, p_amount integer, p_method public.payment_method,
                                      p_installments smallint default 1, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_comanda uuid; v_pay uuid;
begin
  select tenant_id into v_tenant from public.clients where id = p_client;
  if v_tenant is null or not private.is_desk(v_tenant) then raise exception 'Sem permissão.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Informe o valor.'; end if;
  if p_method::text in ('prepaid', 'package') then raise exception 'Escolha como a cliente pagou.'; end if;
  insert into public.comandas (tenant_id, client_id, status, opened_by, closed_at, closed_by)
    values (v_tenant, p_client, 'closed', auth.uid(), now(), auth.uid()) returning id into v_comanda;
  insert into public.comanda_items (tenant_id, comanda_id, description, quantity, unit_price_cents)
    values (v_tenant, v_comanda, 'Crédito antecipado', 1, p_amount);
  insert into public.payments (tenant_id, comanda_id, method, amount_cents, installments, received_by)
    values (v_tenant, v_comanda, p_method, p_amount, coalesce(p_installments, 1), auth.uid()) returning id into v_pay;
  insert into public.client_credits (tenant_id, client_id, amount_cents, kind, comanda_id, notes, created_by)
    values (v_tenant, p_client, p_amount, 'deposit', v_comanda, p_notes, auth.uid());
  return v_comanda;
end $$;

-- Ajuste ou devolução de saldo (só administrador).
create function public.adjust_credit(p_client uuid, p_amount integer, p_kind text, p_notes text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_saldo bigint;
begin
  select tenant_id into v_tenant from public.clients where id = p_client;
  if v_tenant is null or not private.is_admin(v_tenant) then raise exception 'Só o administrador ajusta saldo.'; end if;
  if p_kind not in ('refund', 'adjust') or coalesce(p_amount, 0) = 0 then raise exception 'Ajuste inválido.'; end if;
  perform pg_advisory_xact_lock(hashtext(p_client::text));
  select coalesce(sum(amount_cents), 0) into v_saldo from public.client_credits where client_id = p_client;
  if v_saldo + p_amount < 0 then raise exception 'O saldo não pode ficar negativo.'; end if;
  insert into public.client_credits (tenant_id, client_id, amount_cents, kind, notes, created_by)
    values (v_tenant, p_client, p_amount, p_kind, p_notes, auth.uid());
end $$;

-- ---------- Fila do profissional da vez ----------
alter table public.professionals add column last_turn_at timestamptz, add column in_turn_queue boolean not null default true;

-- Escolhe o próximo da fila para o serviço: ativo, na fila, que faz o serviço, trabalhando agora e livre;
-- quem atendeu "da vez" há mais tempo vem primeiro. Marca a vez dele.
create function public.take_turn(p_tenant uuid, p_service uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_agora timestamp; v_prof uuid;
begin
  if not private.is_desk(p_tenant) then raise exception 'Sem permissão.'; end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_agora := now() at time zone coalesce(v_tz, 'America/Sao_Paulo');
  perform pg_advisory_xact_lock(hashtext('vez' || p_tenant::text));
  select p.id into v_prof
    from public.professionals p
   where p.tenant_id = p_tenant and p.active and p.in_turn_queue
     and (p_service is null
          or not exists (select 1 from public.professional_services x where x.service_id = p_service)
          or exists (select 1 from public.professional_services x where x.service_id = p_service and x.professional_id = p.id))
   order by
     (exists (select 1 from public.work_schedules w where w.professional_id = p.id
               and w.weekday = extract(dow from v_agora) and v_agora::time >= w.start_time and v_agora::time < w.end_time)) desc,
     (exists (select 1 from public.appointments a where a.professional_id = p.id
               and a.status in ('checked_in', 'in_service') and a.period @> now())) asc,
     p.last_turn_at asc nulls first, p.name
   limit 1;
  if v_prof is not null then update public.professionals set last_turn_at = now() where id = v_prof; end if;
  return v_prof;
end $$;

-- ---------- Permissões ----------
alter table public.package_templates      enable row level security;
alter table public.package_template_items enable row level security;
alter table public.client_packages        enable row level security;
alter table public.client_package_items   enable row level security;
alter table public.client_credits         enable row level security;
create policy package_templates_admin on public.package_templates for all using (private.is_admin(tenant_id)) with check (private.is_admin(tenant_id));
create policy package_templates_read on public.package_templates for select using (private.is_desk(tenant_id));
create policy package_template_items_admin on public.package_template_items for all using (private.is_admin(tenant_id)) with check (private.is_admin(tenant_id));
create policy package_template_items_read on public.package_template_items for select using (private.is_desk(tenant_id));
create policy client_packages_desk on public.client_packages for all using (private.is_desk(tenant_id)) with check (private.is_desk(tenant_id));
create policy client_package_items_desk on public.client_package_items for all using (private.is_desk(tenant_id)) with check (private.is_desk(tenant_id));
create policy client_credits_read on public.client_credits for select using (private.is_desk(tenant_id));
grant select, insert, update, delete on public.package_templates, public.package_template_items, public.client_packages, public.client_package_items to authenticated;
grant select on public.client_credits, public.client_credit_balances to authenticated;
revoke all on public.package_templates, public.package_template_items, public.client_packages, public.client_package_items, public.client_credits, public.client_credit_balances from anon;
revoke execute on function public.receive_credit(uuid, integer, public.payment_method, smallint, text), public.adjust_credit(uuid, integer, text, text), public.take_turn(uuid, uuid) from public, anon;
grant execute on function public.receive_credit(uuid, integer, public.payment_method, smallint, text), public.adjust_credit(uuid, integer, text, text), public.take_turn(uuid, uuid) to authenticated;
