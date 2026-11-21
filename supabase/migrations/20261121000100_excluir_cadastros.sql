-- Exclui serviços ou profissionais marcados, somente os que não têm histórico.
-- Histórico de serviço: agendamentos ou itens de comanda.
-- Histórico de profissional: agendamentos, itens de comanda, avaliações, clientes indicados
-- ou lançamentos no fluxo pessoal (pro_ledger, que o administrador não enxerga pela RLS).
-- Só administrador (dono/gerente) do salão do item pode excluir.
create or replace function public.excluir_cadastros(p_tipo text, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_tenant uuid; v_nome text; v_motivo text;
  v_excluidos jsonb := '[]'::jsonb; v_mantidos jsonb := '[]'::jsonb;
begin
  if p_tipo not in ('servico', 'profissional') then raise exception 'tipo inválido'; end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    if p_tipo = 'servico' then
      select tenant_id, name into v_tenant, v_nome from public.services where id = v_id;
    else
      select tenant_id, name into v_tenant, v_nome from public.professionals where id = v_id;
    end if;
    continue when v_tenant is null;
    if not private.is_admin(v_tenant) then raise exception 'Só o administrador pode excluir.'; end if;
    v_motivo := null;
    if p_tipo = 'servico' then
      if exists (select 1 from public.appointments where service_id = v_id) then v_motivo := 'tem agendamentos';
      elsif exists (select 1 from public.comanda_items where service_id = v_id) then v_motivo := 'tem comandas';
      end if;
    else
      if exists (select 1 from public.appointments where professional_id = v_id) then v_motivo := 'tem agendamentos';
      elsif exists (select 1 from public.comanda_items where professional_id = v_id) then v_motivo := 'tem comandas';
      elsif exists (select 1 from public.feedbacks where professional_id = v_id) then v_motivo := 'tem avaliações';
      elsif exists (select 1 from public.clients where referred_by_professional_id = v_id) then v_motivo := 'tem clientes indicados';
      elsif exists (select 1 from public.pro_ledger where professional_id = v_id) then v_motivo := 'tem lançamentos no fluxo pessoal';
      end if;
    end if;
    if v_motivo is not null then
      v_mantidos := v_mantidos || jsonb_build_object('id', v_id, 'nome', v_nome, 'motivo', v_motivo);
    else
      if p_tipo = 'servico' then delete from public.services where id = v_id;
      else delete from public.professionals where id = v_id; end if;
      v_excluidos := v_excluidos || jsonb_build_object('id', v_id, 'nome', v_nome);
    end if;
  end loop;
  return jsonb_build_object('excluidos', v_excluidos, 'mantidos', v_mantidos);
end $$;
revoke execute on function public.excluir_cadastros(text, uuid[]) from public, anon;
grant execute on function public.excluir_cadastros(text, uuid[]) to authenticated;
