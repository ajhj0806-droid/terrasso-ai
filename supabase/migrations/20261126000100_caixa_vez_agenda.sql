-- Caixa do dia: lançamentos manuais (despesas extras, limpeza, adiantamentos a profissionais, retiradas)
-- e fila do "profissional da vez" escolhida na Agenda, para o horário marcado. Tudo aditivo.

create table public.cash_entries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  kind            text not null check (kind in ('expense', 'cleaning', 'advance', 'withdrawal')),
  description     text not null,
  amount_cents    integer not null check (amount_cents > 0),
  entry_date      date not null,
  professional_id uuid references public.professionals(id) on delete set null,
  created_by      uuid references auth.users(id) default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now()
);
create index on public.cash_entries (tenant_id, entry_date);
alter table public.cash_entries enable row level security;
create policy cash_entries_read on public.cash_entries for select using (private.is_desk(tenant_id));
create policy cash_entries_insert on public.cash_entries for insert with check (private.is_desk(tenant_id));
create policy cash_entries_delete on public.cash_entries for delete using (private.is_admin(tenant_id));
grant select, insert, delete on public.cash_entries to authenticated;
revoke all on public.cash_entries from anon;

alter table public.appointments add column by_turn boolean not null default false;

-- Próximo da vez para um horário: faz o serviço, trabalha nesse horário, não tem atendimento nem bloqueio
-- que encoste nele; entre esses, quem atendeu "da vez" há mais tempo. Marca a vez dele.
create function public.take_turn_slot(p_tenant uuid, p_service uuid, p_ini timestamptz, p_fim timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_li timestamp; v_lf timestamp; v_prof uuid;
begin
  if not private.is_desk(p_tenant) then raise exception 'Sem permissão.'; end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_li := p_ini at time zone coalesce(v_tz, 'America/Sao_Paulo');
  v_lf := p_fim at time zone coalesce(v_tz, 'America/Sao_Paulo');
  perform pg_advisory_xact_lock(hashtext('vez' || p_tenant::text));
  select p.id into v_prof
    from public.professionals p
   where p.tenant_id = p_tenant and p.active and p.in_turn_queue
     and (not exists (select 1 from public.professional_services x where x.service_id = p_service)
          or exists (select 1 from public.professional_services x where x.service_id = p_service and x.professional_id = p.id))
     and exists (select 1 from public.work_schedules w where w.professional_id = p.id
                  and w.weekday = extract(dow from v_li) and v_li::time >= w.start_time and v_lf::time <= w.end_time)
     and not exists (select 1 from public.appointments a where a.professional_id = p.id
                      and a.status not in ('cancelled', 'no_show') and a.period && tstzrange(p_ini, p_fim))
     and not exists (select 1 from public.blocks b where b.professional_id = p.id and b.period && tstzrange(p_ini, p_fim))
   order by p.last_turn_at asc nulls first, p.name
   limit 1;
  if v_prof is not null then update public.professionals set last_turn_at = now() where id = v_prof; end if;
  return v_prof;
end $$;
revoke execute on function public.take_turn_slot(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.take_turn_slot(uuid, uuid, timestamptz, timestamptz) to authenticated;
