-- Multi-empresa (SaaS): organizations + profiles + organization_id en todas
-- las tablas de negocio, helpers y políticas para `authenticated`.
--
-- Migración ADITIVA: las políticas `anon` existentes se mantienen para que el
-- panel actual siga funcionando hasta el corte. La migración de lockdown
-- (20260921000000) las elimina y cierra los grants a `anon`.
--
-- Diseño:
--  * Tablas raíz (vendors, agents, automations, catalog_files, custom_fields,
--    products, roles): organization_id con default current_org_id() → los
--    inserts del dashboard no cambian.
--  * Tablas hijas (prospects ← vendors, messages ← prospects,
--    agent_status_log ← agents): trigger before insert que SIEMPRE deriva la
--    empresa del padre → webhooks y send-message no cambian, y nadie puede
--    colgar una fila de un padre ajeno.
--  * Helpers security definer (dueño postgres ⇒ sin recursión de RLS).

-- ── organizations ────────────────────────────────────────────────────────────

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  max_channels integer not null default 1,
  created_at timestamptz not null default now(),
  constraint organizations_max_channels_check check (max_channels >= 0)
);

-- Empresa inicial: recibe toda la data existente. UUID fijo para poder
-- referenciarla desde el lockdown y el bootstrap del dueño.
insert into public.organizations (id, name, max_channels)
values ('00000000-0000-4000-8000-000000000007', '007', 50);

-- ── agents.role_id ───────────────────────────────────────────────────────────

alter table public.agents
  add column role_id uuid references public.roles (id) on delete set null;

-- ── profiles (una fila por usuario de Auth) ──────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_type text not null,
  is_super_admin boolean not null default false,
  is_active boolean not null default true,
  agent_id uuid unique references public.agents (id) on delete set null,
  full_name text,
  email text not null,
  phone text unique,
  created_at timestamptz not null default now(),
  constraint profiles_user_type_check check (user_type in ('admin', 'vendedor')),
  constraint profiles_phone_check check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$')
);

create index idx_profiles_organization on public.profiles (organization_id);

-- ── organization_id en las 11 tablas de negocio ──────────────────────────────

alter table public.vendors               add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.agents                add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.prospects             add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.messages              add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.agent_status_log      add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.automations           add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.availability_settings add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.catalog_files         add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.custom_fields         add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.products              add column organization_id uuid references public.organizations (id) on delete restrict;
alter table public.roles                 add column organization_id uuid references public.organizations (id) on delete restrict;

create index idx_vendors_organization          on public.vendors (organization_id);
create index idx_agents_organization           on public.agents (organization_id);
create index idx_prospects_organization        on public.prospects (organization_id);
create index idx_messages_organization         on public.messages (organization_id);
create index idx_agent_status_log_organization on public.agent_status_log (organization_id);
create index idx_automations_organization      on public.automations (organization_id);
create index idx_catalog_files_organization    on public.catalog_files (organization_id);
create index idx_custom_fields_organization    on public.custom_fields (organization_id);
create index idx_products_organization         on public.products (organization_id);
create index idx_roles_organization            on public.roles (organization_id);

-- Backfill: toda la data existente pertenece a 007.
update public.vendors               set organization_id = '00000000-0000-4000-8000-000000000007';
update public.agents                set organization_id = '00000000-0000-4000-8000-000000000007';
update public.prospects             set organization_id = '00000000-0000-4000-8000-000000000007';
update public.messages              set organization_id = '00000000-0000-4000-8000-000000000007';
update public.agent_status_log      set organization_id = '00000000-0000-4000-8000-000000000007';
update public.automations           set organization_id = '00000000-0000-4000-8000-000000000007';
update public.availability_settings set organization_id = '00000000-0000-4000-8000-000000000007';
update public.catalog_files         set organization_id = '00000000-0000-4000-8000-000000000007';
update public.custom_fields         set organization_id = '00000000-0000-4000-8000-000000000007';
update public.products              set organization_id = '00000000-0000-4000-8000-000000000007';
update public.roles                 set organization_id = '00000000-0000-4000-8000-000000000007';

