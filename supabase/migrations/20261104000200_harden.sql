-- Recomendações do Security Advisor da Supabase:
-- funções auxiliares de RLS saem do schema exposto pela API
-- e a extensão btree_gist vai para o schema "extensions".
-- As políticas referenciam as funções por OID, então continuam valendo.

create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.my_tenant_ids() set schema private;
alter function public.has_role(uuid, public.staff_role[]) set schema private;

revoke execute on function private.my_tenant_ids() from public, anon;
revoke execute on function private.has_role(uuid, public.staff_role[]) from public, anon;
grant execute on function private.my_tenant_ids() to authenticated;
grant execute on function private.has_role(uuid, public.staff_role[]) to authenticated;

create schema if not exists extensions;
alter extension btree_gist set schema extensions;
