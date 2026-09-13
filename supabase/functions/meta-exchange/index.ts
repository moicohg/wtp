import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Supabase (service_role para bypass RLS) ───────────────────────────────────

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const META_APP_ID     = Deno.env.get('META_APP_ID')!;
const META_APP_SECRET = Deno.env.get('META_APP_SECRET')!;
const GRAPH_VERSION   = 'v20.0';

// ── CORS ─────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  google:    'gemini-2.0-flash',
};
const VALID_PROVIDERS = ['anthropic', 'openai', 'google'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body: {
    // Modo OAuth (Embedded Signup)
    code?: string;
    // Modo manual (sin SDK de Facebook)
    access_token?: string;
    // Datos del canal — siempre requeridos
    phone_number_id: string;
    waba_id: string;
    vendor_name?: string;
    system_prompt?: string;
    ai_provider?: string;
    ai_api_key?: string;
    ai_model?: string;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: 'Payload inválido' }, 400);
  }

  const { phone_number_id, waba_id, vendor_name, system_prompt, ai_provider, ai_api_key, ai_model } = body;

  if (!phone_number_id || !waba_id) {
    return json({ error: 'Faltan phone_number_id y/o waba_id' }, 400);
  }

  if (ai_provider && !VALID_PROVIDERS.includes(ai_provider)) {
    return json({ error: 'ai_provider inválido. Usa: anthropic, openai o google' }, 400);
  }

  // ── Obtener access_token ────────────────────────────────────────────────────

  let accessToken: string;

  if (body.access_token) {
    // Modo manual: el usuario pegó el token desde el dashboard de Meta
    accessToken = body.access_token;
  } else if (body.code) {
    // Modo OAuth: intercambiar el authorization code por un token
    if (!META_APP_ID || !META_APP_SECRET) {
      return json({ error: 'META_APP_ID / META_APP_SECRET no configurados en secrets de Supabase' }, 500);
    }

    // 1. Token de corta duración
    const shortResp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
      `client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${encodeURIComponent(body.code)}`
    );
    const shortData = await shortResp.json();

    if (!shortData.access_token) {
      return json({ error: 'No se pudo obtener token de Meta', detail: shortData }, 400);
    }

    // 2. Intentar canje por token de larga duración (60 días)
    const longResp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}` +
      `&fb_exchange_token=${shortData.access_token}`
    );
    const longData = await longResp.json();
    accessToken = longData.access_token ?? shortData.access_token;
  } else {
    return json({ error: 'Se requiere "code" (OAuth) o "access_token" (manual)' }, 400);
  }

  // ── Verificar que el token funciona y obtener el nombre del número ──────────

  let displayName = vendor_name ?? 'Canal Meta';
  try {
    const infoResp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phone_number_id}?fields=display_phone_number,verified_name&access_token=${accessToken}`
    );
    const info = await infoResp.json();
    if (info.verified_name) displayName = info.verified_name;
    if (info.error) {
      return json({ error: 'Token inválido o sin permisos sobre el número', detail: info.error }, 400);
    }
  } catch {
    // Si falla la verificación seguimos igualmente (puede ser token de prueba)
  }

  // ── Insertar o actualizar vendor en Supabase ─────────────────────────────────

  // Upsert por meta_phone_number_id (evita duplicados si el usuario vuelve a conectar)
  const { data: existing } = await supabase
    .from('vendors')
    .select('id')
    .eq('meta_phone_number_id', phone_number_id)
    .single();

  let vendorId: string;

  if (existing) {
    // Actualizar token (puede haber rotado)
    await supabase
      .from('vendors')
      .update({
        meta_access_token: accessToken,
        meta_waba_id:      waba_id,
        meta_verified:     true,
        ...(system_prompt ? { system_prompt } : {}),
      })
      .eq('id', existing.id);
    vendorId = existing.id;
  } else {
    const { data: created, error } = await supabase
      .from('vendors')
      .insert({
        name:                 displayName,
        channel_type:         'meta',
        meta_phone_number_id: phone_number_id,
        meta_waba_id:         waba_id,
        meta_access_token:    accessToken,
        meta_verified:        true,
        // Si no se eligió proveedor de IA al crear el canal, queda pendiente (se configura luego desde Configuración).
        ai_provider:          ai_provider || 'anthropic',
        ai_model:             ai_provider ? (ai_model || DEFAULT_MODEL[ai_provider]) : 'claude-sonnet-4-6',
        ai_api_key:           ai_api_key || '',
        system_prompt:        system_prompt ?? null,
      })
      .select('id')
      .single();

    if (error || !created) {
      return json({ error: error?.message ?? 'Error creando vendor' }, 500);
    }
    vendorId = created.id;
  }

  // ── Suscribir el WABA al webhook de la app ───────────────────────────────────
  // Sin esta llamada Meta verifica el webhook (GET) pero NO envía mensajes (POST).
  try {
    const subResp = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${waba_id}/subscribed_apps`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const subData = await subResp.json();
    if (!subData.success) {
      console.warn('WABA subscription warning:', JSON.stringify(subData));
    }
  } catch (e) {
    console.warn('WABA subscription error (no bloqueante):', e);
  }

  return json({ success: true, vendor_id: vendorId, display_name: displayName });
});