-- El dashboard solo necesita saber si hay clave de IA, no la clave. Con esta
-- columna el cliente deja de leer ai_api_key (el lockdown revoca su select).
alter table public.vendors
  add column ai_key_set boolean generated always as (coalesce(ai_api_key, '') <> '') stored;

-- Constraints que pasan a ser por empresa.
alter table public.roles drop constraint roles_name_key;
alter table public.roles add constraint roles_org_name_key unique (organization_id, name);

-- availability_settings deja de ser singleton: una fila por empresa. La
-- columna `id` se conserva (sin restricciones) hasta el lockdown para que el
-- panel actual, que la filtra por 'default', siga funcionando.
alter table public.availability_settings drop constraint availability_settings_singleton;
alter table public.availability_settings drop constraint availability_settings_pkey;
alter table public.availability_settings add primary key (organization_id);

-- Las hijas ya son not null (el trigger de abajo cubre las filas nuevas). Las
-- raíz quedan nullable hasta el lockdown: el panel actual (anon) insertaría
-- NULL, y esas filas se pliegan a 007 en la migración 2.
alter table public.prospects        alter column organization_id set not null;
alter table public.messages         alter column organization_id set not null;
alter table public.agent_status_log alter column organization_id set not null;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;

-- ── Helpers (security definer ⇒ leen sin RLS, sin recursión) ─────────────────

create or replace function public.current_profile()
returns table (id uuid, organization_id uuid, user_type text, is_super_admin boolean, agent_id uuid)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.organization_id, p.user_type, p.is_super_admin, p.agent_id
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  left join public.agents a on a.id = p.agent_id
  where p.id = auth.uid()
    and p.is_active
    and o.is_active
    and (p.user_type <> 'vendedor' or a.access_expires_at is null or a.access_expires_at >= current_date);
$$;

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = ''
as $$ select organization_id from public.current_profile(); $$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select is_super_admin from public.current_profile()), false); $$;

create or replace function public.is_org_admin()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select user_type = 'admin' or is_super_admin from public.current_profile()), false); $$;

create or replace function public.current_agent_id()
returns uuid language sql stable security definer set search_path = ''
as $$ select agent_id from public.current_profile(); $$;

create or replace function public.has_permission(p text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case
      when cp.user_type = 'admin' or cp.is_super_admin then true
      else exists (
        select 1
        from public.agents a
        join public.roles r on r.id = a.role_id
        where a.id = cp.agent_id and p = any (r.permissions)
      )
    end
    from public.current_profile() cp
  ), false);
$$;

-- Regla de visibilidad del vendedor: canales asignados a él o leads prestados
-- a él (misma semántica que prospect_inbox.effective_agent_id).
create or replace function public.can_access_prospect(v_id uuid, handled_by uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select v.organization_id = cp.organization_id
       and (cp.user_type = 'admin' or cp.is_super_admin
            or handled_by = cp.agent_id
            or v.assigned_agent_id = cp.agent_id)
    from public.current_profile() cp
    join public.vendors v on v.id = v_id
  ), false);
$$;

create or replace function public.can_access_prospect_id(p_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select public.can_access_prospect(p.vendor_id, p.handled_by_agent_id)
    from public.prospects p where p.id = p_id
  ), false);
$$;

