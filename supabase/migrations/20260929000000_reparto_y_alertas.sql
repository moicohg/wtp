-- Fase 2 de ventas: reparto automático de leads y alerta de lead sin respuesta.
--
-- Cada empresa elige cómo trabaja su equipo con availability_settings.smart_assignment_enabled:
--   false (por defecto) = "cada asesor es dueño": el lead queda con el asesor del canal por el que
--                         entró y NUNCA se deriva a otro, aunque esté fuera de línea o con cola.
--   true                = "equipo": al entrar un lead nuevo se le asigna (handled_by_agent_id) el
--                         asesor "listo" con menos carga según su prioridad. Si nadie está listo,
--                         se queda con el asesor del canal.
-- Las alertas (alert_*) funcionan en ambos modos: avisan al asesor responsable del lead.

-- ── Marcas internas de alerta (solo las escribe lead-alerts con service_role) ─
-- Guardan "para qué espera" se avisó: si la persona responde y el lead vuelve a esperar,
-- la fecha de espera cambia y se puede avisar otra vez.
alter table public.prospects
  add column if not exists alerted_agent_for timestamptz,
  add column if not exists alerted_owner_for timestamptz;

-- ── Reparto automático ───────────────────────────────────────────────────────

-- Elige al asesor "listo" menos cargado de la empresa; null si nadie puede recibirlo.
-- Carga = chats abiertos que ya tiene / prioridad (1-10): más prioridad, más leads.
create or replace function public.pick_agent_for_new_lead(p_org uuid)
returns uuid language sql stable security definer set search_path = ''
as $$
  select a.id
  from public.agents a
  where a.organization_id = p_org
    and a.status = 'listo'
    and (a.access_expires_at is null or a.access_expires_at >= (now() at time zone 'America/Lima')::date)
    and not exists (select 1 from public.profiles pr where pr.agent_id = a.id and not pr.is_active)
  order by
    (select count(*)
       from public.prospects p
       join public.vendors v on v.id = p.vendor_id
      where coalesce(p.handled_by_agent_id, v.assigned_agent_id) = a.id
        and p.estado_conversacion = 'activo'
        and coalesce(p.etapa, '') not in ('venta', 'perdido')
        and p.label is distinct from 'DESCARTADO')::numeric / a.priority,
    a.priority desc,
    a.status_updated_at
  limit 1;
$$;
revoke all on function public.pick_agent_for_new_lead(uuid) from public, anon, authenticated;
grant execute on function public.pick_agent_for_new_lead(uuid) to service_role;

create or replace function public.assign_new_prospect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_owner uuid;
  v_pick uuid;
begin
  if new.handled_by_agent_id is not null then
    return new;
  end if;
  select organization_id, assigned_agent_id into v_org, v_owner from public.vendors where id = new.vendor_id;
  if not coalesce((select s.smart_assignment_enabled from public.availability_settings s where s.organization_id = v_org), false) then
    return new; -- modo "cada asesor es dueño": no se deriva
  end if;
  v_pick := public.pick_agent_for_new_lead(v_org);
  if v_pick is not null and v_pick is distinct from v_owner then
    new.handled_by_agent_id := v_pick;
  end if;
  return new;
end;
$$;
revoke all on function public.assign_new_prospect() from public, anon, authenticated;

drop trigger if exists assign_new_prospect on public.prospects;
create trigger assign_new_prospect
  before insert on public.prospects
  for each row execute function public.assign_new_prospect();

-- Solo el administrador de la empresa decide el modo de reparto. Otro rol con config.alerts puede
-- ajustar las alertas, pero no cambiar cómo se reparten los leads. Edge Functions y migraciones
-- (sin sesión de usuario) quedan fuera de la regla.
create or replace function public.guard_assignment_mode()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.smart_assignment_enabled is distinct from old.smart_assignment_enabled
     and auth.uid() is not null and not public.is_org_admin() then
    raise exception 'SOLO_ADMIN: solo el administrador de la empresa puede cambiar el modo de reparto de leads';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_assignment_mode() from public, anon, authenticated;

