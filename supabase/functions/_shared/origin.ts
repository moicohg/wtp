import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Detecta si el primer mensaje llegó desde un anuncio de Facebook/Instagram (click a WhatsApp) y
// marca el origen del lead. Solo rellena prospects.origen si está vacío: nunca pisa lo que una
// persona ya eligió. origen_detalle guarda el titular del anuncio (o su id) para saber cuál fue.

export interface AdReferral {
  headline: string | null;
  sourceId: string | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Meta Cloud API: message.referral = { source_type: 'ad', source_id, headline, ... }
export function adReferralFromMeta(message: Record<string, unknown>): AdReferral | null {
  const ref = message.referral as Record<string, unknown> | undefined;
  if (!ref || typeof ref !== 'object') return null;
  return { headline: str(ref.headline), sourceId: str(ref.source_id) };
}

// Evolution (Baileys): contextInfo.externalAdReply = { title, sourceType: 'ad', sourceId, ... },
// dentro del tipo de mensaje (extendedTextMessage, imageMessage...) o en data.contextInfo.
export function adReferralFromEvolution(data: Record<string, unknown>): AdReferral | null {
  const candidates: unknown[] = [data.contextInfo];
  const msg = data.message as Record<string, unknown> | undefined;
  if (msg) {
    for (const v of Object.values(msg)) {
      if (v && typeof v === 'object') candidates.push((v as Record<string, unknown>).contextInfo);
    }
  }
  for (const c of candidates) {
    const ad = (c as Record<string, unknown> | undefined)?.externalAdReply as Record<string, unknown> | undefined;
    if (ad && typeof ad === 'object') return { headline: str(ad.title), sourceId: str(ad.sourceId) };
  }
  return null;
}

export async function markAdOrigin(
  supabase: SupabaseClient,
  prospect: { id: string; origen?: string | null },
  ref: AdReferral | null
): Promise<void> {
  if (!ref || prospect.origen) return;
  const detalle = [ref.headline, ref.sourceId ? `anuncio ${ref.sourceId}` : null].filter(Boolean).join(' · ') || null;
  const { error } = await supabase
    .from('prospects')
    .update({ origen: 'facebook_ads', origen_detalle: detalle })
    .eq('id', prospect.id)
    .is('origen', null);
  if (error) console.warn('[origen] no se pudo marcar el origen del lead:', error.message);
}