create or replace function public.agent_in_my_org(a_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select a_id is null or exists (
    select 1 from public.agents a where a.id = a_id and a.organization_id = public.current_org_id()
  );
$$;

create or replace function public.role_in_my_org(r_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select r_id is null or exists (
    select 1 from public.roles r where r.id = r_id and r.organization_id = public.current_org_id()
  );
$$;

create or replace function public.vendors_in_my_org(v_ids uuid[])
returns boolean language sql stable security definer set search_path = ''
as $$
  select v_ids is null or not exists (
    select 1
    from unnest(v_ids) x(id)
    left join public.vendors v on v.id = x.id
    where v.id is null or v.organization_id is distinct from public.current_org_id()
  );
$$;

revoke execute on function public.current_profile()                from public, anon;
revoke execute on function public.current_org_id()                 from public, anon;
revoke execute on function public.is_super_admin()                 from public, anon;
revoke execute on function public.is_org_admin()                   from public, anon;
revoke execute on function public.current_agent_id()               from public, anon;
revoke execute on function public.has_permission(text)             from public, anon;
revoke execute on function public.can_access_prospect(uuid, uuid)  from public, anon;
revoke execute on function public.can_access_prospect_id(uuid)     from public, anon;
revoke execute on function public.agent_in_my_org(uuid)            from public, anon;
revoke execute on function public.role_in_my_org(uuid)             from public, anon;
revoke execute on function public.vendors_in_my_org(uuid[])        from public, anon;

grant execute on function public.current_profile()                to authenticated, service_role;
grant execute on function public.current_org_id()                 to authenticated, service_role;
grant execute on function public.is_super_admin()                 to authenticated, service_role;
grant execute on function public.is_org_admin()                   to authenticated, service_role;
grant execute on function public.current_agent_id()               to authenticated, service_role;
grant execute on function public.has_permission(text)             to authenticated, service_role;
grant execute on function public.can_access_prospect(uuid, uuid)  to authenticated, service_role;
grant execute on function public.can_access_prospect_id(uuid)     to authenticated, service_role;
grant execute on function public.agent_in_my_org(uuid)            to authenticated, service_role;
grant execute on function public.role_in_my_org(uuid)             to authenticated, service_role;
grant execute on function public.vendors_in_my_org(uuid[])        to authenticated, service_role;

-- ── Defaults en tablas raíz ──────────────────────────────────────────────────

alter table public.vendors       alter column organization_id set default public.current_org_id();
alter table public.agents        alter column organization_id set default public.current_org_id();
alter table public.automations   alter column organization_id set default public.current_org_id();
alter table public.catalog_files alter column organization_id set default public.current_org_id();
alter table public.custom_fields alter column organization_id set default public.current_org_id();
alter table public.products      alter column organization_id set default public.current_org_id();
alter table public.roles         alter column organization_id set default public.current_org_id();

-- ── Triggers: empresa derivada del padre en tablas hijas ─────────────────────

create or replace function public.set_org_from_vendor()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select v.organization_id into new.organization_id from public.vendors v where v.id = new.vendor_id;
  if new.organization_id is null then
    raise exception 'El canal % no existe o no tiene empresa', new.vendor_id;
  end if;
  return new;
end;
$$;

create or replace function public.set_org_from_prospect()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select p.organization_id into new.organization_id from public.prospects p where p.id = new.prospect_id;
  if new.organization_id is null then
    raise exception 'El prospecto % no existe o no tiene empresa', new.prospect_id;
  end if;
  return new;
end;
$$;

create or replace function public.set_org_from_agent()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select a.organization_id into new.organization_id from public.agents a where a.id = new.agent_id;
  if new.organization_id is null then
    raise exception 'El vendedor % no existe o no tiene empresa', new.agent_id;
  end if;
  return new;
end;
$$;

create trigger prospects_set_org        before insert on public.prospects        for each row execute function public.set_org_from_vendor();
create trigger messages_set_org         before insert on public.messages         for each row execute function public.set_org_from_prospect();
create trigger agent_status_log_set_org before insert on public.agent_status_log for each row execute function public.set_org_from_agent();

-- ── Trigger: límite de canales por empresa (aplica a cualquier rol) ──────────

create or replace function public.enforce_channel_limit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_max integer;
  v_count integer;
begin
  -- Hasta el lockdown el panel viejo (anon) inserta sin empresa; no se limita.
  if new.organization_id is null then
    return new;
  end if;
  select o.max_channels into v_max from public.organizations o where o.id = new.organization_id;
  select count(*) into v_count from public.vendors v where v.organization_id = new.organization_id;
  if v_max is not null and v_count >= v_max then
    raise exception 'LIMITE_CANALES:%', v_max using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger vendors_enforce_channel_limit before insert on public.vendors
  for each row execute function public.enforce_channel_limit();

-- ── Trigger: un vendedor solo puede cambiar su propio estado ─────────────────
-- Evita que, con la política de update sobre su propia fila, se auto-asigne
-- role_id (escalada de permisos) o cambie su vencimiento de acceso.

create or replace function public.agents_guard_self_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new; -- service_role / postgres / anon (hasta el lockdown)
  end if;
  if public.has_permission('users.manage_users') then
    return new;
  end if;
  if new.id <> old.id
     or new.name is distinct from old.name
     or new.email is distinct from old.email
     or new.phone is distinct from old.phone
     or new.priority is distinct from old.priority
     or new.access_expires_at is distinct from old.access_expires_at
     or new.role_id is distinct from old.role_id
     or new.organization_id is distinct from old.organization_id
  then
    raise exception 'Solo puedes cambiar tu propio estado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger agents_guard_self_update before update on public.agents
  for each row execute function public.agents_guard_self_update();

-- ── Seed por empresa nueva: roles base + fila de availability_settings ───────

create or replace function public.seed_organization()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.roles (organization_id, name, permissions, is_system) values
    (new.id, 'Administrador', array[
      'leads.view','leads.edit','leads.assign','leads.create_contacts','leads.manage_tags',
      'messaging.view_broadcasts','messaging.send_broadcasts','messaging.manage_templates','messaging.manage_automations',
      'agenda.view_priority_queue','agenda.manage',
      'analytics.dashboard','analytics.ai_usage',
      'config.manage_channels','config.migrate_channels','config.ai_settings','config.alerts','config.products',
      'users.manage_users','users.manage_roles'
    ], true),
    (new.id, 'Vendedores', array[
      'leads.view','leads.edit','leads.create_contacts','leads.manage_tags',
      'messaging.view_broadcasts','messaging.manage_automations',
      'agenda.view_priority_queue','agenda.manage',
      'analytics.dashboard','analytics.ai_usage'
    ], false);
  insert into public.availability_settings (organization_id) values (new.id);
  return new;
end;
$$;

-- Se crea DESPUÉS de insertar 007 para no sembrarla dos veces.
create trigger organizations_seed after insert on public.organizations
  for each row execute function public.seed_organization();

-- 007 ya tiene sus 2 roles y su fila de settings (backfill). El rol
-- "Vendedores" pasa a la plantilla vendedor (10 permisos): con los 2 de
-- Analítica que tenía, un vendedor no vería ni sus leads.
update public.roles
set permissions = array[
  'leads.view','leads.edit','leads.create_contacts','leads.manage_tags',
  'messaging.view_broadcasts','messaging.manage_automations',
  'agenda.view_priority_queue','agenda.manage',
  'analytics.dashboard','analytics.ai_usage'
]
where organization_id = '00000000-0000-4000-8000-000000000007' and name = 'Vendedores';

update public.agents
set role_id = (
  select id from public.roles
  where organization_id = '00000000-0000-4000-8000-000000000007' and name = 'Vendedores'
)
where organization_id = '00000000-0000-4000-8000-000000000007' and role_id is null;

-- ── Políticas para `authenticated` ───────────────────────────────────────────
-- Conviven con las `anon` hasta el lockdown. `(select fn())` ⇒ InitPlan: se
-- evalúa una vez por sentencia, no por fila.

-- organizations
create policy org_select on public.organizations for select to authenticated
  using (id = (select public.current_org_id()) or (select public.is_super_admin()));

-- profiles (escrituras solo vía admin-users con service_role)
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or (organization_id = (select public.current_org_id()) and (select public.is_org_admin()))
    or (select public.is_super_admin())
  );

-- vendors: legible por toda la empresa (prospect_inbox hace join vendors)
create policy vendors_select on public.vendors for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy vendors_insert on public.vendors for insert to authenticated
  with check (
    organization_id = (select public.current_org_id())
    and (select public.has_permission('config.manage_channels'))
    and (select public.agent_in_my_org(assigned_agent_id))
  );
create policy vendors_update on public.vendors for update to authenticated
  using (
    organization_id = (select public.current_org_id())
    and ((select public.has_permission('config.manage_channels')) or (select public.has_permission('config.ai_settings')))
  )
  with check (
    organization_id = (select public.current_org_id())
    and (select public.agent_in_my_org(assigned_agent_id))
  );
create policy vendors_delete on public.vendors for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.manage_channels')));

-- agents
create policy agents_select on public.agents for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy agents_insert on public.agents for insert to authenticated
  with check (
    organization_id = (select public.current_org_id())
    and (select public.has_permission('users.manage_users'))
    and (select public.role_in_my_org(role_id))
  );
create policy agents_update on public.agents for update to authenticated
  using (
    organization_id = (select public.current_org_id())
    and ((select public.has_permission('users.manage_users')) or id = (select public.current_agent_id()))
  )
  with check (
    organization_id = (select public.current_org_id())
    and (select public.role_in_my_org(role_id))
  );
create policy agents_delete on public.agents for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('users.manage_users')));

