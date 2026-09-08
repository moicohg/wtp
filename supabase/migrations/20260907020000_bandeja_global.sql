-- Campos para la Bandeja Global: etapa manual de venta (distinta del label
-- calculado por la IA), etiquetas libres, estado de la conversación, y quién
-- atiende realmente el lead (para el mecanismo de "Prestado": un lead se
-- considera prestado cuando handled_by_agent_id difiere del vendedor
-- asignado al canal).

alter table public.prospects
  add column etapa text,
  add column etiquetas text[] not null default '{}',
  add column estado_conversacion text not null default 'activo',
  add column handled_by_agent_id uuid references public.agents (id) on delete set null;

alter table public.prospects
  add constraint prospects_estado_conversacion_check
    check (estado_conversacion in ('activo', 'inactivo', 'cerrado'));

-- El dashboard puede editar estos 4 campos "de gestión" directamente desde
-- la Bandeja Global, pero no el resto de la fila (score/label/etc. los
-- calcula la IA vía las Edge Functions con service_role).
grant update (etapa, etiquetas, estado_conversacion, handled_by_agent_id) on public.prospects to anon;

create policy anon_update_prospects_management on public.prospects
  for update to anon using (true) with check (true);

-- ── Vista: Bandeja Global ────────────────────────────────────────────────────
-- Une cada prospecto con su canal, el vendedor que lo atiende (o el asignado
-- por defecto al canal) y el último mensaje de la conversación.
-- security_invoker hace que respete el RLS del rol que consulta (anon), no
-- el del dueño de la vista.

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

grant select on public.prospect_inbox to anon;
