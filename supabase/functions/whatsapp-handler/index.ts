import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { detectAppointment } from '../_shared/appointments.ts';
import { aiAllowed, getOrgUsage, storageAllowed } from '../_shared/limits.ts';
import { understandMedia } from '../_shared/media-ai.ts';

// ── Tipos ────────────────────────────────────────────────────────────────────

interface Vendor {
  id: string;
  organization_id: string;
  name: string;
  phone_number: string | null;
  evolution_instance_id: string;
  ai_provider: 'anthropic' | 'openai' | 'google';
  ai_model: string;
  ai_api_key: string;
  system_prompt: string | null;
}

interface Prospect {
  id: string;
  vendor_id: string;
  phone: string;
  nombre: string;
  tipo_operacion: string | null;
  zona: string | null;
  presupuesto: number | null;
  presupuesto_moneda: string;
  tipo_inmueble: string | null;
  horizonte_meses: number | null;
  tiene_fondos: boolean | null;
  es_decisor: boolean;
  menciona_requisitos: boolean;
  score: number;
  label: string;
  conversation_step: string;
  retries_current_step: number;
  evasive_count: number;
  ia_enabled: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeReply {
  reply: string;
  extracted: {
    tipo_operacion?: string | null;
    zona?: string | null;
    presupuesto?: number | null;
    tipo_inmueble?: string | null;
    horizonte_meses?: number | null;
    tiene_fondos?: boolean | null;
    es_decisor?: boolean | null;
    menciona_requisitos?: boolean | null;
    nombre?: string | null;
  };
  score: number | null;
  label: 'CALIFICADO' | 'TIBIO' | 'FRIO' | 'DESCARTADO' | null;
  conversation_step: string;
  evasive_count: number;
}

// ── System prompt por defecto ────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `Eres Alia, asistente virtual de una agencia inmobiliaria. Tu único objetivo en esta conversación es calificar al prospecto en máximo 3 intercambios: saber si tiene presupuesto real, en qué zona busca y si puede comprar pronto. Eres cálida, profesional y directa. No eres un portal de búsqueda: no listes propiedades, no cotices sin asesor.

RESTRICCIONES:
- Nunca listes o describas propiedades específicas en esta fase.
- Nunca pidas CURP, RFC, datos bancarios ni documentos.
- Si el usuario pide hablar con una persona, activa transferencia a asesor.
- Si detectas señales de curioso (evasión de presupuesto, "solo viendo"), cierra amablemente sin presionar.
- Completa el flujo en máximo 3 turnos; no hagas preguntas adicionales fuera del guion.
- Responde siempre en español mexicano informal-profesional.

FLUJO DE CALIFICACIÓN (3 pasos):
- paso_0: Saluda, pregunta tipo de operación (compra/renta) y presupuesto en un solo mensaje.
  - Si renta → conversation_step: "derivar_renta"
  - Si presupuesto < $800,000 MXN → conversation_step: "descarte_presupuesto"
  - Si ok → conversation_step: "paso_1"
- paso_1: Pregunta zona de interés y tipo de inmueble (casa/depto/terreno).
  - conversation_step: "paso_2"
- paso_2: Pregunta horizonte de compra (meses), si tiene fondos o crédito, y si es quien toma la decisión.
  - Calcula score y determina label.
  - conversation_step: "calificado" | "tibio" | "frio"

SISTEMA DE SCORING (suma de puntos, resultado 0-100):
- Presupuesto: <$800k→descarte; $800k-$1.5M→+15; $1.5M-$4M→+25; >$4M→+35
- Horizonte: ≤2 meses→+30; 3-6 meses→+20; 7-12 meses→+10; >12 meses→+0
- Fondos: tiene_fondos=true→+25; false con horizonte≤6m→+10; false con horizonte>6m→-10
- Decisor: es_decisor=true→+10; false→-5
- Señales negativas: frases de "solo viendo"→-20; evasión repetida (evasive_count≥2)→-25
- Señales positivas: zona definida→+5; tipo_inmueble definido→+5; menciona requisitos específicos→+5
- CALIFICADO: score≥70 (prioridad ALTA); TIBIO: 40-69 (prioridad MEDIA); FRÍO: <40 (prioridad BAJA)

RESPUESTA: Siempre responde en JSON con esta estructura exacta (sin texto adicional fuera del JSON):
{
  "reply": "<texto amigable para enviar al prospecto por WhatsApp>",
  "extracted": {
    "tipo_operacion": "compra" | "renta" | null,
    "zona": "<texto o null>",
    "presupuesto": <número en MXN o null>,
    "tipo_inmueble": "casa" | "departamento" | "terreno" | null,
    "horizonte_meses": <número o null>,
    "tiene_fondos": true | false | null,
    "es_decisor": true | false | null,
    "menciona_requisitos": true | false,
    "nombre": "<nombre del prospecto si lo mencionó o null>"
  },
  "score": <número 0-100 o null si aún no tienes suficiente info para calcular>,
  "label": "CALIFICADO" | "TIBIO" | "FRIO" | "DESCARTADO" | null,
  "conversation_step": "<paso siguiente>",
  "evasive_count": <número>
}`;

// ── Supabase client (service_role bypasses RLS) ───────────────────────────────

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL')!;
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY')!;

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Adjuntos entrantes ───────────────────────────────────────────────────────

type MediaType = 'image' | 'video' | 'audio' | 'document';

interface IncomingMedia {
  type: MediaType;
  caption: string;
  fileName: string | null;
}

function extractMedia(msg: Record<string, any> | undefined): IncomingMedia | null {
  if (!msg) return null;
  if (msg.imageMessage) return { type: 'image', caption: msg.imageMessage.caption ?? '', fileName: null };
  if (msg.videoMessage) return { type: 'video', caption: msg.videoMessage.caption ?? '', fileName: null };
  if (msg.audioMessage) return { type: 'audio', caption: '', fileName: null };
  if (msg.stickerMessage) return { type: 'image', caption: '', fileName: null };
  const doc = msg.documentMessage ?? msg.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) return { type: 'document', caption: doc.caption ?? '', fileName: doc.fileName ?? null };
  return null;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf',
};

// Pide el archivo a Evolution (en base64) y lo sube al bucket público chat-media.
async function storeIncomingMedia(
  instanceId: string,
  messageId: string,
  media: IncomingMedia,
  organizationId: string,
  prospectId: string
): Promise<{ url: string; bytes: Uint8Array; base64: string; mime: string } | null> {
  try {
    const resp = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceId)}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: false }),
    });
    if (!resp.ok) {
      console.error('[media] Evolution respondió', resp.status, (await resp.text()).slice(0, 200));
      return null;
    }
    const data = await resp.json();
    const base64 = String(data.base64 ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) return null;

    const mime = String(data.mimetype ?? '').split(';')[0];
    const ext = MIME_EXT[mime] ?? (media.fileName?.split('.').pop() || media.type);
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const path = `${organizationId}/${prospectId}/in-${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
    const { error } = await supabase.storage.from('chat-media').upload(path, bytes, { contentType: mime || undefined });
    if (error) {
      console.error('[media] no se pudo subir a chat-media:', error.message);
      return null;
    }
    return { url: supabase.storage.from('chat-media').getPublicUrl(path).data.publicUrl, bytes, base64, mime };
  } catch (e) {
    console.error('[media] error descargando adjunto:', e);
    return null;
  }
}


