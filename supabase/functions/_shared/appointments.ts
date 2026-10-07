import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface AiVendor {
  ai_provider: string;
  ai_model: string;
  ai_api_key: string;
}

// ── Detección de citas (alimenta "Por confirmar" en la Agenda) ───────────────
// Las instrucciones del bot son del vendedor y no incluyen citas, así que se
// hace una segunda llamada, con la IA del mismo canal, solo cuando el mensaje
// del prospecto suena a cita. La propone como "por_confirmar"; un humano decide.

const APPOINTMENT_HINT =
  /(visit|cita|agend|reuni|llam|ma[ñn]ana|hoy|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\b\d{1,2}\s?(am|pm|a\.m|p\.m|h\b)|\b\d{1,2}:\d{2}|hora)/i;

const LIMA_UTC_OFFSET = '-05:00'; // Perú no tiene horario de verano

async function askAI(vendor: AiVendor, system: string, user: string): Promise<string> {
  if (vendor.ai_provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': vendor.ai_api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: vendor.ai_model, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
    });
    return (await r.json()).content?.[0]?.text ?? '';
  }
  if (vendor.ai_provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendor.ai_api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: vendor.ai_model,
        max_tokens: 300,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    return (await r.json()).choices?.[0]?.message?.content ?? '';
  }
  const model = vendor.ai_model || 'gemini-2.0-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${vendor.ai_api_key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 300 },
      }),
    }
  );
  return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

export async function detectAppointment(
  supabase: SupabaseClient,
  vendor: AiVendor,
  prospect: { id: string },
  history: { role: string; content: string }[],
  messageText: string,
  reply: string
) {
  if (!APPOINTMENT_HINT.test(messageText)) return;

  const nowLima = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  const dow = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(Date.now() - 5 * 3600_000).getUTCDay()];
  const system =
    `Detectas citas (visita, llamada o reunión) acordadas o propuestas en una conversación de ventas por WhatsApp. ` +
    `Ahora es ${dow} ${nowLima} (hora de Lima, Perú). Resuelve fechas relativas ("mañana", "el domingo") a una fecha y hora concretas. ` +
    `Si el prospecto no dio hora, usa 10:00. Si no hay una cita real o no se puede fijar el día, responde tiene_cita=false. ` +
    `Responde SOLO JSON: {"tiene_cita": boolean, "fecha_hora": "YYYY-MM-DDTHH:mm" | null, "tipo": "Visita" | "Llamada" | "Reunión", "cita_textual": "<frase del prospecto que la sugiere>"}`;
  const transcript = [...history.slice(-8), { role: 'user', content: messageText }, { role: 'assistant', content: reply }]
    .map(m => `${m.role === 'user' ? 'Prospecto' : 'Asistente'}: ${m.content}`)
    .join('\n');

  const raw = await askAI(vendor, system, transcript);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return;
  const det = JSON.parse(match[0]) as { tiene_cita?: boolean; fecha_hora?: string | null; tipo?: string; cita_textual?: string };
  if (!det.tiene_cita || !det.fecha_hora) return;

  const when = new Date(`${det.fecha_hora}:00${LIMA_UTC_OFFSET}`);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 3600_000) return;

  // Una sola cita pendiente por prospecto: si la IA la reajusta, se actualiza en vez de duplicar.
  const quote = (det.cita_textual ?? messageText).slice(0, 300);
  const title = det.tipo || 'Visita';
  const { data: open } = await supabase
    .from('appointments')
    .select('id, status, scheduled_at')
    .eq('prospect_id', prospect.id)
    .in('status', ['por_confirmar', 'confirmada']);
  if (open?.some(a => a.status === 'confirmada' && Math.abs(new Date(a.scheduled_at).getTime() - when.getTime()) < 3600_000)) return;
  const pending = open?.find(a => a.status === 'por_confirmar');
  if (pending) {
    await supabase.from('appointments').update({ title, scheduled_at: when.toISOString(), source_quote: quote }).eq('id', pending.id);
  } else {
    await supabase.from('appointments').insert({
      prospect_id: prospect.id, title, scheduled_at: when.toISOString(), source: 'ia', source_quote: quote,
    });
  }
  await supabase.from('prospects').update({ cita_horario: quote }).eq('id', prospect.id);
}

