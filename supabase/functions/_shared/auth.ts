import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ALL_PERMISSION_KEYS } from './permissions.ts';

// ── Utilidades HTTP comunes ──────────────────────────────────────────────────

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Responde OPTIONS / métodos no permitidos; devuelve null si hay que seguir.
export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  return null;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  console.error(err);
  return json({ error: err instanceof Error ? err.message : 'Error interno' }, 500);
}

// ── Clientes ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// service_role: pasa por encima de RLS. Usar solo después de getCaller().
export const admin: SupabaseClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// ── Identidad del que llama ──────────────────────────────────────────────────
// La clave publicable pasa el gateway (verify_jwt) pero NO es identidad: la
// identidad sale únicamente del access_token del usuario.

export interface CallerProfile {
  id: string;
  organization_id: string;
  user_type: 'admin' | 'vendedor';
  is_super_admin: boolean;
  is_active: boolean;
  agent_id: string | null;
  full_name: string | null;
  email: string;
  phone: string | null;
  organization: { id: string; name: string; is_active: boolean; max_channels: number } | null;
  agent: {
    id: string;
    name: string;
    access_expires_at: string | null;
    role_id: string | null;
    role: { id: string; name: string; permissions: string[] } | null;
  } | null;
}

export interface Caller {
  userId: string;
  email: string | null;
  profile: CallerProfile;
  organizationId: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  agentId: string | null;
  permissions: Set<string>;
  can(perm: string): boolean;
}

export async function getCaller(req: Request): Promise<Caller> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Falta el token de sesión');

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Sesión inválida o expirada');
  const user = data.user;

  const { data: profileRow, error: profileError } = await admin
    .from('profiles')
    .select(
      'id, organization_id, user_type, is_super_admin, is_active, agent_id, full_name, email, phone, ' +
        'organization:organizations(id, name, is_active, max_channels), ' +
        'agent:agents(id, name, access_expires_at, role_id, role:roles(id, name, permissions))'
    )
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) throw new HttpError(500, `No se pudo cargar el perfil: ${profileError.message}`);
  const profile = profileRow as unknown as CallerProfile | null;
  if (!profile) throw new HttpError(403, 'Tu usuario no tiene acceso a ninguna empresa');
  if (!profile.is_active || !profile.organization?.is_active) throw new HttpError(403, 'Acceso deshabilitado');

  const today = new Date().toISOString().slice(0, 10);
  if (profile.user_type === 'vendedor' && profile.agent?.access_expires_at && profile.agent.access_expires_at < today) {
    throw new HttpError(403, 'Tu acceso venció');
  }

  const isAdmin = profile.user_type === 'admin' || profile.is_super_admin;
  const permissions = new Set<string>(isAdmin ? ALL_PERMISSION_KEYS : (profile.agent?.role?.permissions ?? []));

  return {
    userId: user.id,
    email: user.email ?? null,
    profile,
    organizationId: profile.organization_id,
    isAdmin,
    isSuperAdmin: profile.is_super_admin,
    agentId: profile.agent_id,
    permissions,
    can: (perm: string) => permissions.has(perm),
  };
}

export function requirePermission(caller: Caller, perm: string): void {
  if (!caller.can(perm)) throw new HttpError(403, `No tienes el permiso "${perm}"`);
}

export function requireSuperAdmin(caller: Caller): void {
  if (!caller.isSuperAdmin) throw new HttpError(403, 'Solo el administrador de la plataforma puede hacer esto');
}
