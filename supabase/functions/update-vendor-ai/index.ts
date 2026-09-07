import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o',
  google:    'gemini-2.0-flash',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')   return new Response('Method Not Allowed', { status: 405 });

  let body: { vendor_id: string; ai_provider: string; ai_api_key: string; ai_model?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Payload inválido' }, 400);
  }

  const { vendor_id, ai_provider, ai_api_key, ai_model, system_prompt } = body as {
    vendor_id: string; ai_provider?: string; ai_api_key?: string;
    ai_model?: string; system_prompt?: string;
  };

  if (!vendor_id) {
    return json({ error: 'Falta vendor_id' }, 400);
  }

  const updates: Record<string, unknown> = {};

  if (ai_provider !== undefined && ai_api_key !== undefined) {
    const validProviders = ['anthropic', 'openai', 'google'];
    if (!validProviders.includes(ai_provider)) {
      return json({ error: 'ai_provider inválido. Usa: anthropic, openai o google' }, 400);
    }
    updates.ai_provider = ai_provider;
    updates.ai_api_key  = ai_api_key;
    updates.ai_model    = ai_model || DEFAULT_MODEL[ai_provider];
  }

  if (system_prompt !== undefined) {
    updates.system_prompt = system_prompt || null;
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'Nada que actualizar' }, 400);
  }

  const { error } = await supabase
    .from('vendors')
    .update(updates)
    .eq('id', vendor_id)
    .eq('channel_type', 'meta');

  if (error) {
    console.error('Error actualizando vendor AI config:', error);
    return json({ error: error.message }, 500);
  }

  return json({ success: true });
});