-- prospects (insert/delete solo desde Edge Functions con service_role)
create policy prospects_select on public.prospects for select to authenticated
  using (public.can_access_prospect(vendor_id, handled_by_agent_id));
create policy prospects_update on public.prospects for update to authenticated
  using (
    public.can_access_prospect(vendor_id, handled_by_agent_id)
    and ((select public.has_permission('leads.edit')) or (select public.has_permission('leads.assign')))
  )
  with check (
    public.can_access_prospect(vendor_id, handled_by_agent_id)
    and (select public.agent_in_my_org(handled_by_agent_id))
  );

-- messages (escribe send-message con service_role)
create policy messages_select on public.messages for select to authenticated
  using (public.can_access_prospect_id(prospect_id));

-- agent_status_log
create policy agent_status_log_select on public.agent_status_log for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy agent_status_log_insert on public.agent_status_log for insert to authenticated
  with check (
    organization_id = (select public.current_org_id())
    and (agent_id = (select public.current_agent_id()) or (select public.has_permission('users.manage_users')))
  );
create policy agent_status_log_update on public.agent_status_log for update to authenticated
  using (
    organization_id = (select public.current_org_id())
    and (agent_id = (select public.current_agent_id()) or (select public.has_permission('users.manage_users')))
  );

-- availability_settings
create policy availability_settings_select on public.availability_settings for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy availability_settings_update on public.availability_settings for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.alerts')));

