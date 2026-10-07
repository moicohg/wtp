import { admin as supabase, getCaller, handleError, HttpError, json, preflight, requirePermission } from '../_shared/auth.ts';

// Actualiza proveedor/clave/modelo/prompt de IA de un canal. Exige sesión con
// el permiso config.ai_settings y solo toca canales de la empresa del que llama.

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  google:    'gemini-2.0-flash',
};

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };

// Por el prefijo se adivina de qué proveedor es una clave, para avisar si no coincide con el elegido.
function guessProvider(key: string): string | null {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  if (key.startsWith('AIza')) return 'google';
  return null;
}

// Hace una llamada mínima al proveedor con la clave y el modelo del canal.
async function testAiKey(provider: string, key: string, model: string): Promise<{ ok: boolean; message: string }> {
  if (!key) return { ok: false, message: 'Este canal no tiene API key guardada.' };
  const guessed = guessProvider(key);
  if (guessed && guessed !== provider) {
    return {
      ok: false,
      message: `La clave parece de ${PROVIDER_LABEL[guessed]} pero el proveedor elegido es ${PROVIDER_LABEL[provider]}. Cambia el proveedor o la clave.`,
    };
  }

  let resp: Response;
  try {
    if (provider === 'anthropic') {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hola' }] }),
      });
    } else if (provider === 'openai') {
      resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hola' }] }),
      });
    } else {
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hola' }] }], generationConfig: { maxOutputTokens: 1 } }),
        }
      );
    }
  } catch {
    return { ok: false, message: `No se pudo contactar a ${PROVIDER_LABEL[provider]}.` };
  }
  if (resp.ok) return { ok: true, message: `API key activa: ${PROVIDER_LABEL[provider]} respondió con el modelo ${model}.` };

  const data = await resp.json().catch(() => ({}));
  const detail: string = data?.error?.message ?? '';
  if (resp.status === 401 || resp.status === 403) return { ok: false, message: `API key inválida o sin permisos (${PROVIDER_LABEL[provider]}).` };
  if (resp.status === 429) return { ok: false, message: `La clave es válida pero no tiene saldo o llegó a su límite. ${detail}`.trim() };
  if (resp.status === 404 || /model/i.test(detail)) return { ok: false, message: `El modelo "${model}" no existe o la clave no tiene acceso. ${detail}`.trim() };
  return { ok: false, message: `${PROVIDER_LABEL[provider]} respondió ${resp.status}. ${detail}`.trim() };
}

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const caller = await getCaller(req);
    requirePermission(caller, 'config.ai_settings');

    let body: {
      action?: string;
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

    const validProviders = ['anthropic', 'openai', 'google'];
    if (ai_provider !== undefined && !validProviders.includes(ai_provider)) {
      throw new HttpError(400, 'ai_provider inválido. Usa: anthropic, openai o google');
    }

    // ── test: prueba la clave (la escrita en el formulario o, si no hay, la guardada) ──
    if (body.action === 'test') {
      const { data: v } = await supabase
        .from('vendors')
        .select('ai_provider, ai_model, ai_api_key')
        .eq('id', vendor_id)
        .eq('organization_id', caller.organizationId)
        .maybeSingle();
      if (!v) throw new HttpError(404, 'Canal no encontrado en tu empresa');
      const provider = ai_provider ?? v.ai_provider;
      const model = ai_model || (ai_provider && ai_provider !== v.ai_provider ? DEFAULT_MODEL[provider] : v.ai_model) || DEFAULT_MODEL[provider];
      return json(await testAiKey(provider, ai_api_key || v.ai_api_key || '', model));
    }

    const updates: Record<string, unknown> = {};

    // Proveedor y modelo se pueden cambiar sin volver a escribir la clave; la clave solo si viene.
    if (ai_provider !== undefined) {
      updates.ai_provider = ai_provider;
      updates.ai_model    = ai_model || DEFAULT_MODEL[ai_provider];
    }
    if (ai_api_key !== undefined) updates.ai_api_key = ai_api_key;

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
