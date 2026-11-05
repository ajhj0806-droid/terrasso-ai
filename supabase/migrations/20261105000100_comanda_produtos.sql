-- Comanda e caixa: catálogo de produtos, estoque e fechamento seguro da comanda.

create table public.products (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  category     text,
  price_cents  integer not null check (price_cents >= 0),
  cost_cents   integer check (cost_cents >= 0),
  stock_qty    integer not null default 0,
  min_stock    integer not null default 0 check (min_stock >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index products_tenant on public.products (tenant_id, name);

create table public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  qty_delta   integer not null check (qty_delta <> 0),
  reason      text not null,                    -- venda, entrada, ajuste
  comanda_id  uuid references public.comandas(id) on delete set null,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index stock_movements_product on public.stock_movements (product_id, created_at);

alter table public.comanda_items
  add column product_id uuid references public.products(id),
  add column created_at timestamptz not null default now(),
  add constraint comanda_items_discount_le_total check (discount_cents <= quantity * unit_price_cents);

-- um atendimento da agenda só entra em uma comanda (evita cobrar duas vezes)
create unique index comanda_items_one_appointment on public.comanda_items (appointment_id) where appointment_id is not null;
create index comanda_items_comanda on public.comanda_items (comanda_id);
create index comandas_tenant_status on public.comandas (tenant_id, status, opened_at);
create index payments_comanda on public.payments (comanda_id);

do $$
declare t text;
begin
  foreach t in array array['products', 'stock_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (tenant_id in (select private.my_tenant_ids()))
         with check (tenant_id in (select private.my_tenant_ids()))',
      t || '_tenant_access', t);
  end loop;
end $$;

-- Fecha a comanda numa única transação: confere se está paga, baixa o estoque
-- dos produtos e marca os atendimentos como finalizados. Roda com as permissões
-- de quem chama (RLS vale normalmente).
create function public.close_comanda(p_comanda uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_tenant uuid;
  v_status public.comanda_status;
  v_total bigint;
  v_paid bigint;
begin
  select tenant_id, status into v_tenant, v_status from public.comandas where id = p_comanda for update;
  if not found then raise exception 'Comanda não encontrada.'; end if;
  if v_status <> 'open' then raise exception 'Esta comanda já foi fechada ou cancelada.'; end if;

  select coalesce(sum(quantity * unit_price_cents - discount_cents), 0) into v_total
    from public.comanda_items where comanda_id = p_comanda;
  select coalesce(sum(amount_cents), 0) into v_paid
    from public.payments where comanda_id = p_comanda;
  if v_total = 0 then raise exception 'A comanda está vazia.'; end if;
  if v_paid < v_total then
    raise exception 'Ainda falta receber R$ %.', to_char((v_total - v_paid) / 100.0, 'FM999G990D00');
  end if;

  insert into public.stock_movements (tenant_id, product_id, qty_delta, reason, comanda_id, created_by)
    select v_tenant, product_id, -sum(quantity), 'venda', p_comanda, auth.uid()
      from public.comanda_items where comanda_id = p_comanda and product_id is not null
      group by product_id;
  update public.products p set stock_qty = p.stock_qty - i.q
    from (select product_id, sum(quantity) q from public.comanda_items
           where comanda_id = p_comanda and product_id is not null group by product_id) i
   where p.id = i.product_id;

  update public.appointments set status = 'done', updated_at = now()
   where id in (select appointment_id from public.comanda_items
                 where comanda_id = p_comanda and appointment_id is not null)
     and status in ('scheduled', 'confirmed', 'checked_in', 'in_service');

  update public.comandas set status = 'closed', closed_at = now(), closed_by = auth.uid()
   where id = p_comanda;
end $$;

revoke execute on function public.close_comanda(uuid) from public, anon;
grant execute on function public.close_comanda(uuid) to authenticated;
