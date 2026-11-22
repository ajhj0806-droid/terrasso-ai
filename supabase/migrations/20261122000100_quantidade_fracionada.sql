-- Produtos com quantidade fracionada (ex.: 0,5 ou 1,25): estoque, movimentos e itens de comanda
-- passam de inteiro para numérico com até 3 casas. Valores em centavos continuam inteiros
-- (total do item = arredondamento de quantidade x preço).

-- Dependências da coluna quantity: a visão de classificação e a comissão calculada.
drop view if exists public.client_stats;
alter table public.comanda_items drop column commission_cents;

alter table public.comanda_items alter column quantity type numeric(12,3);
alter table public.products alter column stock_qty type numeric(12,3);
alter table public.products alter column min_stock type numeric(12,3);
alter table public.stock_movements alter column qty_delta type numeric(12,3);

alter table public.comanda_items drop constraint if exists comanda_items_discount_le_total;
alter table public.comanda_items add constraint comanda_items_discount_le_total
  check (discount_cents <= round(quantity * unit_price_cents));

alter table public.comanda_items add column commission_cents integer generated always as (
  round((round(quantity * unit_price_cents) - discount_cents) * coalesce(commission_pct, 0) / 100)::integer
) stored;

create view public.client_stats with (security_invoker = true) as
select c.tenant_id,
       c.id as client_id,
       coalesce(k.visits, 0)    as visits_12m,
       coalesce(a.cancelled, 0) as cancels_12m,
       coalesce(a.no_show, 0)   as no_shows_12m,
       coalesce(k.spent, 0)     as spent_12m_cents,
       k.last_visit,
       coalesce(k.visits, 0) - coalesce(a.cancelled, 0) - 2 * coalesce(a.no_show, 0) as points
  from public.clients c
  left join lateral (
    select count(*) filter (where status = 'cancelled') as cancelled,
           count(*) filter (where status = 'no_show')   as no_show
      from public.appointments ap
     where ap.client_id = c.id and lower(ap.period) > now() - interval '12 months'
  ) a on true
  left join lateral (
    select count(distinct co.id) as visits, max(co.closed_at) as last_visit,
           sum(round(i.quantity * i.unit_price_cents) - i.discount_cents)::bigint as spent
      from public.comandas co left join public.comanda_items i on i.comanda_id = co.id
     where co.client_id = c.id and co.status = 'closed' and co.closed_at > now() - interval '12 months'
  ) k on true;
grant select on public.client_stats to authenticated;
revoke all on public.client_stats from anon;

create or replace function public.close_comanda(p_comanda uuid) returns void
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

  select coalesce(sum(round(quantity * unit_price_cents) - discount_cents), 0) into v_total
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
