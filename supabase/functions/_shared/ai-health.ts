import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Salud de la IA por canal: clasifica los fallos de la API del proveedor, los deja registrados en
// vendors (el panel los muestra) y avisa una sola vez por WhatsApp al equipo.

export type AIErrorKind = 'credits' | 'key' | 'rate' | 'model' | 'other';

export class AIError extends Error {
  constructor(public kind: AIErrorKind, public detail: string) {
    super(detail);
  }
}

const KIND_LABEL: Record<AIErrorKind, string> = {
  credits: 'se acabó el saldo/créditos de la API',
  key: 'la clave de la API es inválida o fue revocada',
  rate: 'se alcanzó el límite de uso de la API',
  model: 'el modelo configurado no existe o no está disponible',
  other: 'la API de la IA no está respondiendo',
};

export function classifyAIError(status: number, body: unknown): AIError {
  const raw = (typeof body === 'string' ? body : JSON.stringify(body ?? '')).slice(0, 300);
  const t = raw.toLowerCase();
  let kind: AIErrorKind = 'other';
  if (/credit balance|insufficient|billing|quota|balance|payment/.test(t)) kind = 'credits';
  else if (status === 401 || status === 403 || /api key|api_key|x-api-key/.test(t)) kind = 'key';
  else if (status === 404 || /model/.test(t)) kind = 'model';
  else if (status === 429) kind = 'rate';
  return new AIError(kind, `HTTP ${status}: ${raw}`.replace(/(sk-|AIza)[\w-]+/g, '$1…'));
}

interface HealthVendor {
  id: string;
  organization_id: string;
  name: string;
  phone_number: string | null;
  ai_error_at?: string | null;
  ai_last_ok_at?: string | null;
}

// Respuesta correcta: limpia el error y refresca la marca de "última vez que funcionó".
export async function recordAIOk(supabase: SupabaseClient, v: HealthVendor): Promise<void> {
  const fresh = v.ai_last_ok_at && Date.now() - new Date(v.ai_last_ok_at).getTime() < 10 * 60_000;
  if (fresh && !v.ai_error_at) return;
  await supabase
    .from('vendors')
    .update({ ai_last_ok_at: new Date().toISOString(), ai_error_kind: null, ai_error_detail: null, ai_error_at: null, ai_alerted_at: null })
    .eq('id', v.id);
}

// Falla de la IA: se marca el canal y, solo la primera vez, se avisa por WhatsApp.
export async function recordAIError(supabase: SupabaseClient, v: HealthVendor, err: AIError): Promise<void> {
  const { data: row } = await supabase.from('vendors').select('ai_alerted_at, ai_error_at').eq('id', v.id).maybeSingle();
  const now = new Date().toISOString();
  const alreadyAlerted = Boolean(row?.ai_alerted_at);
  await supabase
    .from('vendors')
    .update({
      ai_error_kind: err.kind,
      ai_error_detail: err.detail.slice(0, 300),
      ai_error_at: row?.ai_error_at ?? now,
      ai_alerted_at: row?.ai_alerted_at ?? now,
    })
    .eq('id', v.id);
  if (alreadyAlerted) return;
  try {
    await alertAIError(supabase, v, err);
  } catch (e) {
    console.error('[ia-salud] no se pudo enviar el aviso:', e);
  }
}

// El aviso sale por los canales QR conectados de la empresa (Meta no permite texto libre fuera de 24 h).
async function alertAIError(supabase: SupabaseClient, v: HealthVendor, err: AIError): Promise<void> {
  const url = Deno.env.get('EVOLUTION_API_URL');
  const key = Deno.env.get('EVOLUTION_API_KEY');
  if (!url || !key) return;

  const [{ data: senders }, { data: settings }] = await Promise.all([
    supabase.from('vendors').select('evolution_instance_id').eq('organization_id', v.organization_id).eq('channel_type', 'evolution').eq('evolution_connected', true),
    supabase.from('availability_settings').select('alert_phones').eq('organization_id', v.organization_id).maybeSingle(),
  ]);
  const recipients = [...new Set([v.phone_number, ...(settings?.alert_phones ?? [])].map((p: string | null) => (p ?? '').replace(/\D/g, '')).filter(Boolean))];
  const instances = (senders ?? []).map((s: { evolution_instance_id: string | null }) => s.evolution_instance_id).filter(Boolean) as string[];
  if (!recipients.length || !instances.length) {
    console.warn('[ia-salud] sin destinatarios o sin canal QR conectado para avisar; solo banner. Canal:', v.name);
    return;
  }

  const text =
    `🚨 *El bot del canal "${v.name}" NO está respondiendo.*\n\n` +
    `Motivo: ${KIND_LABEL[err.kind]}.\n` +
    `Los mensajes de tus clientes se guardan, pero nadie les contesta. Entra al CRM → Canales y revisa la configuración de IA (recarga saldo o cambia la clave).`;

  for (const phone of recipients) {
    for (const instance of instances) {
      try {
        const resp = await fetch(`${url}/message/sendText/${encodeURIComponent(instance)}`, {
          method: 'POST',
          headers: { apikey: key, 'content-type': 'application/json' },
          body: JSON.stringify({ number: phone, text }),
        });
        if (resp.ok) break;
      } catch (e) {
        console.warn('[ia-salud] error enviando por', instance, e);
      }
    }
  }
}
