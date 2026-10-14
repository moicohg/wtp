import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { detectAppointment } from '../_shared/appointments.ts';
import { settleBurst, withoutPending } from '../_shared/burst.ts';
import { agendaEnabled, aiAllowed, getOrgUsage } from '../_shared/limits.ts';
import { adReferralFromMeta, markAdOrigin } from '../_shared/origin.ts';

// ── Tipos ────────────────────────────────────────────────────────────────────

interface Vendor {
  id: string;
  organization_id: string;
  name: string;
  phone_number: string | null;
  meta_phone_number_id: string;
  meta_access_token: string;
  ai_provider: 'anthropic' | 'openai' | 'google';
  ai_model: string;
  ai_api_key: string;
  system_prompt: string | null;
}

interface Prospect {
  id: string;
  vendor_id: string;
  origen?: string | null;
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

interface AIReply {
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

// ── Constantes ───────────────────────────────────────────────────────────────

const GRAPH_VERSION = 'v25.0';

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
  "score": <número 0-100 o null si aún no tienes suficiente info>,
  "label": "CALIFICADO" | "TIBIO" | "FRIO" | "DESCARTADO" | null,
  "conversation_step": "<paso siguiente>",
  "evasive_count": <número>
}`;

// ── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ── Meta Graph API ───────────────────────────────────────────────────────────

async function sendMetaMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<void> {
  const resp = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Meta send error:', err);
  }
}

// ── Helpers (misma lógica que whatsapp-handler) ───────────────────────────────

async function getOrCreateProspect(phone: string, vendorId: string, iaEnabled = true): Promise<Prospect> {
  const { data: existing } = await supabase
    .from('prospects')
    .select('*')
    .eq('vendor_id', vendorId)
    .eq('phone', phone)
    .single();

  if (existing) return existing as Prospect;

  const { data: created, error } = await supabase
    .from('prospects')
    .insert({ phone, vendor_id: vendorId, conversation_step: 'paso_0', ...(iaEnabled ? {} : { ia_enabled: false }) })
    .select('*')
    .single();

  if (error || !created) throw new Error(`Error creando prospect: ${error?.message}`);
  return created as Prospect;
}

async function callAI(
  vendor: Vendor,
  history: Message[],
  messageText: string,
  prospect: Prospect
): Promise<AIReply> {
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
    return parseAIResponse(data.choices?.[0]?.message?.content ?? '');
  }

  if (vendor.ai_provider === 'google') {
    const model = vendor.ai_model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${vendor.ai_api_key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt + contextNote }] },
        contents: [
          ...history.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          { role: 'user', parts: [{ text: messageText }] },
        ],
        generationConfig: { maxOutputTokens: 400 },
      }),
    });
    const data = await response.json();
    return parseAIResponse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  }

  throw new Error(`Proveedor de IA no soportado: ${vendor.ai_provider}`);
}

function parseAIResponse(text: string): AIReply {
  try {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
    const jsonStr = match ? match[1] : text;
    return JSON.parse(jsonStr) as AIReply;
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

async function hasValidSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get('META_APP_SECRET');
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const received = header.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

// Espejo de los mensajes escritos desde la app de WhatsApp Business (coexistencia). Se guardan como
// respuesta humana (role assistant, sin by_ai/by_automation) para que el chat y la alerta de lead
// sin respuesta los vean. Si el dueño le escribe primero a alguien, ese lead nace con la IA apagada:
// es una conversación suya y el bot no debe responder encima.
async function handleMessageEchoes(value: Record<string, unknown>): Promise<void> {
  const phoneNumberId = (value.metadata as Record<string, unknown> | undefined)?.phone_number_id as string | undefined;
  const echoes = (value.message_echoes as Array<Record<string, unknown>>) ?? [];
  if (!phoneNumberId || !echoes.length) return;

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id')
    .eq('meta_phone_number_id', phoneNumberId)
    .eq('channel_type', 'meta')
    .single();
  if (!vendor) {
    console.error('[echo] vendor no encontrado para phone_number_id:', phoneNumberId);
    return;
  }

  for (const echo of echoes) {
    try {
      const to = String(echo.to ?? '').replace(/\D/g, '');
      const text = String(((echo.text as Record<string, unknown> | undefined)?.body as string) ?? '').trim();
      if (!to || echo.type !== 'text' || !text) {
        console.log('[echo] ignorado (no es texto o sin destinatario):', echo.type);
        continue;
      }
      const prospect = await getOrCreateProspect(to, vendor.id, false);

      // Meta puede reentregar el aviso: no duplicar el mismo texto en el último minuto.
      const since = new Date(Date.now() - 60_000).toISOString();
      const { data: dup } = await supabase
        .from('messages')
        .select('id')
        .eq('prospect_id', prospect.id)
        .eq('role', 'assistant')
        .eq('content', text)
        .gte('created_at', since)
        .limit(1);
      if (dup?.length) continue;

      await supabase.from('messages').insert({ prospect_id: prospect.id, role: 'assistant', content: text });
    } catch (e) {
      console.error('[echo] error guardando mensaje:', e);
    }
  }
}

// ── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // GET: verificación del webhook por parte de Meta
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = Deno.env.get('META_VERIFY_TOKEN');

    console.log('[GET] webhook verification:', { mode, tokenMatch: token === verifyToken, hasChallenge: !!challenge });

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = await req.text();

  // Meta firma cada POST con HMAC-SHA256 del cuerpo y el App Secret. Con
  // META_SIGNATURE_MODE=enforce se rechaza lo que no coincide; sin ese secreto solo se
  // registra el aviso (para comprobar con tráfico real que META_APP_SECRET es el correcto).
  if (!(await hasValidSignature(rawBody, req.headers.get('x-hub-signature-256')))) {
    if (Deno.env.get('META_SIGNATURE_MODE') === 'enforce') {
      console.error('[POST] firma inválida — rechazado');
      return new Response('Unauthorized', { status: 401 });
    }
    console.warn('[POST] firma inválida o ausente (modo registro: se procesa igual)');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.error('[POST] body parse error');
    return new Response('Bad Request', { status: 400 });
  }

  console.log('[POST] object:', body.object, '| entries:', (body.entry as unknown[])?.length ?? 0);

  // Meta solo envía eventos de whatsapp_business_account
  if (body.object !== 'whatsapp_business_account') {
    console.log('[POST] ignorado — object no es whatsapp_business_account:', body.object);
    return new Response('ok');
  }

  const entries = (body.entry as Array<Record<string, unknown>>) ?? [];

  for (const entry of entries) {
    const changes = (entry.changes as Array<Record<string, unknown>>) ?? [];

    for (const change of changes) {
      // Coexistencia: lo que el dueño escribe desde la app de WhatsApp Business en su celular.
      if (change.field === 'smb_message_echoes') {
        await handleMessageEchoes(change.value as Record<string, unknown>);
        continue;
      }
      if (change.field === 'account_update') {
        console.log('[account_update]', JSON.stringify(change.value ?? {}).slice(0, 300));
        continue;
      }
      if (change.field !== 'messages') continue;

      const value    = change.value as Record<string, unknown>;
      const messages = (value.messages as Array<Record<string, unknown>>) ?? [];
      const metadata = value.metadata as Record<string, unknown>;
      const phoneNumberId = metadata?.phone_number_id as string | undefined;

      console.log('[change] field:', change.field, '| phoneNumberId:', phoneNumberId, '| messages:', messages.length);

      if (!phoneNumberId || !messages.length) continue;

      // El último mensaje de texto de cada remitente en este aviso es el que espera y responde.
      const lastBySender = new Map<string, Record<string, unknown>>();
      for (const m of messages) {
        if (m.type === 'text' && String(((m.text as Record<string, unknown>)?.body as string) ?? '').trim()) {
          lastBySender.set(m.from as string, m);
        }
      }
      for (const message of messages) {
        // Solo procesamos texto por ahora
        if (message.type !== 'text') continue;

        const from = message.from as string;
        const text = ((message.text as Record<string, unknown>)?.body as string) ?? '';
        if (!text.trim()) continue;

        try {
          // 1. Buscar vendor por meta_phone_number_id
          const { data: vendorData } = await supabase
            .from('vendors')
            .select('*')
            .eq('meta_phone_number_id', phoneNumberId)
            .eq('channel_type', 'meta')
            .single();

          console.log('[msg] from:', from, '| text:', text.slice(0, 50), '| phoneNumberId:', phoneNumberId);

          if (!vendorData) {
            console.error('[vendor] no encontrado para phone_number_id:', phoneNumberId);
            continue;
          }
          console.log('[vendor] encontrado:', vendorData.id, '| ai_provider:', vendorData.ai_provider, '| has_key:', !!(vendorData as Record<string,unknown>).ai_api_key);
          const vendor = vendorData as Vendor;

          // 2. Buscar o crear prospect
          const prospect = await getOrCreateProspect(from, vendor.id);
          await markAdOrigin(supabase, prospect, adReferralFromMeta(message));

          // 3. Cargar historial
          const { data: historyRows } = await supabase
            .from('messages')
            .select('role, content')
            .eq('prospect_id', prospect.id)
            .order('created_at', { ascending: true })
            .limit(20);

          const history = (historyRows ?? []) as Message[];

          // 4. Guardar mensaje del usuario ANTES de llamar a la IA
          // (así queda en DB aunque la IA falle)
          const { data: saved } = await supabase
            .from('messages')
            .insert({ prospect_id: prospect.id, role: 'user', content: text })
            .select('id')
            .single();

          // Varios mensajes en un mismo aviso de Meta: solo el último espera y responde.
          if (message !== lastBySender.get(from)) continue;

          // Si el vendor no tiene api_key configurada, solo guardamos el mensaje
          // y no intentamos llamar a la IA (evita error y pérdida del mensaje)
          if (!vendor.ai_api_key || !vendor.ia_enabled || !prospect.ia_enabled) {
            console.warn('[vendor] sin ai_api_key, canal con IA apagada o ia_enabled=false — mensaje guardado pero sin respuesta IA. vendor_id:', vendor.id);
            continue;
          }

          // Tope mensual de respuestas de IA del plan: sin cupo el bot no responde, el equipo sí puede.
          const usage = await getOrgUsage(supabase, vendor.organization_id);
          if (!aiAllowed(usage)) {
            console.warn('[limites] cupo mensual de IA agotado — mensaje guardado sin respuesta. org:', vendor.organization_id);
            continue;
          }

          // 5. Si el cliente sigue escribiendo, responde solo el handler del último mensaje y con todo junto.
          const earlier = saved ? await settleBurst(supabase, prospect.id, saved.id) : [];
          if (earlier === null) continue;
          const fullText = [...earlier, text].join('\n');
          const priorHistory = saved ? withoutPending(history) : history;

          // 5b. Llamar a la IA
          const aiReply = await callAI(vendor, priorHistory, fullText, prospect);

          // 6. Guardar respuesta del asistente
          await supabase.from('messages').insert([
            { prospect_id: prospect.id, role: 'assistant', content: aiReply.reply, by_ai: true },
          ]);

          // 7. Actualizar prospect
          const updates: Record<string, unknown> = {
            conversation_step: aiReply.conversation_step ?? prospect.conversation_step,
            evasive_count:     aiReply.evasive_count ?? prospect.evasive_count,
          };
          if (aiReply.score !== null && aiReply.score !== undefined) updates.score = aiReply.score;
          if (aiReply.label) {
            updates.label    = aiReply.label;
            updates.prioridad = derivePriority(aiReply.label);
          }
          const ext = aiReply.extracted ?? {};
          if (ext.tipo_operacion   != null) updates.tipo_operacion   = ext.tipo_operacion;
          if (ext.zona             != null) updates.zona             = ext.zona;
          if (ext.presupuesto      != null) updates.presupuesto      = ext.presupuesto;
          if (ext.tipo_inmueble    != null) updates.tipo_inmueble    = ext.tipo_inmueble;
          if (ext.horizonte_meses  != null) updates.horizonte_meses  = ext.horizonte_meses;
          if (ext.tiene_fondos     != null) updates.tiene_fondos     = ext.tiene_fondos;
          if (ext.es_decisor       != null) updates.es_decisor       = ext.es_decisor;
          if (ext.menciona_requisitos !== undefined) updates.menciona_requisitos = ext.menciona_requisitos;
          if (ext.nombre != null && ext.nombre !== '') updates.nombre = ext.nombre;

          await supabase.from('prospects').update(updates).eq('id', prospect.id);

          // 7. Enviar respuesta vía Meta Cloud API
          await sendMetaMessage(phoneNumberId, vendor.meta_access_token, from, aiReply.reply);

          // ¿Quedó una cita? No bloquea la respuesta ya enviada.
          try {
            if (agendaEnabled(usage)) await detectAppointment(supabase, vendor, prospect, priorHistory, fullText, aiReply.reply);
          } catch (e) {
            console.warn('[agenda] no se pudo detectar cita:', e);
          }

          // 8. Notificar al vendedor si el prospecto queda CALIFICADO
          if (aiReply.label === 'CALIFICADO' && vendor.phone_number) {
            const score      = aiReply.score ?? prospect.score;
            const zona       = ext.zona ?? prospect.zona ?? 'zona no especificada';
            const presupuesto = ext.presupuesto ?? prospect.presupuesto;
            const presStr    = presupuesto
              ? `$${presupuesto.toLocaleString('es-MX')} MXN`
              : 'presupuesto no capturado';
            const notif = `🏠 *Nuevo prospecto CALIFICADO*\n\n📱 Teléfono: ${from}\n⭐ Score: ${score}/100\n📍 Zona: ${zona}\n💰 Presupuesto: ${presStr}\n\nResponde a su WhatsApp para contactarlo.`;
            await sendMetaMessage(phoneNumberId, vendor.meta_access_token, vendor.phone_number, notif);
          }
        } catch (err) {
          console.error('Error procesando mensaje Meta:', err);
        }
      }
    }
  }

  // Meta requiere 200 rápido para no reintentar
  return new Response('ok', { status: 200 });
});
