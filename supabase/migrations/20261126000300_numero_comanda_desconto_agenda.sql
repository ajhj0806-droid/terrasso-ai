-- 1) Número sequencial da comanda (por salão). As existentes são numeradas pela ordem de abertura.
-- 2) Desconto combinado no agendamento (vai para o item quando a comanda é aberta).
-- 3) Características do produto (ex.: "frasco 1 L, uso profissional"), mostradas nos produtos usados.
alter table public.comandas add column if not exists number integer;
with o as (select id, row_number() over (partition by tenant_id order by opened_at, id) as n from public.comandas)
update public.comandas c set number = o.n from o where o.id = c.id and c.number is null;
create unique index if not exists comandas_tenant_number on public.comandas (tenant_id, number);

create or replace function private.comanda_number() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null then
    perform pg_advisory_xact_lock(hashtext('comanda_num' || new.tenant_id::text));
    select coalesce(max(number), 0) + 1 into new.number from public.comandas where tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
drop trigger if exists comandas_number on public.comandas;
create trigger comandas_number before insert on public.comandas for each row execute function private.comanda_number();

alter table public.appointments add column if not exists discount_cents integer not null default 0 check (discount_cents >= 0);
alter table public.products add column if not exists description text;
