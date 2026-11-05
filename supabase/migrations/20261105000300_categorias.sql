-- Cadastro de categorias (Cabelo, Unhas...) usado por serviços e produtos.
-- services.category e products.category continuam guardando o nome (a IA lê esse texto);
-- o painel só deixa escolher nomes deste cadastro e renomeia nos dois lugares.

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table public.categories enable row level security;
create policy categories_tenant_access on public.categories for all to authenticated
  using (tenant_id in (select private.my_tenant_ids()))
  with check (tenant_id in (select private.my_tenant_ids()));

insert into public.categories (tenant_id, name)
select distinct tenant_id, trim(category) from (
  select tenant_id, category from public.services where category is not null and trim(category) <> ''
  union
  select tenant_id, category from public.products where category is not null and trim(category) <> ''
) x
on conflict do nothing;
