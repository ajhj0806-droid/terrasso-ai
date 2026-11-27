-- Caixa ao qual a comanda está associada (escolhido na tela Comandas). Os pagamentos da comanda vão para ele.
-- Pode ser rodado mais de uma vez.
alter table public.comandas add column if not exists cash_register_id uuid references public.cash_registers(id) on delete set null;
create index if not exists comandas_cash_register_idx on public.comandas (cash_register_id);
