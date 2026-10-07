import { admin, getCaller, handleError, HttpError, json, preflight, requirePermission } from '../_shared/auth.ts';

// Conexión por QR de un canal Evolution API. El panel nunca habla con Evolution:
// esta función crea la instancia, registra el webhook hacia whatsapp-handler y
// devuelve el QR. Exige sesión con config.manage_channels y trabaja siempre
// dentro de la empresa del que llama.
//
// Acciones (body.action):
//   create  → crea el canal + la instancia y devuelve el primer QR
//   status  → dice si ya se escaneó; si no, devuelve un QR fresco
//   delete  → borra la instancia y el canal (también sirve para cancelar el QR)

const EVOLUTION_API_URL = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
};

async function evolution(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    throw new HttpError(500, 'EVOLUTION_API_URL / EVOLUTION_API_KEY no configurados en secrets de Supabase');
  }
  let resp: Response;
  try {
    resp = await fetch(`${EVOLUTION_API_URL}${path}`, {
      method,
      headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con el servidor de Evolution API');
  }
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// Evolution devuelve el QR como base64 con o sin el prefijo data:image.
function toQrDataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.startsWith('data:image') ? raw : `data:image/png;base64,${raw}`;
}

async function loadVendor(vendorId: unknown, organizationId: string) {
  if (typeof vendorId !== 'string' || !vendorId) throw new HttpError(400, 'Falta vendor_id');
  const { data } = await admin
    .from('vendors')
    .select('id, evolution_instance_id, evolution_connected')
    .eq('id', vendorId)
    .eq('organization_id', organizationId)
    .eq('channel_type', 'evolution')
    .maybeSingle();
  if (!data?.evolution_instance_id) throw new HttpError(404, 'Canal no encontrado');
  return data as { id: string; evolution_instance_id: string; evolution_connected: boolean };
}

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const caller = await getCaller(req);
    requirePermission(caller, 'config.manage_channels');

    let body: Record<string, any>;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, 'Payload inválido');
    }

    // ── create ────────────────────────────────────────────────────────────────
    if (body.action === 'create') {
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, 'El nombre del canal es obligatorio');
      const provider = String(body.ai_provider ?? '');
      if (provider && !DEFAULT_MODEL[provider]) throw new HttpError(400, 'ai_provider inválido. Usa: anthropic, openai o google');

      const instanceName = `wtp-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

      // Primero la fila: reserva el cupo (el trigger de límite de canales falla aquí, antes de tocar Evolution).
      const { data: vendor, error } = await admin
        .from('vendors')
        .insert({
          name,
          organization_id: caller.organizationId,
          phone_number: String(body.phone_number ?? '').trim() || null,
          channel_type: 'evolution',
          evolution_instance_id: instanceName,
          evolution_connected: false,
          ai_provider: provider || 'anthropic',
          ai_model: provider ? String(body.ai_model || DEFAULT_MODEL[provider]) : 'claude-sonnet-4-6',
          ai_api_key: String(body.ai_api_key ?? ''),
        })
        .select('id')
        .single();
      if (error || !vendor) {
        const limit = error?.message.match(/LIMITE_CANALES:(\d+)/);
        if (limit) throw new HttpError(409, `Tu empresa alcanzó el límite de ${limit[1]} canales de WhatsApp`);
        throw new HttpError(500, error?.message ?? 'Error creando el canal');
      }

      const created = await evolution('POST', '/instance/create', {
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: {
          url: `${SUPABASE_URL}/functions/v1/whatsapp-handler`,
          byEvents: false,
          base64: false,
          // whatsapp-handler tiene verify_jwt: la clave anon solo pasa el gateway, no es identidad.
          headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        },
      });
      if (created.status >= 300) {
        await admin.from('vendors').delete().eq('id', vendor.id);
        console.error('Evolution create falló', created.status, JSON.stringify(created.data));
        throw new HttpError(502, `Evolution API no pudo crear la instancia (HTTP ${created.status})`);
      }

      return json({
        vendor_id: vendor.id,
        connected: false,
        qr: toQrDataUrl(created.data?.qrcode?.base64),
        pairing_code: created.data?.qrcode?.pairingCode ?? null,
      });
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (body.action === 'status') {
      const vendor = await loadVendor(body.vendor_id, caller.organizationId);
      const instance = encodeURIComponent(vendor.evolution_instance_id);

      const state = await evolution('GET', `/instance/connectionState/${instance}`);
      if (state.status >= 300) throw new HttpError(502, `Evolution API respondió ${state.status} al consultar el estado`);

      if (state.data?.instance?.state === 'open') {
        if (!vendor.evolution_connected) {
          await admin.from('vendors').update({ evolution_connected: true }).eq('id', vendor.id);
        }
        return json({ connected: true, qr: null });
      }

      // Aún sin escanear: el QR de Baileys caduca en ~1 min, se pide uno vigente.
      const fresh = await evolution('GET', `/instance/connect/${instance}`);
      return json({
        connected: false,
        qr: toQrDataUrl(fresh.data?.base64),
        pairing_code: fresh.data?.pairingCode ?? null,
      });
    }

    // ── delete ────────────────────────────────────────────────────────────────
    if (body.action === 'delete') {
      const vendor = await loadVendor(body.vendor_id, caller.organizationId);
      const removed = await evolution('DELETE', `/instance/delete/${encodeURIComponent(vendor.evolution_instance_id)}`);
      // 404 = la instancia ya no existe en Evolution; igual hay que limpiar el canal.
      if (removed.status >= 300 && removed.status !== 404) {
        throw new HttpError(502, `Evolution API respondió ${removed.status} al borrar la instancia`);
      }
      const { error } = await admin.from('vendors').delete().eq('id', vendor.id).eq('organization_id', caller.organizationId);
      if (error) throw new HttpError(500, error.message);
      return json({ success: true });
    }

    throw new HttpError(400, 'action inválida. Usa: create, status o delete');
  } catch (err) {
    return handleError(err);
  }
});
