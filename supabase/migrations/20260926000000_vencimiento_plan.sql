-- Fecha de vencimiento del plan por empresa.
--
-- Hasta ahora una empresa solo se podía activar o desactivar a mano, así que
-- cobrar dependía de acordarse de apagarla. plan_expires_at es el último día
-- (inclusive, hora de Lima) en que la empresa puede usar el CRM; null = sin
-- vencimiento. Se aplica en current_profile(), el filtro que usan todas las
-- políticas RLS: una empresa vencida deja de ver o escribir datos desde el
-- primer día siguiente, sin cron ni intervención. Renovar es mover la fecha.
--
-- El super-admin queda exento para que el dueño de la plataforma nunca se
-- bloquee a sí mismo. El bot de IA también se detiene (org_usage.plan_active).

alter table public.organizations add column if not exists plan_expires_at date;

-- El panel lee la fecha de su propia empresa para avisar y bloquear.
grant select (plan_expires_at) on public.organizations to authenticated;

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
    and (p.is_super_admin
         or o.plan_expires_at is null
         or o.plan_expires_at >= (now() at time zone 'America/Lima')::date)
    and (p.user_type <> 'vendedor' or a.access_expires_at is null or a.access_expires_at >= current_date);
$$;

-- org_usage ahora también dice si el plan está vigente (activa y no vencida).
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
      and (o.plan_expires_at is null or o.plan_expires_at >= (now() at time zone 'America/Lima')::date)
  )
  from public.organizations o where o.id = p_org;
$$;
