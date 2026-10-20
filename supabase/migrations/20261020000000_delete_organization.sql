-- Eliminar una empresa por completo desde el panel (solo super-admin + PIN, validado en admin-users).
--
-- Todas las FK hacia organizations son "on delete restrict", así que borrar la empresa exige
-- vaciar sus tablas en orden de dependencias. Se hace en una sola función para que sea atómico:
-- si algo falla, no queda una empresa a medias. Los usuarios de auth.users se borran antes desde
-- la Edge Function (profiles cae en cascada). Solo service_role puede ejecutarla.

create or replace function public.delete_organization(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.automation_enrollments where organization_id = p_org;
  delete from public.appointments           where organization_id = p_org;
  delete from public.messages               where organization_id = p_org;
  delete from public.prospect_stage_log     where organization_id = p_org;
  delete from public.prospects              where organization_id = p_org;
  delete from public.agent_status_log       where organization_id = p_org;
  delete from public.automations            where organization_id = p_org;
  delete from public.availability_settings  where organization_id = p_org;
  delete from public.catalog_files          where organization_id = p_org;
  delete from public.custom_fields          where organization_id = p_org;
  delete from public.metric_adjustments     where organization_id = p_org;
  delete from public.metric_spend           where organization_id = p_org;
  delete from public.metric_targets         where organization_id = p_org;
  delete from public.products               where organization_id = p_org;
  delete from public.profiles               where organization_id = p_org;
  delete from public.vendors                where organization_id = p_org;
  delete from public.agents                 where organization_id = p_org;
  delete from public.roles                  where organization_id = p_org;
  delete from public.organizations          where id = p_org;
end;
$$;

revoke all on function public.delete_organization(uuid) from public, anon, authenticated;
grant execute on function public.delete_organization(uuid) to service_role;
