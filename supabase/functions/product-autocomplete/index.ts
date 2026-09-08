// Genera un catálogo de productos con IA a partir de una breve descripción del
// negocio. Lo llama el botón "✨ Autocompletar" de la sección Productos del
// dashboard. Usa OpenAI (independiente de las API keys por vendor, que son
// para los bots de WhatsApp) — requiere el secret OPENAI_API_KEY.

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

interface GeneratedProduct {
  name: string;
  price: number;
  currency: 'PEN' | 'USD';
  quantity: number | null;
  description: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!OPENAI_API_KEY) {
    return json({ error: 'OPENAI_API_KEY no está configurada en las Edge Functions' }, 500);
  }

  let body: { description?: string; count?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Payload inválido' }, 400);
  }

  const description = (body.description ?? '').trim();
  if (!description) {
    return json({ error: 'Falta description (cuéntanos qué vende el negocio)' }, 400);
  }
  const count = Math.min(Math.max(Number(body.count) || 6, 1), 12);

  const systemPrompt =
    'Eres un asistente que arma catálogos de productos para pequeños negocios en Perú. ' +
    'Dada una descripción del negocio, generas productos realistas con precios de mercado creíbles. ' +
    'Responde únicamente JSON con la forma {"products": [{"name": string, "price": number, ' +
    '"currency": "PEN" | "USD", "quantity": number | null, "description": string}]}. ' +
    'Usa PEN salvo que el negocio sea claramente internacional. "quantity" va en null si el negocio ' +
    'no controla stock por unidades (ej. servicios). "description" es una frase corta en español.';

  const userPrompt = `Negocio: ${description}\nGenera exactamente ${count} productos para su catálogo.`;

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
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
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

  let parsed: { products?: GeneratedProduct[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    return json({ error: 'La respuesta de OpenAI no fue JSON válido' }, 502);
  }

  const products = (parsed.products ?? [])
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .map((p) => ({
      name: String(p.name).trim().slice(0, 200),
      price: Number.isFinite(p.price) ? Math.max(0, Number(p.price)) : 0,
      currency: p.currency === 'USD' ? 'USD' : 'PEN',
      quantity: p.quantity === null || p.quantity === undefined ? null : Math.max(0, Math.round(Number(p.quantity))),
      description: typeof p.description === 'string' ? p.description.trim().slice(0, 500) : '',
    }));

  if (!products.length) {
    return json({ error: 'La IA no generó productos válidos, intenta con otra descripción' }, 502);
  }

  return json({ products });
});
