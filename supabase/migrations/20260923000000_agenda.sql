-- Agenda inteligente: citas con prospectos y control de atención de la cola.
--
-- appointments: hasta ahora la cita era solo texto libre (prospects.cita_horario).
-- Para confirmar, mover o cancelar una cita —y que la IA proponga las que detecta
-- en las conversaciones— hace falta una fila con fecha real. Es tabla HIJA de
-- prospects: la empresa se copia del prospecto (trigger), nunca viene del cliente.
--
-- prospects.snoozed_until / attended_at: "Posponer" y "Atendido" de la cola de
-- prioridad. Los escribe el vendedor desde el panel, por eso llevan grant de update.

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  title text not null default 'Visita',
  scheduled_at timestamptz not null,
  status text not null default 'por_confirmar',
  source text not null default 'manual',
  source_quote text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_status_check check (status in ('por_confirmar', 'confirmada', 'completada', 'cancelada')),
  constraint appointments_source_check check (source in ('ia', 'manual'))
);

create index idx_appointments_organization on public.appointments (organization_id, scheduled_at);
create index idx_appointments_prospect on public.appointments (prospect_id);

create trigger appointments_set_org before insert on public.appointments
  for each row execute function public.set_org_from_prospect();
create trigger set_appointments_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

alter table public.appointments enable row level security;
revoke truncate, references, trigger on public.appointments from authenticated;

-- Mismo alcance que prospects: el vendedor solo ve las citas de sus leads.
create policy appointments_select on public.appointments for select to authenticated
  using (public.can_access_prospect_id(prospect_id));
create policy appointments_insert on public.appointments for insert to authenticated
  with check (public.can_access_prospect_id(prospect_id) and (select public.has_permission('agenda.manage')));
create policy appointments_update on public.appointments for update to authenticated
  using (public.can_access_prospect_id(prospect_id) and (select public.has_permission('agenda.manage')))
  with check (public.can_access_prospect_id(prospect_id));
create policy appointments_delete on public.appointments for delete to authenticated
  using (public.can_access_prospect_id(prospect_id) and (select public.has_permission('agenda.manage')));

alter publication supabase_realtime add table public.appointments;

alter table public.prospects
  add column if not exists snoozed_until timestamptz,
  add column if not exists attended_at timestamptz;

grant update (snoozed_until, attended_at) on public.prospects to authenticated;
