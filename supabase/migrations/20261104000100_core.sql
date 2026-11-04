-- Terrasso.AI — núcleo multi-salão
-- Cada linha de negócio carrega tenant_id e é protegida por RLS.
-- A equipe acessa pelo Supabase Auth; clientes finais não têm login.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Conta: salões, unidades e equipe
-- ---------------------------------------------------------------------------

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'America/Sao_Paulo',
  settings    jsonb not null default '{}'::jsonb,  -- políticas, tom de voz, limites de mensagens
  created_at  timestamptz not null default now()
);

create table public.units (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  address     text,
  phone       text,
  created_at  timestamptz not null default now()
);

create type public.staff_role as enum ('owner', 'manager', 'reception', 'professional');

create table public.staff_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.staff_role not null,
  full_name   text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- Salões em que o usuário logado trabalha. security definer evita recursão de RLS.
create function public.my_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.staff_members
  where user_id = auth.uid() and active
$$;

create function public.has_role(p_tenant uuid, p_roles public.staff_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_members
    where tenant_id = p_tenant and user_id = auth.uid() and active and role = any(p_roles)
  )
$$;

-- ---------------------------------------------------------------------------
-- Catálogo: profissionais, serviços, escalas e bloqueios
-- ---------------------------------------------------------------------------

create table public.professionals (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  unit_id            uuid references public.units(id) on delete set null,
  user_id            uuid references auth.users(id) on delete set null,
  name               text not null,
  color              text,                       -- cor na grade da agenda
  partner_share_pct  numeric(5,2),               -- cota-parte (Lei do Salão Parceiro), null se CLT
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table public.services (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  category      text,
  duration_min  integer not null check (duration_min > 0),
  price_cents   integer not null check (price_cents >= 0),
  description   text,                            -- usado pela recepcionista IA
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.professional_services (
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  professional_id   uuid not null references public.professionals(id) on delete cascade,
  service_id        uuid not null references public.services(id) on delete cascade,
  commission_pct    numeric(5,2),
  primary key (professional_id, service_id)
);

-- Escala semanal: 0 = domingo ... 6 = sábado, horário local do salão
create table public.work_schedules (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  professional_id   uuid not null references public.professionals(id) on delete cascade,
  weekday           smallint not null check (weekday between 0 and 6),
  start_time        time not null,
  end_time          time not null,
  check (end_time > start_time)
);

create table public.blocks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  professional_id   uuid not null references public.professionals(id) on delete cascade,
  period            tstzrange not null,
  reason            text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clientes e consentimento (LGPD)
-- ---------------------------------------------------------------------------

create table public.clients (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  full_name      text,
  phone_e164     text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email          text,
  birth_date     date,
  notes          text,
  external_ref   text,                           -- id no sistema de origem (ex.: AVEC) na migração
  created_at     timestamptz not null default now(),
  unique (tenant_id, phone_e164)
);

create type public.consent_purpose as enum ('service_messages', 'marketing');

create table public.consents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  purpose      public.consent_purpose not null,
  granted      boolean not null,
  source       text not null,                    -- qr_cheguei, whatsapp, recepcao...
  recorded_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Agenda: o banco recusa dois atendimentos sobrepostos do mesmo profissional
-- ---------------------------------------------------------------------------

create type public.appointment_status as enum
  ('scheduled', 'confirmed', 'checked_in', 'in_service', 'done', 'cancelled', 'no_show');

create table public.appointments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  unit_id           uuid references public.units(id) on delete set null,
  client_id         uuid not null references public.clients(id),
  professional_id   uuid not null references public.professionals(id),
  service_id        uuid not null references public.services(id),
  period            tstzrange not null,
  status            public.appointment_status not null default 'scheduled',
  price_cents       integer not null check (price_cents >= 0),
  source            text not null default 'reception',  -- reception, whatsapp_ai, avec_import
  notes             text,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint appointments_no_overlap exclude using gist (
    professional_id with =,
    period with &&
  ) where (status not in ('cancelled', 'no_show'))
);

create index appointments_tenant_period on public.appointments using gist (tenant_id, period);
create index appointments_client on public.appointments (client_id);

-- ---------------------------------------------------------------------------
-- Comanda e caixa (núcleo; NFS-e e comissões entram em migrações próprias)
-- ---------------------------------------------------------------------------

create type public.comanda_status as enum ('open', 'closed', 'cancelled');

create table public.comandas (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  unit_id      uuid references public.units(id) on delete set null,
  client_id    uuid not null references public.clients(id),
  status       public.comanda_status not null default 'open',
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  opened_by    uuid references auth.users(id),
  closed_by    uuid references auth.users(id)
);

create table public.comanda_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  comanda_id       uuid not null references public.comandas(id) on delete cascade,
  appointment_id   uuid references public.appointments(id) on delete set null,
  service_id       uuid references public.services(id),
  professional_id  uuid references public.professionals(id),
  description      text not null,
  quantity         integer not null default 1 check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  discount_cents   integer not null default 0 check (discount_cents >= 0),
  discount_approved_by uuid references auth.users(id)
);

