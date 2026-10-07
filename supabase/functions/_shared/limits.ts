import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface OrgUsage {
  ai_used: number;
  ai_max: number;
  storage_bytes: number;
  storage_max_bytes: number;
  plan_active: boolean;
}

export async function getOrgUsage(supabase: SupabaseClient, organizationId: string): Promise<OrgUsage | null> {
  const { data, error } = await supabase.rpc('org_usage', { p_org: organizationId });
  if (error || !data) {
    console.error('[limites] no se pudo leer el consumo:', error?.message);
    return null;
  }
  return data as OrgUsage;
}

// Si no se puede leer el consumo se deja pasar: es mejor responder de más que dejar al cliente sin bot por un fallo.
// El bot también se detiene si la empresa está desactivada o su plan venció.
export const aiAllowed = (u: OrgUsage | null) => !u || (u.plan_active !== false && u.ai_used < u.ai_max);
export const storageAllowed = (u: OrgUsage | null) => !u || u.storage_bytes < u.storage_max_bytes;
