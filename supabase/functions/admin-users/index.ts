import { admin, getCaller, handleError, HttpError, json, preflight, requirePermission, requireSuperAdmin, type Caller } from '../_shared/auth.ts';
import { normalizeE164, vendorLoginEmail } from '../_shared/phone.ts';

// ── Administración de empresas y usuarios ────────────────────────────────────
// Única vía de escritura sobre auth.users y profiles. Crea usuarios con
// contraseña y confirmados (sin SMTP). El super-admin administra cualquier
// empresa; un admin de empresa (o vendedor con users.manage_users) solo la
// suya. Auth + Postgres no son transaccionales: cada alta compensa (borra lo
// creado) si falla a mitad.

type Body = Record<string, unknown>;

const MIN_PASSWORD = 6;

function str(body: Body, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

function requireStr(body: Body, key: string, label: string): string {
  const v = str(body, key);
  if (!v) throw new HttpError(400, `Falta ${label}`);
  return v;
}

function requirePassword(body: Body, key = 'password'): string {
  const v = str(body, key);
  if (v.length < MIN_PASSWORD) throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  return v;
}

function isDuplicate(message: string): boolean {
  return /already|registered|exists|duplicate|unique/i.test(message);
}

async function createAuthUser(email: string, password: string, meta: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: meta,
  });
  if (error || !data.user) {
    const msg = error?.message ?? 'No se pudo crear el usuario';
    throw new HttpError(isDuplicate(msg) ? 409 : 400, isDuplicate(msg) ? 'Ya existe un usuario con ese correo o teléfono' : msg);
  }
  return data.user.id;
}

async function deleteAuthUserQuietly(userId: string): Promise<void> {
  try {
    await admin.auth.admin.deleteUser(userId);
  } catch (e) {
    console.error('No se pudo revertir el usuario de Auth', userId, e);
  }
}

// Empresa sobre la que actúa el que llama. El super-admin puede indicar otra.
function targetOrgId(caller: Caller, body: Body): string {
  const requested = str(body, 'organization_id');
  if (caller.isSuperAdmin) return requested || caller.organizationId;
  if (requested && requested !== caller.organizationId) throw new HttpError(403, 'No puedes administrar otra empresa');
  return caller.organizationId;
}

interface TargetProfile {
  id: string;
  organization_id: string;
  user_type: 'admin' | 'vendedor';
  is_super_admin: boolean;
  is_active: boolean;
  agent_id: string | null;
  full_name: string | null;
  email: string;
}

async function loadTarget(caller: Caller, body: Body): Promise<TargetProfile> {
  const userId = requireStr(body, 'user_id', 'user_id');
  const { data, error } = await admin.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'Usuario no encontrado');
  const target = data as TargetProfile;
  if (!caller.isSuperAdmin) {
    requirePermission(caller, 'users.manage_users');
    if (target.organization_id !== caller.organizationId) throw new HttpError(403, 'Ese usuario no pertenece a tu empresa');
    if (target.is_super_admin) throw new HttpError(403, 'No puedes modificar al administrador de la plataforma');
  }
  return target;
}

// ── Acciones ─────────────────────────────────────────────────────────────────

async function createOrganization(caller: Caller, body: Body) {
  requireSuperAdmin(caller);
  const name = requireStr(body, 'name', 'el nombre de la empresa');
  const maxChannels = Number.isInteger(body.max_channels) ? (body.max_channels as number) : 1;
  if (maxChannels < 0) throw new HttpError(400, 'max_channels no puede ser negativo');
  const adminBody = (body.admin ?? {}) as Body;
  const email = requireStr(adminBody, 'email', 'el correo del administrador').toLowerCase();
  const password = requirePassword(adminBody);
  const fullName = str(adminBody, 'full_name') || name;

  const { data: org, error: orgError } = await admin
    .from('organizations')
    .insert({ name, max_channels: maxChannels })
    .select('*')
    .single();
  if (orgError || !org) throw new HttpError(500, orgError?.message ?? 'No se pudo crear la empresa');

  let userId: string;
  try {
    userId = await createAuthUser(email, password, { full_name: fullName, user_type: 'admin' });
  } catch (e) {
    await admin.from('organizations').delete().eq('id', org.id);
    throw e;
  }

  const { error: profileError } = await admin.from('profiles').insert({
    id: userId,
    organization_id: org.id,
    user_type: 'admin',
    full_name: fullName,
    email,
  });
  if (profileError) {
    await deleteAuthUserQuietly(userId);
    await admin.from('organizations').delete().eq('id', org.id);
    throw new HttpError(500, profileError.message);
  }

  return json({ organization: org, user_id: userId });
}

