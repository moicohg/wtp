// Lee el system_prompt de un canal (vendor) y detecta con IA qué productos,
// propiedades o servicios menciona, para armar el Catálogo IA automáticamente.
// Lo llama el botón "✨ Analizar prompt" de la sección Catálogo IA. Usa
// OpenAI (mismo secret OPENAI_API_KEY que product-autocomplete).

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const OPENAI_MODEL = 'gpt-4o-mini';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!OPENAI_API_KEY) {
    return json({ error: 'OPENAI_API_KEY no está configurada en las Edge Functions' }, 500);
  }

  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Payload inválido' }, 400);
  }

  const prompt = (body.prompt ?? '').trim();
  if (!prompt) {
    return json({ error: 'Falta prompt (el system_prompt del canal está vacío)' }, 400);
  }

  const systemPrompt =
    'Lees el system prompt de un bot de ventas por WhatsApp y detectas qué productos, propiedades ' +
    'o servicios concretos menciona que vende (ej. unidades inmobiliarias, cursos, planes). ' +
    'Responde únicamente JSON con la forma {"items": [{"name": string}]}, con nombres cortos y ' +
    'concretos tal como aparecen en el texto (ej. "EM-RV-01 — Depto en Surco", "Diplomado CIRO 2026"). ' +
    'No inventes productos que no estén en el texto. Si no detectas ninguno, responde {"items": []}.';

  let aiResp: Response;
  try {
    aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt.slice(0, 12000) },
        ],
      }),
    });
  } catch (err) {
    return json({ error: `No se pudo contactar a OpenAI: ${(err as Error).message}` }, 502);
  }

  if (!aiResp.ok) {
    const errText = await aiResp.text();
    return json({ error: `OpenAI respondió ${aiResp.status}: ${errText}` }, 502);
  }

  const aiJson = await aiResp.json();
  const content = aiJson?.choices?.[0]?.message?.content;
  if (!content) {
    return json({ error: 'OpenAI no devolvió contenido' }, 502);
  }

  let parsed: { items?: { name?: string }[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    return json({ error: 'La respuesta de OpenAI no fue JSON válido' }, 502);
  }

  const items = (parsed.items ?? [])
    .map((it) => String(it?.name ?? '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((name) => ({ name: name.slice(0, 200) }));

  return json({ items });
});
