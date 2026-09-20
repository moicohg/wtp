import { admin as supabase, getCaller, handleError, json, preflight, requirePermission, type Caller } from '../_shared/auth.ts';

// Conecta un canal de Meta (WhatsApp Cloud API). Exige sesión con el permiso
// config.manage_channels; el canal queda en la empresa del que llama.

const META_APP_ID     = Deno.env.get('META_APP_ID')!;
const META_APP_SECRET = Deno.env.get('META_APP_SECRET')!;
// PIN de 6 dígitos con el que se registra cada número nuevo en Cloud API
// (verificación en dos pasos). Sin él, el registro se omite.
const REGISTER_PIN    = Deno.env.get('META_REGISTER_PIN') ?? '';
const GRAPH_VERSION   = 'v20.0';

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  google:    'gemini-2.0-flash',
};
const VALID_PROVIDERS = ['anthropic', 'openai', 'google'];

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  let caller: Caller;
  try {
    caller = await getCaller(req);
    requirePermission(caller, 'config.manage_channels');
  } catch (err) {
    return handleError(err);
  }

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
    .select('id, organization_id')
    .eq('meta_phone_number_id', phone_number_id)
    .single();

  let vendorId: string;

  if (existing) {
    if (existing.organization_id && existing.organization_id !== caller.organizationId) {
      return json({ error: 'Ese número de WhatsApp ya está conectado en otra empresa' }, 409);
    }
    // Actualizar token (puede haber rotado)
    await supabase
      .from('vendors')
      .update({
        meta_access_token: accessToken,
        meta_waba_id:      waba_id,
        meta_verified:     true,
        organization_id:   caller.organizationId,
        ...(system_prompt ? { system_prompt } : {}),
      })
      .eq('id', existing.id);
    vendorId = existing.id;
  } else {
    const { data: created, error } = await supabase
      .from('vendors')
      .insert({
        name:                 displayName,
        organization_id:      caller.organizationId,
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
      const msg = error?.message ?? 'Error creando vendor';
      const limit = msg.match(/LIMITE_CANALES:(\d+)/);
      if (limit) {
        return json({ error: `Tu empresa alcanzó el límite de ${limit[1]} canales de WhatsApp` }, 409);
      }
      return json({ error: msg }, 500);
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

  // ── Registrar el número en Cloud API (solo Embedded Signup) ──────────────────
  // Un número recién agregado por Embedded Signup no envía ni recibe hasta que se
  // registra. En modo manual el número ya vino configurado desde el panel de Meta.
  if (body.code) {
    if (!/^\d{6}$/.test(REGISTER_PIN)) {
      console.warn('META_REGISTER_PIN no configurado (6 dígitos): se omite el registro del número');
    } else {
      try {
        const regResp = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${phone_number_id}/register`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', pin: REGISTER_PIN }),
          }
        );
        const regData = await regResp.json();
        if (!regData.success) {
          console.warn('Phone register warning:', JSON.stringify(regData));
        }
      } catch (e) {
        console.warn('Phone register error (no bloqueante):', e);
      }
    }
  }

  return json({ success: true, vendor_id: vendorId, display_name: displayName });
});
