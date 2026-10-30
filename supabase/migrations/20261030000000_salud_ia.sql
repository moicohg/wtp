-- Salud del bot de IA por canal.
--
-- Si la API de la IA falla (sin créditos, clave inválida, límite de uso, modelo inexistente) el bot
-- deja de responder y nadie se entera hasta revisar WhatsApp a mano. Ahora whatsapp-handler y
-- meta-webhook registran el último resultado de la IA por canal, avisan una vez por WhatsApp al
-- equipo y el panel muestra un banner / estado en Canales.
--
-- - ai_last_ok_at: última respuesta correcta de la IA (se refresca como máximo cada 10 min).
-- - ai_error_kind: credits | key | rate | model | other. null = sin error vigente.
-- - ai_error_detail: mensaje corto del proveedor (sin claves).
-- - ai_error_at: cuándo empezó el error vigente. Se limpia con la siguiente respuesta correcta.
-- - ai_alerted_at: ya se avisó de este error (interna, sin grant). Se limpia al recuperarse.

alter table public.vendors
  add column if not exists ai_last_ok_at timestamptz,
  add column if not exists ai_error_kind text check (ai_error_kind in ('credits', 'key', 'rate', 'model', 'other')),
  add column if not exists ai_error_detail text,
  add column if not exists ai_error_at timestamptz,
  add column if not exists ai_alerted_at timestamptz;

grant select (ai_last_ok_at, ai_error_kind, ai_error_detail, ai_error_at) on public.vendors to authenticated;
