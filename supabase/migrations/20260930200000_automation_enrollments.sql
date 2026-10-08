-- Inscribir un lead en una cadencia de seguimiento desde su chat (botón ⚡ de "Info del cliente").
--
-- Hasta ahora automations solo guardaba la definición de la cadencia. Esta tabla registra a qué
-- cadencia pertenece cada lead. El motor que envía los pasos programados sigue pendiente: por ahora
-- solo queda el registro de la inscripción.
-- Tabla HIJA de prospects: la empresa se copia del prospecto (trigger), nunca viene del cliente.

create table public.automation_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  automation_id uuid not null references public.automations (id) on delete cascade,
  status text not null default 'activa',
  enrolled_at timestamptz not null default now(),
  constraint automation_enrollments_status_check check (status in ('activa', 'completada', 'cancelada'))
);

-- Un lead no puede estar dos veces activo en la misma cadencia.
create unique index uq_automation_enrollments_active
  on public.automation_enrollments (prospect_id, automation_id) where status = 'activa';
create index idx_automation_enrollments_prospect on public.automation_enrollments (prospect_id);
create index idx_automation_enrollments_automation on public.automation_enrollments (automation_id);
create index idx_automation_enrollments_organization on public.automation_enrollments (organization_id);

create trigger automation_enrollments_set_org before insert on public.automation_enrollments
  for each row execute function public.set_org_from_prospect();

alter table public.automation_enrollments enable row level security;
revoke truncate, references, trigger on public.automation_enrollments from authenticated;

-- Mismo alcance que prospects. La cadencia debe ser de la misma empresa (automations ya filtra por empresa).
create policy automation_enrollments_select on public.automation_enrollments for select to authenticated
  using (public.can_access_prospect_id(prospect_id));
create policy automation_enrollments_insert on public.automation_enrollments for insert to authenticated
  with check (
    public.can_access_prospect_id(prospect_id)
    and (select public.has_permission('messaging.manage_automations'))
    and exists (select 1 from public.automations a where a.id = automation_id)
  );
create policy automation_enrollments_update on public.automation_enrollments for update to authenticated
  using (public.can_access_prospect_id(prospect_id) and (select public.has_permission('messaging.manage_automations')))
  with check (public.can_access_prospect_id(prospect_id));
create policy automation_enrollments_delete on public.automation_enrollments for delete to authenticated
  using (public.can_access_prospect_id(prospect_id) and (select public.has_permission('messaging.manage_automations')));
