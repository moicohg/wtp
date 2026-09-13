-- Roles y permisos para vendedores. Igual que el resto del panel, sin capa
-- de auth propia todavía: anon puede leer/administrar esta tabla desde el
-- dashboard (ver comentario en agents_and_canales.sql). Los permisos no se
-- hacen cumplir en ningún lado todavía — son solo la definición, lista para
-- usarse cuando el panel tenga login real.

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.roles enable row level security;

create policy anon_select_roles on public.roles for select to anon using (true);
create policy anon_insert_roles on public.roles for insert to anon with check (true);
create policy anon_update_roles on public.roles for update to anon using (true) with check (true);
create policy anon_delete_roles on public.roles for delete to anon using (true);

insert into public.roles (name, permissions, is_system) values
  ('Administrador', array[
    'leads.view','leads.edit','leads.assign','leads.create_contacts','leads.manage_tags',
    'messaging.view_broadcasts','messaging.send_broadcasts','messaging.manage_templates','messaging.manage_automations',
    'agenda.view_priority_queue','agenda.manage',
    'analytics.dashboard','analytics.ai_usage',
    'config.manage_channels','config.migrate_channels','config.ai_settings','config.alerts','config.products',
    'users.manage_users','users.manage_roles'
  ], true),
  ('Vendedores', array['analytics.dashboard','analytics.ai_usage'], false);
