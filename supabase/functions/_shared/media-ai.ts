// Entender adjuntos con la IA del propio canal: pasa una nota de voz a texto y describe
// una imagen, para que el bot pueda responder a lo que el cliente mandó.
//
// - Audio: OpenAI (Whisper) y Google (Gemini). Anthropic no transcribe audio.
// - Imagen: OpenAI, Anthropic y Google (con el modelo configurado en el canal).
// Cualquier fallo devuelve null: el mensaje queda guardado y lo atiende una persona.

export interface MediaAiVendor {
  ai_provider: string;
  ai_model: string;
  ai_api_key: string;
}

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const IMAGE_PROMPT =
  'Describe en español, en una a tres frases y de forma objetiva, qué muestra esta imagen que envió un cliente en una conversación de ventas. ' +
  'Si hay texto visible (precios, medidas, comprobantes, documentos, direcciones) transcríbelo. No inventes lo que no se ve.';
const AUDIO_PROMPT = 'Transcribe literalmente esta nota de voz en español. Responde solo con la transcripción, sin comentarios.';

export const canTranscribeAudio = (v: MediaAiVendor) => v.ai_provider === 'openai' || v.ai_provider === 'google';

// base64 se pasa aparte porque el handler ya lo tiene (evita recodificar el archivo).
export async function understandMedia(
  vendor: MediaAiVendor,
  type: 'audio' | 'image',
  file: { bytes: Uint8Array; base64: string; mime: string }
): Promise<string | null> {
  try {
    if (type === 'audio') {
      if (!canTranscribeAudio(vendor)) {
        console.warn('[media-ai] el proveedor', vendor.ai_provider, 'no transcribe audio');
        return null;
      }
      if (file.bytes.length > MAX_AUDIO_BYTES) return null;
      return clean(vendor.ai_provider === 'openai' ? await whisper(vendor, file) : await gemini(vendor, AUDIO_PROMPT, file));
    }
    if (file.bytes.length > MAX_IMAGE_BYTES || !file.mime.startsWith('image/')) return null;
    if (vendor.ai_provider === 'openai') return clean(await openaiVision(vendor, file));
    if (vendor.ai_provider === 'anthropic') return clean(await anthropicVision(vendor, file));
    return clean(await gemini(vendor, IMAGE_PROMPT, file));
  } catch (e) {
    console.error('[media-ai] no se pudo entender el adjunto:', e);
    return null;
  }
}

const clean = (t: string | null | undefined) => {
  const s = (t ?? '').trim();
  return s ? s.slice(0, 1500) : null;
};

async function whisper(v: MediaAiVendor, f: { bytes: Uint8Array; mime: string }): Promise<string | null> {
  const ext = f.mime.includes('mpeg') ? 'mp3' : f.mime.includes('mp4') ? 'm4a' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([f.bytes], { type: f.mime || 'audio/ogg' }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${v.ai_api_key}` },
    body: form,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Whisper ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
  return data.text;
}

async function openaiVision(v: MediaAiVendor, f: { base64: string; mime: string }): Promise<string | null> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${v.ai_api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: v.ai_model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: IMAGE_PROMPT },
          { type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.base64}` } },
        ],
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`OpenAI visión ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
  return data.choices?.[0]?.message?.content;
}

async function anthropicVision(v: MediaAiVendor, f: { base64: string; mime: string }): Promise<string | null> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': v.ai_api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: v.ai_model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.base64 } },
          { type: 'text', text: IMAGE_PROMPT },
        ],
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Anthropic visión ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
  return data.content?.[0]?.text;
}

// Gemini entiende audio e imagen con la misma llamada.
async function gemini(v: MediaAiVendor, prompt: string, f: { base64: string; mime: string }): Promise<string | null> {
  const model = v.ai_model || 'gemini-2.0-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(v.ai_api_key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: f.mime || 'audio/ogg', data: f.base64 } }] }],
        generationConfig: { maxOutputTokens: 400 },
      }),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}
