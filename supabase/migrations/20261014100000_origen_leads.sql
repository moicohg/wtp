-- Origen del lead: de dónde vino (anuncio de Facebook, campo/calle, referido u otro).
--
-- Permite saber qué canal de captación rinde y medir el embudo por origen en Métricas.
--   facebook_ads  lo marca solo el CRM cuando el primer mensaje llega desde un anuncio de
--                 click-a-WhatsApp (referral de Meta / externalAdReply de Evolution)
--   campo         captado en la calle o en campo; lo marca la persona
--   referido      lo recomendó alguien; lo marca la persona
--   otro          cualquier otra fuente; lo marca la persona
-- null = sin clasificar. La detección automática solo rellena el origen si está vacío, nunca pisa
-- lo que una persona ya eligió. origen_detalle guarda el titular del anuncio, el nombre de quien
-- refirió o la zona de campo.

alter table public.prospects
  add column if not exists origen text,
  add column if not exists origen_detalle text;

alter table public.prospects
  add constraint prospects_origen_check check (origen is null or origen in ('facebook_ads', 'campo', 'referido', 'otro'));

-- Lo edita la persona desde el panel (la detección automática escribe con service_role).
grant update (origen, origen_detalle) on public.prospects to authenticated;

-- La vista expone p.*; hay que recrearla para que incluya las columnas nuevas.
drop view if exists public.prospect_inbox;
create view public.prospect_inbox
with (security_invoker = true) as
select
  p.*,
  v.name as vendor_name,
  v.assigned_agent_id as vendor_agent_id,
  coalesce(ha.name, va.name) as handled_by_name,
  coalesce(p.handled_by_agent_id, v.assigned_agent_id) as effective_agent_id,
  (p.handled_by_agent_id is not null and p.handled_by_agent_id is distinct from v.assigned_agent_id) as is_prestado,
  lm.content as last_message,
  lm.role as last_message_role,
  lm.created_at as last_message_at
from public.prospects p
join public.vendors v on v.id = p.vendor_id
left join public.agents ha on ha.id = p.handled_by_agent_id
left join public.agents va on va.id = v.assigned_agent_id
left join lateral (
  select m.content, m.role, m.created_at
  from public.messages m
  where m.prospect_id = p.id
  order by m.created_at desc
  limit 1
) lm on true;
revoke all on public.prospect_inbox from anon;
grant select on public.prospect_inbox to authenticated;

-- ── Embudo por origen ────────────────────────────────────────────────────────
-- metrics_daily agrega la columna origen (null = sin clasificar). Los ajustes manuales no tienen
-- origen: quedan como "sin clasificar". Cambia el tipo de retorno, así que se recrea.

drop function if exists public.metrics_daily(uuid, date, date);
create function public.metrics_daily(p_org uuid, p_from date, p_to date)
returns table (
  day date, agent_id uuid, origen text,
  leads integer, responde integer, agendo integer, asistio integer, separo integer, ventas integer
)
language sql stable security invoker set search_path = ''
as $$
  with base as (
    select p.id, p.created_at, p.origen, coalesce(p.handled_by_agent_id, v.assigned_agent_id) as agent_id
    from public.prospects p
    join public.vendors v on v.id = p.vendor_id
    where p.organization_id = p_org
  ),
  stages as (
    select l.prospect_id,
           min(l.created_at) as separo_at,
           min(l.created_at) filter (where l.etapa = 'venta') as venta_at
    from public.prospect_stage_log l
    where l.organization_id = p_org
    group by l.prospect_id
  ),
  ev as (
    select b.agent_id, b.origen, (b.created_at at time zone 'America/Lima')::date as day, 'leads'::text as stage, 1 as qty
      from base b
    union all
    select b.agent_id, b.origen, (m.first_at at time zone 'America/Lima')::date, 'responde', 1
      from base b
      cross join lateral (
        select min(x.created_at) as first_at from public.messages x where x.prospect_id = b.id and x.role = 'user'
      ) m
      where m.first_at is not null
    union all
    select b.agent_id, b.origen, (a.created_at at time zone 'America/Lima')::date, 'agendo', 1
      from public.appointments a join base b on b.id = a.prospect_id
      where a.status <> 'cancelada'
    union all
    select b.agent_id, b.origen, (a.scheduled_at at time zone 'America/Lima')::date, 'asistio', 1
      from public.appointments a join base b on b.id = a.prospect_id
      where a.status = 'completada'
    union all
    select b.agent_id, b.origen, (s.separo_at at time zone 'America/Lima')::date, 'separo', 1
      from stages s join base b on b.id = s.prospect_id
    union all
    select b.agent_id, b.origen, (s.venta_at at time zone 'America/Lima')::date, 'ventas', 1
      from stages s join base b on b.id = s.prospect_id
      where s.venta_at is not null
    union all
    select j.agent_id, null::text, j.day, j.stage, j.qty
      from public.metric_adjustments j
      where j.organization_id = p_org
  )
  select e.day, e.agent_id, e.origen,
         coalesce(sum(e.qty) filter (where e.stage = 'leads'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'responde'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'agendo'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'asistio'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'separo'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'ventas'), 0)::integer
  from ev e
  where e.day between p_from and p_to
  group by e.day, e.agent_id, e.origen
  order by e.day, e.agent_id, e.origen;
$$;
revoke all on function public.metrics_daily(uuid, date, date) from public, anon;
grant execute on function public.metrics_daily(uuid, date, date) to authenticated, service_role;
