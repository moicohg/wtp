-- Lockdown multi-empresa: cierra el acceso `anon` y ajusta los grants de
-- `authenticated`. Correr SOLO con el frontend nuevo (login) y las Edge
-- Functions con sesión ya en vivo. Los webhooks usan service_role y no se ven
-- afectados.

-- ── 1. Filas del panel viejo sin empresa → 007; organization_id definitivo ──

update public.vendors       set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.agents        set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.automations   set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.catalog_files set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.custom_fields set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.products      set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;
update public.roles         set organization_id = '00000000-0000-4000-8000-000000000007' where organization_id is null;

alter table public.vendors       alter column organization_id set not null;
alter table public.agents        alter column organization_id set not null;
alter table public.automations   alter column organization_id set not null;
alter table public.catalog_files alter column organization_id set not null;
alter table public.custom_fields alter column organization_id set not null;
alter table public.products      alter column organization_id set not null;
alter table public.roles         alter column organization_id set not null;

-- Ya no hay panel que filtre availability_settings por id = 'default'.
alter table public.availability_settings drop column id;

-- ── 2. Políticas anon (todas las de la era sin login) ────────────────────────

drop policy if exists anon_select_vendors on public.vendors;
drop policy if exists anon_insert_vendors on public.vendors;
drop policy if exists anon_update_vendors on public.vendors;
drop policy if exists anon_delete_vendors on public.vendors;
drop policy if exists anon_select_prospects on public.prospects;
drop policy if exists anon_update_prospects_management on public.prospects;
drop policy if exists anon_select_messages on public.messages;
drop policy if exists anon_select_agents on public.agents;
drop policy if exists anon_insert_agents on public.agents;
drop policy if exists anon_update_agents on public.agents;
drop policy if exists anon_delete_agents on public.agents;
drop policy if exists anon_select_custom_fields on public.custom_fields;
drop policy if exists anon_insert_custom_fields on public.custom_fields;
drop policy if exists anon_select_products on public.products;
drop policy if exists anon_insert_products on public.products;
drop policy if exists anon_update_products on public.products;
drop policy if exists anon_delete_products on public.products;
drop policy if exists anon_select_catalog_files on public.catalog_files;
drop policy if exists anon_insert_catalog_files on public.catalog_files;
drop policy if exists anon_update_catalog_files on public.catalog_files;
drop policy if exists anon_delete_catalog_files on public.catalog_files;
drop policy if exists anon_select_automations on public.automations;
drop policy if exists anon_insert_automations on public.automations;
drop policy if exists anon_update_automations on public.automations;
drop policy if exists anon_delete_automations on public.automations;
drop policy if exists anon_select_agent_status_log on public.agent_status_log;
drop policy if exists anon_insert_agent_status_log on public.agent_status_log;
drop policy if exists anon_update_agent_status_log on public.agent_status_log;
drop policy if exists anon_select_availability_settings on public.availability_settings;
drop policy if exists anon_update_availability_settings on public.availability_settings;
drop policy if exists anon_select_roles on public.roles;
drop policy if exists anon_insert_roles on public.roles;
drop policy if exists anon_update_roles on public.roles;
drop policy if exists anon_delete_roles on public.roles;
drop policy if exists anon_upload_chat_media on storage.objects;
drop policy if exists anon_read_chat_media on storage.objects;

-- ── 3. anon sin privilegios en public (la clave publicable solo sirve para
--       Auth). También para objetos futuros. ─────────────────────────────────

revoke all privileges on all tables    in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all functions in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- ── 4. authenticated: solo lo que el panel usa ───────────────────────────────

revoke truncate, references, trigger on all tables in schema public from authenticated;

-- organizations / profiles: se escriben solo desde admin-users (service_role).
revoke insert, update, delete on public.organizations from authenticated;
revoke insert, update, delete on public.profiles      from authenticated;

-- messages: las escribe send-message / los webhooks (service_role).
revoke insert, update, delete on public.messages from authenticated;

-- prospects: los crea la IA (webhooks); el panel solo edita columnas
-- "humanas". score/label/paso/reintentos siguen siendo de la IA.
revoke insert, update, delete on public.prospects from authenticated;
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'prospects'
    and column_name not in (
      'id', 'vendor_id', 'phone', 'organization_id', 'created_at', 'updated_at',
      'score', 'label', 'conversation_step', 'retries_current_step', 'evasive_count'
    );
  execute format('grant update (%s) on public.prospects to authenticated', cols);
end;
$$;

-- ── 5. vendors: el cliente no lee los secretos (ai_api_key, meta_access_token) ─

revoke select on public.vendors from authenticated;
grant select (
  id, name, phone_number, channel_type, evolution_instance_id, meta_phone_number_id, meta_waba_id, meta_verified,
  ai_provider, ai_model, ai_key_set, system_prompt, assigned_agent_id, keywords, organization_id, created_at, updated_at
) on public.vendors to authenticated;
