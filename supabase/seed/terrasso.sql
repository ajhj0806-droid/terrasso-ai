-- Carga inicial do salão Terrasso (rodar uma vez no SQL Editor da Supabase).
-- Serviços, profissionais e escalas: preencher com os dados reais antes do piloto.

insert into public.tenants (name, slug, timezone, settings)
values ('Terrasso', 'terrasso', 'America/Sao_Paulo', jsonb_build_object(
  'tom_de_voz', 'Acolhedor, elegante e direto. Trate por você. Mensagens curtas.',
  'politicas', 'Cancelamento ou remarcação com pelo menos 24h de antecedência. Tolerância de 15 minutos de atraso.'
))
on conflict (slug) do nothing;

insert into public.wa_numbers (tenant_id, phone_number_id, display_phone)
select id, '1467576776428279', '+55 41 98852-9630' from public.tenants where slug = 'terrasso'
on conflict (phone_number_id) do nothing;

-- Exemplo (descomente e ajuste):
-- with t as (select id from public.tenants where slug = 'terrasso'),
--      s as (insert into public.services (tenant_id, name, category, duration_min, price_cents, description)
--            select id, 'Corte feminino', 'Cabelo', 60, 12000, 'Corte com lavagem e finalização' from t returning id, tenant_id),
--      p as (insert into public.professionals (tenant_id, name) select id, 'Nome da profissional' from t returning id, tenant_id)
-- insert into public.professional_services (tenant_id, professional_id, service_id)
-- select p.tenant_id, p.id, s.id from p, s;
-- Escala de terça a sábado, 9h às 19h:
-- insert into public.work_schedules (tenant_id, professional_id, weekday, start_time, end_time)
-- select tenant_id, id, d, '09:00', '19:00' from public.professionals, generate_series(2, 6) d where name = 'Nome da profissional';
