-- Acessos por função, comissões, cliente trazida por profissional e avaliação do atendimento.
--
-- Funções:
--   owner / manager  = Administrador (tudo)
--   reception        = Recepção (agenda, comandas, clientes, produtos, conversas; sem caixa e sem comissões)
--   professional     = Profissional (só a própria agenda, os próprios atendimentos e comissões)

-- ---------- Auxiliares ----------
create function private.is_desk(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_tenant, array['owner', 'manager', 'reception']::public.staff_role[])
$$;
create function private.is_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_tenant, array['owner', 'manager']::public.staff_role[])
$$;
-- Profissionais ligados ao login atual (professionals.user_id)
create function private.my_professional_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.professionals p
    join public.staff_members s on s.tenant_id = p.tenant_id and s.user_id = auth.uid() and s.active
   where p.user_id = auth.uid()
$$;
revoke execute on function private.is_desk(uuid), private.is_admin(uuid), private.my_professional_ids() from public, anon;
grant execute on function private.is_desk(uuid), private.is_admin(uuid), private.my_professional_ids() to authenticated;

-- ---------- Comissão ----------
alter table public.professionals add column commission_pct numeric(5,2) not null default 0
  check (commission_pct between 0 and 100);
alter table public.comanda_items add column commission_pct numeric(5,2) check (commission_pct between 0 and 100);
alter table public.comanda_items add column commission_cents integer generated always as (
  round((quantity * unit_price_cents - discount_cents) * coalesce(commission_pct, 0) / 100)::integer
) stored;

-- Guarda o % do momento do lançamento: mudar o % depois não altera o passado.
create function private.comanda_items_commission() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.professional_id is null or new.product_id is not null then
    new.commission_pct := null;
  elsif tg_op = 'INSERT' or new.professional_id is distinct from old.professional_id or new.commission_pct is null then
    select coalesce(ps.commission_pct, p.commission_pct, 0) into new.commission_pct
      from public.professionals p
      left join public.professional_services ps on ps.professional_id = p.id and ps.service_id = new.service_id
     where p.id = new.professional_id;
  end if;
  return new;
end $$;
create trigger comanda_items_commission before insert or update on public.comanda_items
  for each row execute function private.comanda_items_commission();

-- ---------- Cliente trazida por profissional ----------
alter table public.clients add column referred_by_professional_id uuid references public.professionals(id) on delete set null;

-- ---------- Avaliação do atendimento ----------
alter table public.appointments add column feedback_sent_at timestamptz;
create table public.feedbacks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  appointment_id    uuid not null unique references public.appointments(id) on delete cascade,
  professional_id   uuid references public.professionals(id) on delete set null,
  client_id         uuid references public.clients(id) on delete set null,
  rating            smallint not null check (rating between 1 and 5),
  comment           text,
  awaiting_comment  boolean not null default false,
  created_at        timestamptz not null default now()
);
create index feedbacks_tenant_created on public.feedbacks (tenant_id, created_at desc);
alter table public.feedbacks enable row level security;
create policy feedbacks_admin on public.feedbacks for all to authenticated
  using (private.is_admin(tenant_id)) with check (private.is_admin(tenant_id));
create policy feedbacks_own on public.feedbacks for select to authenticated
  using (professional_id in (select private.my_professional_ids()));

-- ---------- Políticas por função ----------
-- Balcão (administrador e recepção): dados operacionais e de clientes
do $$
declare t text;
begin
  foreach t in array array['clients', 'consents', 'appointments', 'comandas', 'comanda_items', 'payments',
                           'wa_numbers', 'conversations', 'messages', 'products', 'stock_movements'] loop
    execute format('drop policy %I on public.%I', t || '_tenant_access', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (private.is_desk(tenant_id)) with check (private.is_desk(tenant_id))',
      t || '_desk', t);
  end loop;
end $$;

-- Cadastro (profissionais, serviços, horários): todos leem, só administrador altera
do $$
declare t text;
begin
  foreach t in array array['professionals', 'services', 'professional_services', 'work_schedules', 'units'] loop
    execute format('drop policy %I on public.%I', t || '_tenant_access', t);
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (tenant_id in (select private.my_tenant_ids()))', t || '_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (private.is_admin(tenant_id)) with check (private.is_admin(tenant_id))', t || '_admin', t);
  end loop;
end $$;

-- Bloqueios: todos leem; balcão cria e remove
drop policy blocks_tenant_access on public.blocks;
create policy blocks_read on public.blocks for select to authenticated
  using (tenant_id in (select private.my_tenant_ids()));
create policy blocks_desk on public.blocks for all to authenticated
  using (private.is_desk(tenant_id)) with check (private.is_desk(tenant_id));

-- Profissional: a própria agenda (pode mudar a situação), os próprios itens de comanda
create policy appointments_own on public.appointments for select to authenticated
  using (professional_id in (select private.my_professional_ids()));
create policy appointments_own_status on public.appointments for update to authenticated
  using (professional_id in (select private.my_professional_ids()))
  with check (professional_id in (select private.my_professional_ids()));
create policy comanda_items_own on public.comanda_items for select to authenticated
  using (professional_id in (select private.my_professional_ids()));
create policy comandas_own on public.comandas for select to authenticated
  using (id in (select comanda_id from public.comanda_items where professional_id in (select private.my_professional_ids())));
-- Nome das clientes que atendeu (o painel mostra só o nome)
create policy clients_own on public.clients for select to authenticated
  using (id in (select client_id from public.appointments where professional_id in (select private.my_professional_ids())));

-- O profissional só muda a situação do próprio horário (não horário, preço ou cliente)
create function private.appointments_professional_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_desk(new.tenant_id) then
    if (new.period, new.professional_id, new.client_id, new.service_id, new.price_cents, new.notes)
       is distinct from (old.period, old.professional_id, old.client_id, old.service_id, old.price_cents, old.notes) then
      raise exception 'Profissional só pode mudar a situação do atendimento.';
    end if;
  end if;
  return new;
end $$;
create trigger appointments_professional_guard before update on public.appointments
  for each row execute function private.appointments_professional_guard();