async function listOrganizations(caller: Caller) {
  requireSuperAdmin(caller);
  const [orgs, profiles, vendors] = await Promise.all([
    admin.from('organizations').select('*').order('created_at', { ascending: true }),
    admin.from('profiles').select('id, organization_id, email, user_type, is_active, is_super_admin, full_name'),
    admin.from('vendors').select('id, organization_id'),
  ]);
  if (orgs.error) throw new HttpError(500, orgs.error.message);
  if (profiles.error) throw new HttpError(500, profiles.error.message);
  if (vendors.error) throw new HttpError(500, vendors.error.message);

  const rows = (orgs.data ?? []).map((o) => {
    const users = (profiles.data ?? []).filter((p) => p.organization_id === o.id);
    return {
      ...o,
      users_count: users.length,
      channels_count: (vendors.data ?? []).filter((v) => v.organization_id === o.id).length,
      admins: users.filter((p) => p.user_type === 'admin').map((p) => ({ id: p.id, email: p.email, full_name: p.full_name, is_active: p.is_active })),
    };
  });
  return json({ organizations: rows });
}

async function setOrganizationActive(caller: Caller, body: Body) {
  requireSuperAdmin(caller);
  const id = requireStr(body, 'organization_id', 'organization_id');
  if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'Falta is_active');
  if (id === caller.organizationId && !body.is_active) throw new HttpError(400, 'No puedes desactivar tu propia empresa');
  const { error } = await admin.from('organizations').update({ is_active: body.is_active }).eq('id', id);
  if (error) throw new HttpError(500, error.message);
  return json({ success: true });
}

async function setOrganizationLimits(caller: Caller, body: Body) {
  requireSuperAdmin(caller);
  const id = requireStr(body, 'organization_id', 'organization_id');
  const maxChannels = body.max_channels;
  if (!Number.isInteger(maxChannels) || (maxChannels as number) < 0) throw new HttpError(400, 'max_channels inválido');
  const { error } = await admin.from('organizations').update({ max_channels: maxChannels }).eq('id', id);
  if (error) throw new HttpError(500, error.message);
  return json({ success: true });
}

async function createUser(caller: Caller, body: Body) {
  const orgId = targetOrgId(caller, body);
  if (!caller.isSuperAdmin) requirePermission(caller, 'users.manage_users');

  const userType = str(body, 'user_type');
  if (userType !== 'admin' && userType !== 'vendedor') throw new HttpError(400, 'user_type debe ser admin o vendedor');
  const password = requirePassword(body);
  const fullName = requireStr(body, 'full_name', 'el nombre');
  const infoEmail = str(body, 'email').toLowerCase() || null;

  // ── Admin de empresa: correo + contraseña ──
  if (userType === 'admin') {
    if (!infoEmail) throw new HttpError(400, 'Falta el correo');
    const userId = await createAuthUser(infoEmail, password, { full_name: fullName, user_type: 'admin' });
    const { error } = await admin.from('profiles').insert({
      id: userId,
      organization_id: orgId,
      user_type: 'admin',
      full_name: fullName,
      email: infoEmail,
    });
    if (error) {
      await deleteAuthUserQuietly(userId);
      throw new HttpError(500, error.message);
    }
    return json({ user_id: userId, agent_id: null });
  }

  // ── Vendedor: teléfono + contraseña (correo de Auth sintético) ──
  const phone = normalizeE164(str(body, 'phone'));
  if (!phone) throw new HttpError(400, 'Teléfono inválido: usa código de país + número (ej. +51 987654321)');
  const loginEmail = vendorLoginEmail(phone);

  const { data: phoneTaken } = await admin.from('profiles').select('id').eq('phone', phone).maybeSingle();
  if (phoneTaken) throw new HttpError(409, 'Ya existe un vendedor con ese teléfono');

  let roleId = str(body, 'role_id') || null;
  if (roleId) {
    const { data: role } = await admin.from('roles').select('id').eq('id', roleId).eq('organization_id', orgId).maybeSingle();
    if (!role) throw new HttpError(400, 'El rol no pertenece a esta empresa');
  } else {
    const { data: role } = await admin.from('roles').select('id').eq('organization_id', orgId).eq('name', 'Vendedores').maybeSingle();
    roleId = role?.id ?? null;
  }
  const accessExpiresAt = str(body, 'access_expires_at') || null;

  // Vincular un vendedor existente (sin login) o crear uno nuevo.
  let agentId = str(body, 'agent_id') || null;
  let createdAgent = false;
  if (agentId) {
    const { data: agent } = await admin.from('agents').select('id').eq('id', agentId).eq('organization_id', orgId).maybeSingle();
    if (!agent) throw new HttpError(400, 'El vendedor no pertenece a esta empresa');
    const { data: linked } = await admin.from('profiles').select('id').eq('agent_id', agentId).maybeSingle();
    if (linked) throw new HttpError(409, 'Ese vendedor ya tiene un usuario');
    const { error } = await admin
      .from('agents')
      .update({ phone, role_id: roleId, access_expires_at: accessExpiresAt, ...(infoEmail ? { email: infoEmail } : {}) })
      .eq('id', agentId);
    if (error) throw new HttpError(500, error.message);
  } else {
    const { data: agent, error } = await admin
      .from('agents')
      .insert({ name: fullName, email: infoEmail, phone, role_id: roleId, access_expires_at: accessExpiresAt, organization_id: orgId })
      .select('id')
      .single();
    if (error || !agent) throw new HttpError(500, error?.message ?? 'No se pudo crear el vendedor');
    agentId = agent.id;
    createdAgent = true;
  }

  let userId: string;
  try {
    userId = await createAuthUser(loginEmail, password, { full_name: fullName, user_type: 'vendedor', phone });
  } catch (e) {
    if (createdAgent) await admin.from('agents').delete().eq('id', agentId);
    throw e;
  }

  const { error: profileError } = await admin.from('profiles').insert({
    id: userId,
    organization_id: orgId,
    user_type: 'vendedor',
    agent_id: agentId,
    full_name: fullName,
    email: loginEmail,
    phone,
  });
  if (profileError) {
    await deleteAuthUserQuietly(userId);
    if (createdAgent) await admin.from('agents').delete().eq('id', agentId);
    throw new HttpError(isDuplicate(profileError.message) ? 409 : 500, isDuplicate(profileError.message) ? 'Ya existe un vendedor con ese teléfono' : profileError.message);
  }

  return json({ user_id: userId, agent_id: agentId });
}

