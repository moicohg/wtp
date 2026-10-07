import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Borra los adjuntos del chat con más de RETENTION_DAYS días. Lo llama pg_cron
// una vez al día con el secreto compartido (cron_secret en Vault). El mensaje se
// conserva y solo pierde el archivo: media_url queda en null y media_type se
// mantiene para que el panel muestre "Adjunto eliminado".

const RETENTION_DAYS = 90;
const BATCH = 200;
const MAX_BATCHES = 10;
const PUBLIC_PREFIX = '/storage/v1/object/public/chat-media/';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  let deleted = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: rows, error } = await supabase
      .from('messages')
      .select('id, media_url')
      .not('media_url', 'is', null)
      .lt('created_at', cutoff)
      .limit(BATCH);
    if (error) {
      console.error('[purge-media] error leyendo mensajes:', error.message);
      break;
    }
    if (!rows?.length) break;

    const paths = rows
      .map(r => {
        const at = String(r.media_url).indexOf(PUBLIC_PREFIX);
        return at === -1 ? null : decodeURIComponent(String(r.media_url).slice(at + PUBLIC_PREFIX.length));
      })
      .filter((p): p is string => Boolean(p));

    if (paths.length) {
      const { error: rmError } = await supabase.storage.from('chat-media').remove(paths);
      if (rmError) {
        console.error('[purge-media] no se pudieron borrar archivos:', rmError.message);
        break; // no se tocan los mensajes si el archivo sigue ahí
      }
    }
    const { error: upError } = await supabase.from('messages').update({ media_url: null }).in('id', rows.map(r => r.id));
    if (upError) {
      console.error('[purge-media] error actualizando mensajes:', upError.message);
      break;
    }
    deleted += rows.length;
    if (rows.length < BATCH) break;
  }

  return new Response(JSON.stringify({ deleted, cutoff }), { headers: { 'content-type': 'application/json' } });
});
