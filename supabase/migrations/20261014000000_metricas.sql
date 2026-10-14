-- Métricas: embudo comercial con registro diario automático desde el CRM.
--
-- El tablero que el equipo llevaba en una hoja (Leads → Responde → Agendó → Asistió → Separó → Venta,
-- con % de conversión, costo por unidad e inversión) pasa al CRM. Nada se digita a mano para el día
-- a día: cada etapa se calcula de lo que el CRM ya registra, con la fecha en que ocurrió, y el panel
-- suma esos días para ver la vista diaria, semanal o mensual.
--
--   Leads       prospects.created_at
--   Responde    primer mensaje del cliente (messages.role = 'user')
--   Agendó      appointments (no canceladas), por fecha de creación
--   Asistió     appointments en estado 'completada', por fecha de la cita
--   Separó      primera vez que la etapa del lead pasó a por_depositar o venta
--   Venta       primera vez que la etapa pasó a venta
--
-- prospects.etapa no guardaba cuándo cambió, así que prospect_stage_log registra ese momento para
-- poder contar "separó" y "venta" por día. Lo que el CRM no puede saber (una visita que no se marcó
-- como completada, por ejemplo) se corrige con metric_adjustments.

-- ── Historial de etapas ──────────────────────────────────────────────────────
-- Tabla HIJA de prospects. La escribe solo el trigger de abajo (security definer); el panel no
-- inserta ni edita, por eso no hay políticas de escritura para authenticated.

create table public.prospect_stage_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  etapa text not null,
  created_at timestamptz not null default now()
);
create index idx_stage_log_org_created on public.prospect_stage_log (organization_id, created_at);
create index idx_stage_log_prospect on public.prospect_stage_log (prospect_id);

create trigger stage_log_set_org before insert on public.prospect_stage_log
  for each row execute function public.set_org_from_prospect();

alter table public.prospect_stage_log enable row level security;
revoke truncate, references, trigger on public.prospect_stage_log from authenticated;
revoke insert, update, delete on public.prospect_stage_log from authenticated;

create policy stage_log_select on public.prospect_stage_log for select to authenticated
  using (public.can_access_prospect_id(prospect_id));

create or replace function public.log_prospect_stage()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.etapa in ('por_depositar', 'venta')
     and (tg_op = 'INSERT' or old.etapa is distinct from new.etapa) then
    insert into public.prospect_stage_log (organization_id, prospect_id, etapa)
    values (new.organization_id, new.id, new.etapa);
  end if;
  return new;
end;
$$;
revoke all on function public.log_prospect_stage() from public, anon, authenticated;

create trigger prospects_log_stage after insert or update of etapa on public.prospects
  for each row execute function public.log_prospect_stage();

-- Leads que ya estaban en esas etapas: la mejor fecha disponible es su última modificación.
insert into public.prospect_stage_log (organization_id, prospect_id, etapa, created_at)
select p.organization_id, p.id, p.etapa, p.updated_at
from public.prospects p
where p.etapa in ('por_depositar', 'venta');

-- ── Metas por empresa ────────────────────────────────────────────────────────
-- Una fila por empresa. Cada meta es el % mínimo de conversión respecto a la etapa anterior
-- (respuesta sobre leads, agenda sobre respuestas, etc.). min_sample evita avisar por muestras
-- chicas: con menos de ese número en la etapa base no se evalúa al asesor.

create table public.metric_targets (
  organization_id uuid primary key default public.current_org_id()
    references public.organizations (id) on delete restrict,
  respuesta_min numeric(5,2) not null default 50 check (respuesta_min between 0 and 100),
  agenda_min numeric(5,2) not null default 15 check (agenda_min between 0 and 100),
  asistencia_min numeric(5,2) not null default 50 check (asistencia_min between 0 and 100),
  separacion_min numeric(5,2) not null default 30 check (separacion_min between 0 and 100),
  venta_min numeric(5,2) not null default 50 check (venta_min between 0 and 100),
  min_sample integer not null default 5 check (min_sample >= 1),
  alert_enabled boolean not null default false,
  alert_daily boolean not null default true,
  alert_weekly boolean not null default true,
  notify_agents boolean not null default false,
  last_daily_sent date,
  last_weekly_sent date,
  updated_at timestamptz not null default now()
);

create trigger set_metric_targets_updated_at before update on public.metric_targets
  for each row execute function public.set_updated_at();