-- automations
create policy automations_select on public.automations for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy automations_insert on public.automations for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('messaging.manage_automations')));
create policy automations_update on public.automations for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('messaging.manage_automations')));
create policy automations_delete on public.automations for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('messaging.manage_automations')));

-- products
create policy products_select on public.products for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy products_insert on public.products for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('config.products')));
create policy products_update on public.products for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.products')));
create policy products_delete on public.products for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.products')));

-- catalog_files
create policy catalog_files_select on public.catalog_files for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy catalog_files_insert on public.catalog_files for insert to authenticated
  with check (
    organization_id = (select public.current_org_id())
    and (select public.has_permission('config.products'))
    and (select public.vendors_in_my_org(vendor_ids))
  );
create policy catalog_files_update on public.catalog_files for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.products')))
  with check (organization_id = (select public.current_org_id()) and (select public.vendors_in_my_org(vendor_ids)));
create policy catalog_files_delete on public.catalog_files for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('config.products')));

-- custom_fields
create policy custom_fields_select on public.custom_fields for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy custom_fields_insert on public.custom_fields for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('leads.edit')));
create policy custom_fields_update on public.custom_fields for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('leads.edit')));
create policy custom_fields_delete on public.custom_fields for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('leads.edit')));

-- roles (los de sistema son inmutables desde el cliente)
create policy roles_select on public.roles for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy roles_insert on public.roles for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('users.manage_roles')) and not is_system);
create policy roles_update on public.roles for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('users.manage_roles')) and not is_system)
  with check (organization_id = (select public.current_org_id()) and not is_system);
create policy roles_delete on public.roles for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('users.manage_roles')) and not is_system);

-- storage: subida solo bajo el prefijo de la propia empresa. La lectura sigue
-- siendo pública (buckets.public = true): Evolution/Meta descargan el media
-- por URL pública para enviarlo por WhatsApp.
create policy authenticated_upload_chat_media on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = (select public.current_org_id())::text
  );

grant select on public.prospect_inbox to authenticated;