async function getOrCreateProspect(phone: string, vendorId: string): Promise<Prospect> {
  const { data: existing } = await supabase
    .from('prospects')
    .select('*')
    .eq('vendor_id', vendorId)
    .eq('phone', phone)
    .single();

  if (existing) return existing as Prospect;

  const { data: created, error } = await supabase
    .from('prospects')
    .insert({ phone, vendor_id: vendorId, conversation_step: 'paso_0' })
    .select('*')
    .single();

  if (error || !created) throw new Error(`Error creando prospect: ${error?.message}`);
  return created as Prospect;
}

async function callAI(vendor: Vendor, history: Message[], messageText: string, prospect: Prospect): Promise<ClaudeReply> {
  const systemPrompt = vendor.system_prompt ?? DEFAULT_SYSTEM_PROMPT;

  const contextNote = `\n[CONTEXTO ACTUAL DEL PROSPECTO: paso=${prospect.conversation_step}, evasive_count=${prospect.evasive_count}, score_actual=${prospect.score}]`;

  if (vendor.ai_provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': vendor.ai_api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: vendor.ai_model,
        max_tokens: 400,
        system: systemPrompt + contextNote,
        messages: [
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: messageText },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) console.error('[ia:anthropic] HTTP', response.status, JSON.stringify(data?.error ?? data).slice(0, 300));
    return parseAIResponse(data.content?.[0]?.text ?? '');
  }

  if (vendor.ai_provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vendor.ai_api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: vendor.ai_model,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt + contextNote },
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: messageText },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) console.error('[ia:openai] HTTP', response.status, JSON.stringify(data?.error ?? data).slice(0, 300));
    return parseAIResponse(data.choices?.[0]?.message?.content ?? '');
  }

  if (vendor.ai_provider === 'google') {
    const model = vendor.ai_model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${vendor.ai_api_key}`;
    const contents = [
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: messageText }] },
    ];
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt + contextNote }] },
        contents,
        generationConfig: { maxOutputTokens: 400 },
      }),
    });
    const data = await response.json();
    if (!response.ok) console.error('[ia:google] HTTP', response.status, JSON.stringify(data?.error ?? data).slice(0, 300));
    return parseAIResponse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  }

  throw new Error(`Proveedor de IA no soportado: ${vendor.ai_provider}`);
}

function parseAIResponse(text: string): ClaudeReply {
  try {
    // Extraer JSON aunque venga envuelto en markdown (```json ... ```)
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
    const jsonStr = match ? match[1] : text;
    return JSON.parse(jsonStr) as ClaudeReply;
  } catch {
    return {
      reply: text || 'Disculpa, hubo un problema procesando tu mensaje. ¿Puedes intentarlo de nuevo?',
      extracted: {},
      score: null,
      label: null,
      conversation_step: 'paso_0',
      evasive_count: 0,
    };
  }
}

function derivePriority(label: string | null): string {
  if (label === 'CALIFICADO') return 'ALTA';
  if (label === 'TIBIO') return 'MEDIA';
  if (label === 'FRIO') return 'BAJA';
  return 'NINGUNA';
}

async function sendWhatsApp(instanceId: string, toPhone: string, text: string): Promise<void> {
  await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceId}`, {
    method: 'POST',
    headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ number: toPhone, text }),
  });
}

