-- Motor de cadencias: envía por WhatsApp cada paso de las automatizaciones a los leads inscritos.
--
-- Reglas (las aplica la Edge Function automation-runner, que corre cada 5 minutos con pg_cron):
--  * Solo envía las cadencias en estado "activa". En borrador o pausada no sale nada.
--  * El paso de "día N, hora H" sale N días después de la fecha de inscripción, a la hora H de Lima
--    (el día 1 es mañana, así se puede sacar al lead antes de que salga el primer mensaje).
--  * Si un paso no se pudo enviar en 12 h (canal caído, ventana de 24 h de Meta) se omite.
--  * El lead sale de la cadencia si queda perdido/descartado, si su chat deja de estar activo o si
--    llega a "por depositar" o "venta", salvo que la cadencia ignore la salida por conversión.
-- Los mensajes quedan en el chat marcados como automáticos para que no cuenten como respuesta de
-- una persona en la alerta de lead sin respuesta.

alter table public.automation_enrollments
  add column if not exists current_step integer not null default 0,
  add column if not exists last_sent_at timestamptz,
  add column if not exists last_error text,
  add column if not exists ended_at timestamptz,
  add column if not exists exit_reason text;

alter table public.messages add column if not exists by_automation boolean not null default false;

-- Pasos que ya les toca salir (o inscripciones que ya terminaron todos sus pasos).
-- Solo la usa el runner (service_role).
create or replace function public.due_automation_steps()
returns table (
  enrollment_id uuid, prospect_id uuid, vendor_id uuid, step_index integer, step jsonb,
  scheduled_at timestamptz, ignore_exit boolean,
  etapa text, label text, estado text, nombre text, phone text
)
language sql stable security definer set search_path = ''
as $$
  select e.id, e.prospect_id, p.vendor_id, e.current_step, s.step, s.scheduled_at, a.ignore_exit_on_conversion,
         p.etapa, p.label, p.estado_conversacion, p.nombre, p.phone
  from public.automation_enrollments e
  join public.automations a on a.id = e.automation_id and a.status = 'activa'
  join public.prospects p on p.id = e.prospect_id
  join public.organizations o on o.id = e.organization_id
  cross join lateral (
    select st as step,
           (((e.enrolled_at at time zone 'America/Lima')::date + coalesce((st ->> 'day')::integer, 1))::timestamp
             + make_interval(hours => least(23, greatest(0, coalesce((st ->> 'hour')::integer, 10)))))
             at time zone 'America/Lima' as scheduled_at
    from (select a.steps -> e.current_step as st) x
  ) s
  where e.status = 'activa'
    and o.is_active
    and (o.plan_expires_at is null or o.plan_expires_at >= (now() at time zone 'America/Lima')::date)
    and (s.step is null or now() >= s.scheduled_at)
  order by e.enrolled_at
  limit 200;
$$;
revoke all on function public.due_automation_steps() from public, anon, authenticated;
grant execute on function public.due_automation_steps() to service_role;

-- Las respuestas automáticas no cuentan como "respuesta humana" para la alerta de lead sin respuesta.
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
                                             where h.prospect_id = p.id and h.role = 'assistant' and not h.by_ai and not h.by_automation),
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

-- Revisión cada 5 minutos. Mismo secreto compartido que purge-media y lead-alerts (cron_secret en Vault).
select cron.unschedule('automation-runner') where exists (select 1 from cron.job where jobname = 'automation-runner');
select cron.schedule(
  'automation-runner',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://znalzptpffnbnzuckiid.supabase.co/functions/v1/automation-runner',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
