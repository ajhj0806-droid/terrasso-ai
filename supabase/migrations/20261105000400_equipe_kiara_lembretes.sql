-- Equipe (convites e e-mail no cadastro), liga/desliga da Kiara, controle de resposta
-- e lembrete na véspera.

-- ---------- Kiara: liga/desliga geral do salão ----------
alter table public.tenants add column ai_enabled boolean not null default true;

-- Qualquer pessoa ativa da equipe pode ligar ou desligar (a recepção precisa assumir).
create function public.set_ai_enabled(p_tenant uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.staff_members
                  where tenant_id = p_tenant and user_id = auth.uid() and active) then
    raise exception 'Sem permissão.';
  end if;
  update public.tenants set ai_enabled = p_enabled where id = p_tenant;
  insert into public.audit_log (tenant_id, actor_type, actor_id, action, entity, entity_id, details)
  values (p_tenant, 'staff', auth.uid(), case when p_enabled then 'ai.enabled' else 'ai.disabled' end, 'tenants', p_tenant, null);
end $$;
revoke execute on function public.set_ai_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_ai_enabled(uuid, boolean) to authenticated;

-- ---------- Conversas: saber quem está esperando resposta ----------
alter table public.conversations add column last_outbound_at timestamptz;
update public.conversations c set last_outbound_at = m.t
  from (select conversation_id, max(created_at) t from public.messages where direction = 'outbound' group by 1) m
 where m.conversation_id = c.id;

-- ---------- Lembrete na véspera ----------
alter table public.appointments add column reminder_sent_at timestamptz;

-- ---------- Equipe ----------
alter table public.staff_members add column email text;
update public.staff_members s set email = lower(u.email) from auth.users u where u.id = s.user_id;

create table public.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  email        text not null check (email = lower(email) and email like '%@%'),
  full_name    text not null,
  role         public.staff_role not null check (role <> 'owner'),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  unique (tenant_id, email)
);
alter table public.staff_invites enable row level security;
create policy staff_invites_manage on public.staff_invites for all to authenticated
  using (private.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]))
  with check (private.has_role(tenant_id, array['owner', 'manager']::public.staff_role[]));

-- Quem entra com um e-mail convidado vira membro da equipe do salão.
create function public.claim_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_email text; v_n integer;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  insert into public.staff_members (tenant_id, user_id, role, full_name, email)
  select i.tenant_id, auth.uid(), i.role, i.full_name, v_email
    from public.staff_invites i
   where i.email = v_email and i.accepted_at is null
  on conflict (tenant_id, user_id) do nothing;
  get diagnostics v_n = row_count;
  update public.staff_invites set accepted_at = now() where email = v_email and accepted_at is null;
  return v_n;
end $$;
revoke execute on function public.claim_invites() from public, anon;
grant execute on function public.claim_invites() to authenticated;