// ── Caída de la sesión de WhatsApp ───────────────────────────────────────────

// 'open' reconecta; 'close' es la caída real (teléfono desvinculado, sesión cerrada).
// 'connecting' es un reintento en curso y no cambia nada.
async function handleConnectionUpdate(instanceId: string, state: string): Promise<void> {
  if (state === 'open') {
    await supabase
      .from('vendors')
      .update({ evolution_connected: true, evolution_disconnected_at: null, evolution_alerted_at: null })
      .eq('evolution_instance_id', instanceId);
    return;
  }
  if (state !== 'close') return;

  const { data: v } = await supabase
    .from('vendors')
    .select('id, name, organization_id, phone_number, assigned_agent_id, evolution_disconnected_at, evolution_alerted_at')
    .eq('evolution_instance_id', instanceId)
    .maybeSingle();
  if (!v) return;

  // Se marca primero la caída y el aviso: así un evento repetido no manda el mensaje dos veces.
  const now = new Date().toISOString();
  const alreadyAlerted = Boolean(v.evolution_alerted_at);
  await supabase
    .from('vendors')
    .update({
      evolution_connected: false,
      evolution_disconnected_at: v.evolution_disconnected_at ?? now,
      evolution_alerted_at: v.evolution_alerted_at ?? now,
    })
    .eq('id', v.id);
  if (alreadyAlerted) return;

  try {
    await alertDisconnection(v);
  } catch (e) {
    console.error('[desconexion] no se pudo enviar el aviso:', e);
  }
}

