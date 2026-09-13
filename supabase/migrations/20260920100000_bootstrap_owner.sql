-- Bootstrap del dueño de la plataforma (super-admin) como administrador de la
-- empresa inicial 007. Prerrequisito: el usuario ya existe en Auth (creado a
-- mano desde el Dashboard, con "Auto Confirm User"). Si no existe, la
-- migración falla a propósito para no dejar el panel sin ningún acceso.

do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = 'kanbansuite@gmail.com'
  limit 1;

  if v_user_id is null then
    raise exception 'No existe el usuario kanbansuite@gmail.com en Auth. Créalo en Supabase → Authentication → Users → Add user (Auto Confirm) y vuelve a correr la migración.';
  end if;

  insert into public.profiles (id, organization_id, user_type, is_super_admin, full_name, email)
  values (v_user_id, '00000000-0000-4000-8000-000000000007', 'admin', true, 'Dueño de la plataforma', 'kanbansuite@gmail.com')
  on conflict (id) do update
    set organization_id = excluded.organization_id,
        user_type       = 'admin',
        is_super_admin  = true,
        is_active       = true;
end;
$$;