alter table public.metric_targets enable row level security;
revoke truncate, references, trigger on public.metric_targets from authenticated;
-- last_*_sent las escribe solo metrics-alerts con service_role.
revoke update on public.metric_targets from authenticated;
grant update (respuesta_min, agenda_min, asistencia_min, separacion_min, venta_min, min_sample,
              alert_enabled, alert_daily, alert_weekly, notify_agents)
  on public.metric_targets to authenticated;

create policy metric_targets_select on public.metric_targets for select to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.view')));
create policy metric_targets_insert on public.metric_targets for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')));
create policy metric_targets_update on public.metric_targets for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')))
  with check (organization_id = (select public.current_org_id()));

-- ── Inversión mensual ────────────────────────────────────────────────────────
-- Es lo único que se digita para el costo por unidad. month = primer día del mes.

create table public.metric_spend (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default public.current_org_id()
    references public.organizations (id) on delete restrict,
  month date not null check (month = date_trunc('month', month)::date),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint metric_spend_org_month_key unique (organization_id, month)
);
create index idx_metric_spend_organization on public.metric_spend (organization_id);
create trigger set_metric_spend_updated_at before update on public.metric_spend
  for each row execute function public.set_updated_at();

alter table public.metric_spend enable row level security;
revoke truncate, references, trigger on public.metric_spend from authenticated;

create policy metric_spend_select on public.metric_spend for select to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.view')));
create policy metric_spend_insert on public.metric_spend for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')));
create policy metric_spend_update on public.metric_spend for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')))
  with check (organization_id = (select public.current_org_id()));
create policy metric_spend_delete on public.metric_spend for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')));

-- ── Ajustes manuales ─────────────────────────────────────────────────────────
-- Suman (o restan, con qty negativa) al conteo automático de una etapa en un día.

create table public.metric_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default public.current_org_id()
    references public.organizations (id) on delete restrict,
  agent_id uuid references public.agents (id) on delete cascade,
  day date not null,
  stage text not null,
  qty integer not null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint metric_adjustments_stage_check
    check (stage in ('leads', 'responde', 'agendo', 'asistio', 'separo', 'ventas')),
  constraint metric_adjustments_qty_check check (qty <> 0)
);
create index idx_metric_adjustments_org_day on public.metric_adjustments (organization_id, day);

alter table public.metric_adjustments enable row level security;
revoke truncate, references, trigger on public.metric_adjustments from authenticated;

-- Quien gestiona ve todos; un vendedor solo los de su propio embudo.
create policy metric_adjustments_select on public.metric_adjustments for select to authenticated
  using (
    organization_id = (select public.current_org_id())
    and (select public.has_permission('metrics.view'))
    and ((select public.has_permission('metrics.manage')) or agent_id = (select public.current_agent_id()))
  );
create policy metric_adjustments_insert on public.metric_adjustments for insert to authenticated
  with check (
    organization_id = (select public.current_org_id())
    and (select public.has_permission('metrics.manage'))
    and public.agent_in_my_org(agent_id)
  );
create policy metric_adjustments_delete on public.metric_adjustments for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('metrics.manage')));

-- ── Embudo por día y asesor ──────────────────────────────────────────────────
-- security INVOKER: el panel lo llama con la sesión del usuario y las políticas de cada tabla
-- hacen el recorte (un vendedor solo ve el embudo de sus leads; el administrador, el de todos).
-- metrics-alerts lo llama con service_role, que las ignora, y pasa la empresa en p_org.
-- Una fila por (día en hora de Lima, asesor); agent_id null = leads sin asesor asignado.
-- El asesor es el responsable actual del lead (handled_by_agent_id o el asesor del canal).

