-- Secciones habilitadas por empresa.
--
-- Al dar acceso a una empresa el dueño de la plataforma decide qué módulos del CRM
-- puede usar (por ejemplo, vender un plan sin Agenda ni Automatización). Canales y
-- Configuración son el núcleo y siempre están. enabled_sections es la lista de
-- módulos opcionales activos; null = todos (así las empresas existentes no cambian).
--
-- Es una restricción comercial, no de seguridad: el aislamiento de datos entre
-- empresas sigue siendo RLS. El panel oculta lo no contratado y las funciones que
-- respaldan un módulo (autocompletar productos, detección de citas) se niegan a
-- trabajar para esa empresa.
--
-- Las claves deben coincidir con PLAN_SECTIONS en dashboard/app.js y con
-- supabase/functions/_shared/sections.ts.

alter table public.organizations
  add column if not exists enabled_sections text[],
  add constraint organizations_enabled_sections_check check (
    enabled_sections is null
    or enabled_sections <@ array['dashboard', 'agenda', 'bandeja-global', 'leads', 'productos', 'catalogo-ia', 'automatizacion', 'disponibilidad']::text[]
  );

-- El panel lee las secciones de su propia empresa.
grant select (enabled_sections) on public.organizations to authenticated;

-- org_usage también dice si la Agenda está contratada (la detección de citas la consulta).
create or replace function public.org_usage(p_org uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'ai_used', (
      select count(*) from public.messages m
      where m.organization_id = p_org and m.by_ai
        and m.created_at >= (date_trunc('month', now() at time zone 'America/Lima') at time zone 'America/Lima')
    ),
    'ai_max', o.max_ai_messages,
    'storage_bytes', coalesce((
      select sum((so.metadata ->> 'size')::bigint) from storage.objects so
      where so.bucket_id = 'chat-media' and (storage.foldername(so.name))[1] = p_org::text
    ), 0),
    'storage_max_bytes', o.max_storage_mb::bigint * 1024 * 1024,
    'plan_active', o.is_active
      and (o.plan_expires_at is null or o.plan_expires_at >= (now() at time zone 'America/Lima')::date),
    'agenda_enabled', o.enabled_sections is null or 'agenda' = any (o.enabled_sections)
  )
  from public.organizations o where o.id = p_org;
$$;