drop trigger if exists guard_assignment_mode on public.availability_settings;
create trigger guard_assignment_mode
  before update on public.availability_settings
  for each row execute function public.guard_assignment_mode();

-- ── Leads calificados esperando respuesta de una persona ─────────────────────

-- Devuelve los leads que ya superaron el tiempo de alerta de su empresa y a quién toca avisar.
-- "Esperando" = el cliente escribió después de la última respuesta humana (las del bot no cuentan).
-- need_agent: toca avisar al asesor responsable. need_owner: toca escalar a los números de la
-- empresa (a los 2 × alert_minutes, o de inmediato si no hay a quién avisar entre los asesores).
create or replace function public.leads_waiting_for_reply()
returns table (
  prospect_id uuid, organization_id uuid, vendor_id uuid, vendor_name text,
  lead_name text, lead_phone text, waiting_since timestamptz, waiting_minutes integer,
  agent_name text, agent_phone text, alert_phones text[], need_agent boolean, need_owner boolean
)
language sql stable security definer set search_path = ''
as $$
  with w as (
    select p.id, p.organization_id, p.vendor_id, p.nombre, p.phone, p.alerted_agent_for, p.alerted_owner_for,
           s.alert_minutes, s.alert_phones,
           (select min(m.created_at) from public.messages m
             where m.prospect_id = p.id and m.role = 'user'
               and m.created_at > coalesce((select max(h.created_at) from public.messages h
                                             where h.prospect_id = p.id and h.role = 'assistant' and not h.by_ai),
                                           '-infinity')) as since,
           coalesce(p.handled_by_agent_id, v.assigned_agent_id) as agent_id,
           v.name as vendor_name, p.snoozed_until, p.attended_at
    from public.prospects p
    join public.vendors v on v.id = p.vendor_id
    join public.availability_settings s on s.organization_id = p.organization_id and s.alert_enabled
    join public.organizations o on o.id = p.organization_id
    where p.label = 'CALIFICADO'
      and p.estado_conversacion = 'activo'
      and coalesce(p.etapa, '') not in ('venta', 'perdido')
      and o.is_active
      and (o.plan_expires_at is null or o.plan_expires_at >= (now() at time zone 'America/Lima')::date)
  )
  select w.id, w.organization_id, w.vendor_id, w.vendor_name,
         coalesce(nullif(w.nombre, ''), w.phone), w.phone, w.since,
         (extract(epoch from now() - w.since) / 60)::integer,
         a.name, a.phone, w.alert_phones,
         w.alerted_agent_for is distinct from w.since
           and now() - w.since >= make_interval(mins => w.alert_minutes),
         w.alerted_owner_for is distinct from w.since
           and cardinality(w.alert_phones) > 0
           and now() - w.since >= make_interval(mins => case when coalesce(a.phone, '') = '' then 1 else 2 end * w.alert_minutes)
  from w
  left join public.agents a on a.id = w.agent_id
  where w.since is not null
    and (w.snoozed_until is null or w.snoozed_until <= now())
    and (w.attended_at is null or w.attended_at < w.since)
    and now() - w.since >= make_interval(mins => w.alert_minutes);
$$;
revoke all on function public.leads_waiting_for_reply() from public, anon, authenticated;
grant execute on function public.leads_waiting_for_reply() to service_role;

-- ── Revisión cada minuto ─────────────────────────────────────────────────────
-- Mismo secreto compartido que purge-media (cron_secret en Vault).
select cron.unschedule('lead-alerts') where exists (select 1 from cron.job where jobname = 'lead-alerts');
select cron.schedule(
  'lead-alerts',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://znalzptpffnbnzuckiid.supabase.co/functions/v1/lead-alerts',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
