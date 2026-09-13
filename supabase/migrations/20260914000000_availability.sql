-- Disponibilidad del equipo: estado en tiempo real de cada vendedor (agent),
-- historial de estados (para las métricas de "tiempo en cada estado" de
-- KPIs), y configuración de asignación inteligente / alerta de respuesta.
--
-- El estado SÍ es real: se cambia manualmente desde la pestaña "Tiempo real"
-- y cada cambio queda loggeado en agent_status_log. Lo que NO se construye
-- todavía son los dos "motores" automáticos (repartir leads solos según
-- prioridad, y mandar el WhatsApp de la alerta) — solo se guarda su
-- configuración, ver conversación 2026-09-13.

alter table public.agents
  add column status text not null default 'fuera_de_atencion',
  add column status_updated_at timestamptz not null default now(),
  add column priority integer not null default 1,
  add constraint agents_status_check
    check (status in ('listo', 'atendiendo', 'pausa', 'fuera_de_atencion', 'inactivo_sistema', 'difusiones')),
  add constraint agents_priority_check check (priority between 1 and 10);

create table public.agent_status_log (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint agent_status_log_status_check
    check (status in ('listo', 'atendiendo', 'pausa', 'fuera_de_atencion', 'inactivo_sistema', 'difusiones'))
);

create index idx_agent_status_log_agent_started on public.agent_status_log using btree (agent_id, started_at desc);
create index idx_agent_status_log_open on public.agent_status_log using btree (agent_id) where (ended_at is null);

-- Fila única (singleton) con la config de Disponibilidad > Config.
create table public.availability_settings (
  id text primary key default 'default',
  smart_assignment_enabled boolean not null default false,
  alert_enabled boolean not null default false,
  alert_phones text[] not null default '{}',
  alert_etapas text[] not null default '{}',
  alert_minutes integer not null default 15,
  updated_at timestamptz not null default now(),
  constraint availability_settings_singleton check (id = 'default')
);

insert into public.availability_settings (id) values ('default');

create trigger set_availability_settings_updated_at
  before update on public.availability_settings
  for each row execute function public.set_updated_at();

alter table public.agent_status_log enable row level security;
alter table public.availability_settings enable row level security;

create policy anon_select_agent_status_log on public.agent_status_log for select to anon using (true);
create policy anon_insert_agent_status_log on public.agent_status_log for insert to anon with check (true);
create policy anon_update_agent_status_log on public.agent_status_log for update to anon using (true) with check (true);

create policy anon_select_availability_settings on public.availability_settings for select to anon using (true);
create policy anon_update_availability_settings on public.availability_settings for update to anon using (true) with check (true);
