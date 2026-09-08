import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Envío manual de mensajes desde el dashboard ───────────────────────────────
// Contraparte "saliente" de whatsapp-handler/meta-webhook: esas dos funciones
// solo reaccionan a webhooks entrantes y responden con la IA. Esta función la
// llama el panel cuando un humano escribe (o adjunta un archivo) desde el chat
// del canal. media_url debe ser una URL pública (el bucket "chat-media" ya lo es).

type MediaType = 'image' | 'video' | 'audio' | 'document';

interface Vendor {
  id: string;
  channel_type: 'evolution' | 'meta';
  evolution_instance_id: string | null;
  meta_phone_number_id: string | null;
  meta_access_token: string | null;
}

interface Prospect {
  id: string;
  vendor_id: string;
  phone: string;
}

const GRAPH_VERSION = 'v20.0';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL');
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function sendEvolutionText(instanceId: string, toPhone: string, text: string): Promise<void> {
  const resp = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceId}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ number: toPhone, text }),
  });
  if (!resp.ok) throw new Error(`Evolution API respondió ${resp.status}: ${await resp.text()}`);
}

async function sendEvolutionMedia(
  instanceId: string,
  toPhone: string,
  mediaType: MediaType,
  mediaUrl: string,
  caption: string,
  fileName: string | undefined
): Promise<void> {
  if (mediaType === 'audio') {
    const resp = await fetch(`${EVOLUTION_API_URL}/message/sendWhatsAppAudio/${instanceId}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ number: toPhone, audio: mediaUrl }),
    });
    if (!resp.ok) throw new Error(`Evolution API (audio) respondió ${resp.status}: ${await resp.text()}`);
    return;
  }
  const resp = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceId}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ number: toPhone, mediatype: mediaType, media: mediaUrl, caption, fileName }),
  });
  if (!resp.ok) throw new Error(`Evolution API (media) respondió ${resp.status}: ${await resp.text()}`);
}

async function sendMetaText(phoneNumberId: string, accessToken: string, toPhone: string, text: string): Promise<void> {
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: text } }),
  });
  if (!resp.ok) throw new Error(`Meta Graph API respondió ${resp.status}: ${await resp.text()}`);
}

async function sendMetaMedia(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  mediaType: MediaType,
  mediaUrl: string,
  caption: string,
  fileName: string | undefined
): Promise<void> {
  const mediaPayload: Record<string, unknown> = { link: mediaUrl };
  if (mediaType === 'document') {
    mediaPayload.filename = fileName ?? 'archivo';
  }
  if ((mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && caption) {
    mediaPayload.caption = caption;
  }
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: mediaType, [mediaType]: mediaPayload }),
  });
  if (!resp.ok) throw new Error(`Meta Graph API (media) respondió ${resp.status}: ${await resp.text()}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body: {
    prospect_id?: string;
    text?: string;
    media_url?: string;
    media_type?: MediaType;
    file_name?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Payload inválido' }, 400);
  }

  const prospectId = body.prospect_id;
  const text = body.text?.trim() ?? '';
  const mediaUrl = body.media_url;
  const mediaType = body.media_type;
  const fileName = body.file_name;

  if (!prospectId || (!text && !mediaUrl)) return json({ error: 'Faltan prospect_id y/o text/media_url' }, 400);

  const { data: prospect, error: prospectError } = await supabase
    .from('prospects')
    .select('id, vendor_id, phone')
    .eq('id', prospectId)
    .single();
  if (prospectError || !prospect) return json({ error: 'Prospecto no encontrado' }, 404);

  const { data: vendor, error: vendorError } = await supabase
    .from('vendors')
    .select('id, channel_type, evolution_instance_id, meta_phone_number_id, meta_access_token')
    .eq('id', (prospect as Prospect).vendor_id)
    .single();
  if (vendorError || !vendor) return json({ error: 'Canal no encontrado' }, 404);

  const v = vendor as Vendor;
  const p = prospect as Prospect;

  try {
    if (v.channel_type === 'evolution') {
      if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
        throw new Error('EVOLUTION_API_URL / EVOLUTION_API_KEY no configurados en secrets de Supabase');
      }
      if (!v.evolution_instance_id) throw new Error('El canal no tiene evolution_instance_id configurado');
      if (mediaUrl && mediaType) {
        await sendEvolutionMedia(v.evolution_instance_id, p.phone, mediaType, mediaUrl, text, fileName);
      } else {
        await sendEvolutionText(v.evolution_instance_id, p.phone, text);
      }
    } else {
      if (!v.meta_phone_number_id || !v.meta_access_token) throw new Error('El canal no tiene credenciales de Meta configuradas');
      if (mediaUrl && mediaType) {
        await sendMetaMedia(v.meta_phone_number_id, v.meta_access_token, p.phone, mediaType, mediaUrl, text, fileName);
      } else {
        await sendMetaText(v.meta_phone_number_id, v.meta_access_token, p.phone, text);
      }
    }
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    return json({ error: err instanceof Error ? err.message : 'Error enviando el mensaje' }, 502);
  }

  const { data: saved, error: saveError } = await supabase
    .from('messages')
    .insert({ prospect_id: p.id, role: 'assistant', content: text, media_url: mediaUrl ?? null, media_type: mediaType ?? null })
    .select('*')
    .single();
  if (saveError) return json({ error: `Mensaje enviado pero no se pudo guardar: ${saveError.message}` }, 500);

  return json({ success: true, message: saved });
});
