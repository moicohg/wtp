import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Agrupa mensajes en ráfaga: un cliente suele escribir varios mensajes seguidos y cada uno dispara
// su propio webhook. Cada handler guarda su mensaje, espera unos segundos y responde solo si
// sigue siendo el último mensaje del chat; así contesta una sola vez, con todo el texto junto.

const BURST_WAIT_MS = Number(Deno.env.get('BURST_WAIT_MS') ?? 6000);
const MAX_PENDING = 10;

// Devuelve los mensajes anteriores del cliente que aún no tienen respuesta (para unir al actual),
// o null si llegó algo más después y le toca responder a otro handler.
export async function settleBurst(
  supabase: SupabaseClient,
  prospectId: string,
  myMessageId: string
): Promise<string[] | null> {
  if (BURST_WAIT_MS > 0) await new Promise(r => setTimeout(r, BURST_WAIT_MS));

  const { data: latest } = await supabase
    .from('messages')
    .select('id')
    .eq('prospect_id', prospectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && latest.id !== myMessageId) return null;

  const { data: lastReply } = await supabase
    .from('messages')
    .select('created_at')
    .eq('prospect_id', prospectId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let q = supabase
    .from('messages')
    .select('content')
    .eq('prospect_id', prospectId)
    .eq('role', 'user')
    .neq('id', myMessageId)
    .order('created_at', { ascending: false })
    .limit(MAX_PENDING);
  if (lastReply) q = q.gt('created_at', lastReply.created_at);
  const { data: pending } = await q;

  return (pending ?? []).map(m => String(m.content ?? '').trim()).filter(Boolean).reverse();
}

// El historial se cargó antes de la espera: los mensajes sin responder del final ya viajan
// dentro del texto actual y no deben repetirse como turnos anteriores.
export function withoutPending<T extends { role: string }>(history: T[]): T[] {
  const out = [...history];
  while (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}