// El canal caído no puede enviar: el aviso sale por otro canal QR conectado de la misma empresa.
// Se prueba con cada canal candidato hasta que uno envíe (la marca "conectado" puede estar desfasada).
// Si ninguno sirve queda el banner del panel (Meta solo permite texto libre dentro de las 24 h).
async function alertDisconnection(v: {
  id: string; name: string; organization_id: string; phone_number: string | null; assigned_agent_id: string | null;
}): Promise<void> {
  const [{ data: senders }, { data: agent }] = await Promise.all([
    supabase
      .from('vendors')
      .select('evolution_instance_id')
      .eq('organization_id', v.organization_id)
      .eq('channel_type', 'evolution')
      .eq('evolution_connected', true)
      .neq('id', v.id),
    v.assigned_agent_id
      ? supabase.from('agents').select('phone').eq('id', v.assigned_agent_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const recipients = [...new Set([v.phone_number, agent?.phone].map(p => (p ?? '').replace(/\D/g, '')).filter(Boolean))];
  if (!recipients.length) {
    console.warn('[desconexion] el canal', v.name, 'no tiene teléfono de asesor a quien avisar');
    return;
  }
  const instances = (senders ?? []).map(s => s.evolution_instance_id).filter(Boolean) as string[];
  if (!instances.length) {
    console.warn('[desconexion] no hay otro canal QR conectado para avisar; solo banner. Canal:', v.name);
    return;
  }

  const text =
    `⚠️ *El canal "${v.name}" perdió la conexión de WhatsApp.*\n\n` +
    `El bot no está respondiendo a tus clientes. Entra al CRM → Canales y pulsa *Reconectar con QR* para volver a vincularlo.`;

  for (const phone of recipients) {
    let sent = false;
    for (const instance of instances) {
      try {
        const resp = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instance)}`, {
          method: 'POST',
          headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ number: phone, text }),
        });
        if (resp.ok) {
          sent = true;
          break;
        }
        console.warn('[desconexion] el canal', instance, 'no pudo enviar el aviso:', resp.status, (await resp.text()).slice(0, 160));
      } catch (e) {
        console.warn('[desconexion] error enviando por', instance, e);
      }
    }
    if (!sent) console.error('[desconexion] no se pudo avisar a', phone, 'por ningún canal conectado. Canal caído:', v.name);
  }
}

// ── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Parsear payload de Evolution API
  const instanceId = body.instance as string;
  const data = body.data as Record<string, unknown> | undefined;

  // Estado de la sesión de WhatsApp: mantiene al día si el QR sigue vinculado y avisa si se cae.
  if (body.event === 'connection.update' && instanceId && data?.state) {
    await handleConnectionUpdate(instanceId, String(data.state));
    return new Response('ok');
  }

  if (!instanceId || !data) {
    return new Response('ok'); // evento no relevante
  }

  const key = data.key as Record<string, unknown> | undefined;
  if (!key || key.fromMe === true) {
    return new Response('ok'); // ignorar mensajes propios
  }

  const remoteJid = key.remoteJid as string | undefined;
  if (!remoteJid || remoteJid.endsWith('@g.us')) {
    return new Response('ok'); // ignorar grupos
  }

  // WhatsApp a veces identifica al contacto con un LID (...@lid) y deja su número real en remoteJidAlt.
  const realJid = remoteJid.endsWith('@lid') && typeof key.remoteJidAlt === 'string' ? key.remoteJidAlt : remoteJid;
  const phone = realJid.replace(/@.*$/, '');

  const messageObj = data.message as Record<string, unknown> | undefined;
  const messageText =
    (messageObj?.conversation as string) ||
    ((messageObj?.extendedTextMessage as Record<string, unknown>)?.text as string) ||
    '';

  const media = extractMedia(messageObj);
  const caption = media?.caption ?? '';
  const incomingText = messageText.trim() || caption.trim();

  if (!incomingText && !media) {
    return new Response('ok'); // ignorar mensajes sin texto ni adjunto (reacciones, etc.)
  }

  try {
    // 1. Buscar vendor por evolution_instance_id
    const { data: vendorData, error: vendorError } = await supabase
      .from('vendors')
      .select('*')
      .eq('evolution_instance_id', instanceId)
      .single();

    if (vendorError || !vendorData) {
      console.error('Vendor no encontrado para instancia:', instanceId);
      return new Response('ok');
    }
    const vendor = vendorData as Vendor;

    // 2. Buscar o crear prospect
    const prospect = await getOrCreateProspect(phone, vendor.id);

    // 3. Cargar historial de mensajes
    const { data: historyRows } = await supabase
      .from('messages')
      .select('role, content')
      .eq('prospect_id', prospect.id)
      .order('created_at', { ascending: true })
      .limit(20);

    const history = (historyRows ?? []) as Message[];

    // 4. Guardar mensaje del usuario ANTES de la IA (persiste aunque la IA falle)
    // Si trae adjunto, se baja de Evolution y se sube a chat-media para que el panel lo muestre.
    // Topes del plan: sin espacio no se guarda el archivo (el mensaje sí), y sin cupo de IA el bot no responde.
    const usage = await getOrgUsage(supabase, vendor.organization_id);
    const roomForMedia = storageAllowed(usage);
    const stored = media && roomForMedia ? await storeIncomingMedia(instanceId, key.id as string, media, vendor.organization_id, prospect.id) : null;

    // La IA lee el adjunto solo si el bot va a responder (clave, IA activa en el lead, cupo y plan vigente):
    // nota de voz -> transcripción; imagen -> descripción. Si falla, queda guardado para una persona.
    const botWillReply = Boolean(vendor.ai_api_key) && prospect.ia_enabled && aiAllowed(usage);
    const understood =
      stored && botWillReply && (media!.type === 'audio' || media!.type === 'image')
        ? await understandMedia(vendor, media!.type as 'audio' | 'image', stored)
        : null;

    // chatText: lo que ve el equipo en el chat. aiText: lo que lee el bot.
    const isVoice = media?.type === 'audio' && understood;
    const chatText = isVoice ? `🎙 ${understood}` : [incomingText, understood && `🖼 ${understood}`].filter(Boolean).join('\n');
    const aiText = isVoice
      ? understood!
      : understood
        ? `[El cliente envió una imagen. Lo que muestra: ${understood}]${incomingText ? ` Mensaje del cliente: ${incomingText}` : ''}`
        : incomingText;

    await supabase.from('messages').insert([
      {
        prospect_id: prospect.id,
        role: 'user',
        content: chatText || (media && !roomForMedia ? '📎 Adjunto no guardado: se alcanzó el límite de almacenamiento del plan' : ''),
        media_url: stored?.url ?? null,
        media_type: stored ? media!.type : null,
      },
    ]);

    // Sin texto que la IA pueda leer (audio sin transcribir, imagen sin pie ni descripción): atiende una persona.
    if (!aiText) return new Response('ok', { status: 200 });

    if (!vendor.ai_api_key || !prospect.ia_enabled) {
      console.warn('[vendor] sin ai_api_key o ia_enabled=false — mensaje guardado pero sin respuesta IA. vendor_id:', vendor.id);
      return new Response('ok', { status: 200 });
    }

    if (!aiAllowed(usage)) {
      console.warn('[limites] cupo mensual de IA agotado — mensaje guardado sin respuesta. org:', vendor.organization_id);
      return new Response('ok', { status: 200 });
    }

    // 5. Llamar a la IA con la api_key del vendor
    const aiReply = await callAI(vendor, history, aiText, prospect);

    // 6. Guardar respuesta del asistente
    await supabase.from('messages').insert([
      { prospect_id: prospect.id, role: 'assistant', content: aiReply.reply, by_ai: true },
    ]);

    // 7. Actualizar prospect con datos extraídos y score
    const updates: Record<string, unknown> = {
      conversation_step: aiReply.conversation_step ?? prospect.conversation_step,
      evasive_count: aiReply.evasive_count ?? prospect.evasive_count,
    };
    if (aiReply.score !== null && aiReply.score !== undefined) {
      updates.score = aiReply.score;
    }
    if (aiReply.label) {
      updates.label = aiReply.label;
      updates.prioridad = derivePriority(aiReply.label);
    }
    const ext = aiReply.extracted ?? {};
    if (ext.tipo_operacion !== undefined && ext.tipo_operacion !== null) updates.tipo_operacion = ext.tipo_operacion;
    if (ext.zona !== undefined && ext.zona !== null) updates.zona = ext.zona;
    if (ext.presupuesto !== undefined && ext.presupuesto !== null) updates.presupuesto = ext.presupuesto;
    if (ext.tipo_inmueble !== undefined && ext.tipo_inmueble !== null) updates.tipo_inmueble = ext.tipo_inmueble;
    if (ext.horizonte_meses !== undefined && ext.horizonte_meses !== null) updates.horizonte_meses = ext.horizonte_meses;
    if (ext.tiene_fondos !== undefined && ext.tiene_fondos !== null) updates.tiene_fondos = ext.tiene_fondos;
    if (ext.es_decisor !== undefined && ext.es_decisor !== null) updates.es_decisor = ext.es_decisor;
    if (ext.menciona_requisitos !== undefined) updates.menciona_requisitos = ext.menciona_requisitos;
    if (ext.nombre !== undefined && ext.nombre !== null && ext.nombre !== '') updates.nombre = ext.nombre;

    await supabase.from('prospects').update(updates).eq('id', prospect.id);

    // 7. Enviar respuesta al prospecto vía Evolution API
    await sendWhatsApp(instanceId, phone, aiReply.reply);

    // 7b. ¿Quedó una cita? No bloquea la respuesta ya enviada.
    try {
      await detectAppointment(supabase, vendor, prospect, history, aiText, aiReply.reply);
    } catch (e) {
      console.warn('[agenda] no se pudo detectar cita:', e);
    }

    // 8. Notificar al vendedor si el prospecto queda CALIFICADO
    if (aiReply.label === 'CALIFICADO' && vendor.phone_number) {
      const score = aiReply.score ?? prospect.score;
      const zona = ext.zona ?? prospect.zona ?? 'zona no especificada';
      const presupuesto = ext.presupuesto ?? prospect.presupuesto;
      const presStr = presupuesto
        ? `$${presupuesto.toLocaleString('es-MX')} MXN`
        : 'presupuesto no capturado';
      const notif = `🏠 *Nuevo prospecto CALIFICADO*\n\n📱 Teléfono: ${phone}\n⭐ Score: ${score}/100\n📍 Zona: ${zona}\n💰 Presupuesto: ${presStr}\n\nResponde a su WhatsApp para contactarlo.`;
      await sendWhatsApp(instanceId, vendor.phone_number, notif);
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('Error en whatsapp-handler:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
});
