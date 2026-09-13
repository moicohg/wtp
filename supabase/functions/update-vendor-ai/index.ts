import { admin as supabase, getCaller, handleError, HttpError, json, preflight, requirePermission } from '../_shared/auth.ts';

// Actualiza proveedor/clave/modelo/prompt de IA de un canal. Exige sesión con
// el permiso config.ai_settings y solo toca canales de la empresa del que llama.

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  google:    'gemini-2.0-flash',
};

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const caller = await getCaller(req);
    requirePermission(caller, 'config.ai_settings');

    let body: {
      vendor_id?: string;
      ai_provider?: string;
      ai_api_key?: string;
      ai_model?: string;
      system_prompt?: string;
    };
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, 'Payload inválido');
    }

    const { vendor_id, ai_provider, ai_api_key, ai_model, system_prompt } = body;
    if (!vendor_id) throw new HttpError(400, 'Falta vendor_id');

    const updates: Record<string, unknown> = {};

    if (ai_provider !== undefined && ai_api_key !== undefined) {
      const validProviders = ['anthropic', 'openai', 'google'];
      if (!validProviders.includes(ai_provider)) {
        throw new HttpError(400, 'ai_provider inválido. Usa: anthropic, openai o google');
      }
      updates.ai_provider = ai_provider;
      updates.ai_api_key  = ai_api_key;
      updates.ai_model    = ai_model || DEFAULT_MODEL[ai_provider];
    }

    if (system_prompt !== undefined) {
      updates.system_prompt = system_prompt || null;
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, 'Nada que actualizar');
    }

    const { data, error } = await supabase
      .from('vendors')
      .update(updates)
      .eq('id', vendor_id)
      .eq('organization_id', caller.organizationId)
      .select('id');

    if (error) {
      console.error('Error actualizando vendor AI config:', error);
      throw new HttpError(500, error.message);
    }
    if (!data?.length) throw new HttpError(404, 'Canal no encontrado en tu empresa');

    return json({ success: true });
  } catch (err) {
    return handleError(err);
  }
});