create or replace function public.metrics_daily(p_org uuid, p_from date, p_to date)
returns table (
  day date, agent_id uuid,
  leads integer, responde integer, agendo integer, asistio integer, separo integer, ventas integer
)
language sql stable security invoker set search_path = ''
as $$
  with base as (
    select p.id, p.created_at, coalesce(p.handled_by_agent_id, v.assigned_agent_id) as agent_id
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
    select b.agent_id, (b.created_at at time zone 'America/Lima')::date as day, 'leads'::text as stage, 1 as qty
      from base b
    union all
    select b.agent_id, (m.first_at at time zone 'America/Lima')::date, 'responde', 1
      from base b
      cross join lateral (
        select min(x.created_at) as first_at from public.messages x where x.prospect_id = b.id and x.role = 'user'
      ) m
      where m.first_at is not null
    union all
    select b.agent_id, (a.created_at at time zone 'America/Lima')::date, 'agendo', 1
      from public.appointments a join base b on b.id = a.prospect_id
      where a.status <> 'cancelada'
    union all
    select b.agent_id, (a.scheduled_at at time zone 'America/Lima')::date, 'asistio', 1
      from public.appointments a join base b on b.id = a.prospect_id
      where a.status = 'completada'
    union all
    select b.agent_id, (s.separo_at at time zone 'America/Lima')::date, 'separo', 1
      from stages s join base b on b.id = s.prospect_id
    union all
    select b.agent_id, (s.venta_at at time zone 'America/Lima')::date, 'ventas', 1
      from stages s join base b on b.id = s.prospect_id
      where s.venta_at is not null
    union all
    select j.agent_id, j.day, j.stage, j.qty
      from public.metric_adjustments j
      where j.organization_id = p_org
  )
  select e.day, e.agent_id,
         coalesce(sum(e.qty) filter (where e.stage = 'leads'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'responde'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'agendo'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'asistio'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'separo'), 0)::integer,
         coalesce(sum(e.qty) filter (where e.stage = 'ventas'), 0)::integer
  from ev e
  where e.day between p_from and p_to
  group by e.day, e.agent_id
  order by e.day, e.agent_id;
$$;
revoke all on function public.metrics_daily(uuid, date, date) from public, anon;
grant execute on function public.metrics_daily(uuid, date, date) to authenticated, service_role;

-- ── Permisos ─────────────────────────────────────────────────────────────────
-- metrics.view: ver el embudo (el vendedor solo el suyo, por las políticas de arriba).
-- metrics.manage: editar metas, inversión, ajustes y alertas.
-- Mismo criterio que los roles actuales: ve quien ya veía analítica; gestiona quien ya gestionaba alertas.

update public.roles set permissions = array_append(permissions, 'metrics.view')
where 'analytics.dashboard' = any (permissions) and not ('metrics.view' = any (permissions));

update public.roles set permissions = array_append(permissions, 'metrics.manage')
where 'config.alerts' = any (permissions) and not ('metrics.manage' = any (permissions));

-- ── Sección contratable ──────────────────────────────────────────────────────

alter table public.organizations drop constraint if exists organizations_enabled_sections_check;
alter table public.organizations add constraint organizations_enabled_sections_check check (
  enabled_sections is null
  or enabled_sections <@ array['dashboard', 'agenda', 'bandeja-global', 'leads', 'productos', 'catalogo-ia', 'automatizacion', 'disponibilidad', 'metricas']::text[]
);

-- ── Empresas nuevas y existentes ─────────────────────────────────────────────
-- Se siembra en un trigger propio (se dispara después de seed_organization, que crea los roles)
-- para no reescribir esa función.

create or replace function public.seed_organization_metrics()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.metric_targets (organization_id) values (new.id) on conflict do nothing;
  update public.roles set permissions = array_append(permissions, 'metrics.view')
    where organization_id = new.id and 'analytics.dashboard' = any (permissions) and not ('metrics.view' = any (permissions));
  update public.roles set permissions = array_append(permissions, 'metrics.manage')
    where organization_id = new.id and 'config.alerts' = any (permissions) and not ('metrics.manage' = any (permissions));
  return new;
end;
$$;
revoke all on function public.seed_organization_metrics() from public, anon, authenticated;

create trigger organizations_seed_metrics after insert on public.organizations
  for each row execute function public.seed_organization_metrics();

insert into public.metric_targets (organization_id)
select o.id from public.organizations o
on conflict do nothing;

-- ── Aviso diario ─────────────────────────────────────────────────────────────
-- 08:05 hora de Lima (13:05 UTC). La Edge Function metrics-alerts decide si toca resumen diario,
-- semanal (lunes) o ninguno. Mismo secreto compartido que lead-alerts (cron_secret en Vault).

select cron.unschedule('metrics-alerts') where exists (select 1 from cron.job where jobname = 'metrics-alerts');
select cron.schedule(
  'metrics-alerts',
  '5 13 * * *',
  $cron$
  select net.http_post(
    url := 'https://znalzptpffnbnzuckiid.supabase.co/functions/v1/metrics-alerts',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