create type public.payment_method as enum ('cash', 'pix', 'debit', 'credit', 'voucher', 'package', 'other');

create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  comanda_id    uuid not null references public.comandas(id) on delete cascade,
  method        public.payment_method not null,
  amount_cents  integer not null check (amount_cents > 0),
  installments  smallint not null default 1,
  paid_at       timestamptz not null default now(),
  received_by   uuid references auth.users(id)
);

-- ---------------------------------------------------------------------------
-- WhatsApp: conversas, mensagens e transbordo para humano
-- ---------------------------------------------------------------------------

create table public.wa_numbers (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  phone_number_id   text not null unique,         -- id da Meta, usado para rotear o webhook
  display_phone     text not null,
  created_at        timestamptz not null default now()
);

create table public.conversations (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  client_id           uuid not null references public.clients(id) on delete cascade,
  wa_number_id        uuid not null references public.wa_numbers(id),
  assigned_user_id    uuid references auth.users(id), -- humano que assumiu; IA fica em silêncio
  last_inbound_at     timestamptz,                 -- abre a janela de 24h
  created_at          timestamptz not null default now(),
  unique (wa_number_id, client_id)
);

create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_author as enum ('client', 'ai', 'staff', 'system');

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  direction        public.message_direction not null,
  author           public.message_author not null,
  author_user_id   uuid references auth.users(id),
  wa_message_id    text unique,                    -- idempotência do webhook
  body             text,
  payload          jsonb,
  status           text,                           -- sent, delivered, read, failed
  created_at       timestamptz not null default now()
);

create index messages_conversation on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Auditoria: toda ação da IA ou da equipe fica registrada
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  actor_type   text not null,                      -- staff, ai, system
  actor_id     uuid,
  action       text not null,
  entity       text not null,
  entity_id    uuid,
  details      jsonb,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
create policy tenants_read on public.tenants for select to authenticated
  using (id in (select public.my_tenant_ids()));
create policy tenants_update on public.tenants for update to authenticated
  using (public.has_role(id, array['owner']::public.staff_role[]));

alter table public.staff_members enable row level security;
create policy staff_read on public.staff_members for select to authenticated
  using (tenant_id in (select public.my_tenant_ids()));
create policy staff_manage on public.staff_members for all to authenticated
  using (public.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]))
  with check (public.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]));

-- Tabelas operacionais: qualquer pessoa ativa da equipe do salão lê e escreve
do $$
declare t text;
begin
  foreach t in array array[
    'units', 'professionals', 'services', 'professional_services', 'work_schedules',
    'blocks', 'clients', 'consents', 'appointments', 'comandas', 'comanda_items',
    'payments', 'wa_numbers', 'conversations', 'messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (tenant_id in (select public.my_tenant_ids()))
         with check (tenant_id in (select public.my_tenant_ids()))',
      t || '_tenant_access', t);
  end loop;
end $$;

-- Auditoria: só leitura para dono e gerente; escrita pelo servidor (service_role)
alter table public.audit_log enable row level security;
create policy audit_read on public.audit_log for select to authenticated
  using (public.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]));