async function updateUser(caller: Caller, body: Body) {
  const target = await loadTarget(caller, body);
  const fullName = str(body, 'full_name');
  const profilePatch: Record<string, unknown> = {};
  if (fullName) profilePatch.full_name = fullName;
  if (Object.keys(profilePatch).length) {
    const { error } = await admin.from('profiles').update(profilePatch).eq('id', target.id);
    if (error) throw new HttpError(500, error.message);
  }

  if (target.agent_id) {
    const agentPatch: Record<string, unknown> = {};
    if (fullName) agentPatch.name = fullName;
    if ('role_id' in body) {
      const roleId = str(body, 'role_id') || null;
      if (roleId) {
        const { data: role } = await admin.from('roles').select('id').eq('id', roleId).eq('organization_id', target.organization_id).maybeSingle();
        if (!role) throw new HttpError(400, 'El rol no pertenece a esta empresa');
      }
      agentPatch.role_id = roleId;
    }
    if ('access_expires_at' in body) agentPatch.access_expires_at = str(body, 'access_expires_at') || null;
    if ('email' in body) agentPatch.email = str(body, 'email').toLowerCase() || null;
    if (Object.keys(agentPatch).length) {
      const { error } = await admin.from('agents').update(agentPatch).eq('id', target.agent_id);
      if (error) throw new HttpError(500, error.message);
    }
  }
  return json({ success: true });
}

async function resetPassword(caller: Caller, body: Body) {
  const target = await loadTarget(caller, body);
  const password = requirePassword(body, 'new_password');
  const { error } = await admin.auth.admin.updateUserById(target.id, { password });
  if (error) throw new HttpError(500, error.message);
  return json({ success: true });
}

async function setActive(caller: Caller, body: Body) {
  const target = await loadTarget(caller, body);
  if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'Falta is_active');
  if (target.id === caller.userId) throw new HttpError(400, 'No puedes desactivarte a ti mismo');
  const { error } = await admin.from('profiles').update({ is_active: body.is_active }).eq('id', target.id);
  if (error) throw new HttpError(500, error.message);
  // El ban invalida los refresh tokens: la sesión abierta muere al renovar.
  const { error: banError } = await admin.auth.admin.updateUserById(target.id, { ban_duration: body.is_active ? 'none' : '876000h' });
  if (banError) throw new HttpError(500, banError.message);
  return json({ success: true });
}

async function deleteUser(caller: Caller, body: Body) {
  const target = await loadTarget(caller, body);
  if (target.id === caller.userId) throw new HttpError(400, 'No puedes eliminarte a ti mismo');
  const { error } = await admin.auth.admin.deleteUser(target.id); // profiles cae en cascada
  if (error) throw new HttpError(500, error.message);
  if (body.delete_agent === true && target.agent_id) {
    const { error: agentError } = await admin.from('agents').delete().eq('id', target.agent_id);
    if (agentError) throw new HttpError(500, `Usuario eliminado, pero el vendedor no: ${agentError.message}`);
  }
  return json({ success: true });
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const caller = await getCaller(req);
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw new HttpError(400, 'Payload inválido');
    }

    switch (str(body, 'action')) {
      case 'create_organization':     return await createOrganization(caller, body);
      case 'list_organizations':      return await listOrganizations(caller);
      case 'set_organization_active': return await setOrganizationActive(caller, body);
      case 'set_organization_limits': return await setOrganizationLimits(caller, body);
      case 'create_user':             return await createUser(caller, body);
      case 'update_user':             return await updateUser(caller, body);
      case 'reset_password':          return await resetPassword(caller, body);
      case 'set_active':              return await setActive(caller, body);
      case 'delete_user':             return await deleteUser(caller, body);
      default:
        throw new HttpError(400, 'Acción desconocida');
    }
  } catch (err) {
    return handleError(err);
  }
});
