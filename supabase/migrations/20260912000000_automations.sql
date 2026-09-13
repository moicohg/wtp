-- Motor de Automatizaciones: definición de cadencias multi-día (plantilla +
-- pasos). Por ahora solo se guarda la definición (borrador); el motor que
-- realmente inscribe leads y envía los mensajes programados es una fase
-- futura — ver conversación del 2026-09-12. Mismo modelo de RLS sin auth que
-- el resto de tablas del panel.

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  template text,
  ignore_exit_on_conversion boolean not null default false,
  steps jsonb not null default '[]',
  status text not null default 'borrador',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automations_status_check check (status in ('borrador', 'activa', 'pausada'))
);

create index idx_automations_created_at on public.automations using btree (created_at desc);

create trigger set_automations_updated_at
  before update on public.automations
  for each row execute function public.set_updated_at();

alter table public.automations enable row level security;

create policy anon_select_automations on public.automations for select to anon using (true);
create policy anon_insert_automations on public.automations for insert to anon with check (true);
create policy anon_update_automations on public.automations for update to anon using (true) with check (true);
create policy anon_delete_automations on public.automations for delete to anon using (true);
