-- 1) Fechar comanda com DÍVIDA: a cliente esqueceu de pagar, a comanda fecha mesmo assim (para o caixa poder fechar)
--    e o que faltou fica como dívida (total - pago), que aparece em destaque na próxima comanda dela.
-- 2) Lançamentos do caixa (despesas, retiradas, adiantamentos) podem ser ligados a um caixa.
-- Pode ser rodado mais de uma vez.

drop function if exists public.close_comanda(uuid);
drop function if exists public.close_comanda(uuid, boolean);
create function public.close_comanda(p_comanda uuid, p_divida boolean default false) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_tenant uuid;
  v_status public.comanda_status;
  v_total bigint;
  v_paid bigint;
  v_taxas jsonb;
  v_fee bigint;
  v_base bigint;
begin
  select tenant_id, status into v_tenant, v_status from public.comandas where id = p_comanda for update;
  if not found then raise exception 'Comanda não encontrada.'; end if;
  if v_status <> 'open' then raise exception 'Esta comanda já foi fechada ou cancelada.'; end if;

  select coalesce(sum(round(quantity * unit_price_cents) - discount_cents), 0) into v_total
    from public.comanda_items where comanda_id = p_comanda;
  select coalesce(sum(amount_cents), 0) into v_paid
    from public.payments where comanda_id = p_comanda;
  if v_total = 0 and not exists (select 1 from public.comanda_items where comanda_id = p_comanda) then
    raise exception 'A comanda está vazia.';
  end if;
  if v_paid < v_total and not p_divida then
    raise exception 'Ainda falta receber R$ %.', to_char((v_total - v_paid) / 100.0, 'FM999G990D00');
  end if;

  -- taxa do cartão (débito, crédito à vista, crédito parcelado), rateada pelo valor dos itens pagos em dinheiro novo
  select coalesce(settings -> 'taxas_cartao', '{}'::jsonb) into v_taxas from public.tenants where id = v_tenant;
  select coalesce(sum(round(amount_cents * coalesce(nullif(v_taxas ->> (case when method = 'credit' and installments > 1 then 'credit_parc'
                                                                              else method::text end), '')::numeric, 0) / 100)), 0)
    into v_fee from public.payments where comanda_id = p_comanda and method in ('debit', 'credit');
  select coalesce(sum(round(quantity * unit_price_cents) - discount_cents), 0) into v_base
    from public.comanda_items where comanda_id = p_comanda and client_package_item_id is null;
  update public.comanda_items i set card_fee_cents =
         case when v_fee > 0 and v_base > 0 and i.client_package_item_id is null
              then least(round(v_fee * (round(i.quantity * i.unit_price_cents) - i.discount_cents) / v_base)::integer,
                         (round(i.quantity * i.unit_price_cents) - i.discount_cents)::integer)
              else 0 end
   where i.comanda_id = p_comanda;

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
grant execute on function public.close_comanda(uuid, boolean) to authenticated;

alter table public.cash_entries add column if not exists cash_register_id uuid references public.cash_registers(id) on delete set null;
create index if not exists cash_entries_cash_register_idx on public.cash_entries (cash_register_id);
