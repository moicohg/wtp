-- Límite de vendedores por empresa.
--
-- Cada empresa cliente contrata un plan con un tope de canales (max_channels) y,
-- desde ahora, de vendedores (max_agents). Sin tope, una sola empresa podría
-- crear usuarios sin fin y hacer crecer la base más de lo que el plan cubre.
-- Solo cuentan los vendedores (tabla agents); el administrador de la empresa no
-- ocupa cupo. Se hace cumplir con un trigger, igual que los canales, así que
-- vale para cualquier camino de alta (panel, Edge Function o SQL).

alter table public.organizations
  add column if not exists max_agents integer not null default 5,
  add constraint organizations_max_agents_check check (max_agents >= 0);

-- La empresa dueña de la plataforma (007) no debe quedar limitada a 5.
update public.organizations set max_agents = 50 where id = '00000000-0000-4000-8000-000000000007';

-- El panel lee el tope de su propia empresa (como max_channels).
grant select (max_agents) on public.organizations to authenticated;

create or replace function public.enforce_agent_limit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_max integer;
  v_count integer;
begin
  if new.organization_id is null then
    return new;
  end if;
  select o.max_agents into v_max from public.organizations o where o.id = new.organization_id;
  select count(*) into v_count from public.agents a where a.organization_id = new.organization_id;
  if v_max is not null and v_count >= v_max then
    raise exception 'LIMITE_VENDEDORES:%', v_max using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger agents_enforce_agent_limit before insert on public.agents
  for each row execute function public.enforce_agent_limit();
