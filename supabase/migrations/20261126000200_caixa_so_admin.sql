-- Caixa é só do administrador: ver e lançar despesas e retiradas (decisão do Airton, 26/11).
drop policy if exists cash_entries_read on public.cash_entries;
drop policy if exists cash_entries_insert on public.cash_entries;
create policy cash_entries_read on public.cash_entries for select using (private.is_admin(tenant_id));
create policy cash_entries_insert on public.cash_entries for insert with check (private.is_admin(tenant_id));
