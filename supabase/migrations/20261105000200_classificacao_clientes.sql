-- Classificação de clientes (categorias cadastradas pelo salão) e registro de cancelamento.
-- Pontos dos últimos 12 meses = visitas (comandas fechadas) - cancelamentos - 2 x faltas.
-- A cliente fica na maior categoria cujo mínimo de pontos ela alcança.

create table public.client_tiers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  color       text not null default '#c9a227',
  min_points  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table public.client_tiers enable row level security;
create policy client_tiers_read on public.client_tiers for select to authenticated
  using (tenant_id in (select private.my_tenant_ids()));
create policy client_tiers_manage on public.client_tiers for all to authenticated
  using (private.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]))
  with check (private.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]));

insert into public.client_tiers (tenant_id, name, color, min_points)
select t.id, v.name, v.color, v.min_points
  from public.tenants t
  cross join (values ('Novo', '#9e9e9e', 0), ('Prata', '#9aa5b1', 3), ('Ouro', '#e0b100', 8), ('Diamante', '#4fc3f7', 15))
    as v(name, color, min_points)
on conflict do nothing;

-- quando o horário foi cancelado (vale para recepção e para a IA)
alter table public.appointments add column cancelled_at timestamptz;

create function private.appointments_set_cancelled_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then new.cancelled_at := now();
  elsif new.status <> 'cancelled' then new.cancelled_at := null;
  end if;
  return new;
end $$;
create trigger appointments_cancelled_at before update of status on public.appointments
  for each row execute function private.appointments_set_cancelled_at();

-- números de cada cliente nos últimos 12 meses (respeita o RLS de quem consulta)
-- visita = comanda fechada (cobre quem chega sem agendar)
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
           sum(i.quantity * i.unit_price_cents - i.discount_cents) as spent
      from public.comandas co left join public.comanda_items i on i.comanda_id = co.id
     where co.client_id = c.id and co.status = 'closed' and co.closed_at > now() - interval '12 months'
  ) k on true;

grant select on public.client_stats to authenticated;
revoke all on public.client_stats from anon;
