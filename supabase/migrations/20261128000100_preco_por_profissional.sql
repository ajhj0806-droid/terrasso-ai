-- Preço e duração por profissional.
-- O serviço continua com o preço e a duração padrão. No vínculo profissional–serviço,
-- price_cents / duration_min em branco (null) = vale o padrão do serviço; preenchido = substitui o padrão
-- para esse profissional. A comissão continua em % do valor lançado, então acompanha o preço cobrado.
alter table public.professional_services
  add column if not exists price_cents  integer check (price_cents >= 0),
  add column if not exists duration_min integer check (duration_min > 0);

comment on column public.professional_services.price_cents  is 'Preço deste profissional para o serviço (centavos). Null = preço do serviço.';
comment on column public.professional_services.duration_min is 'Duração deste profissional para o serviço (min). Null = duração do serviço.';
