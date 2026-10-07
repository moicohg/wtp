-- Aviso cuando un canal QR pierde la sesión de WhatsApp.
--
-- Cuando el teléfono desvincula el dispositivo, Evolution manda connection.update
-- con state = close y el bot deja de responder sin que nadie se entere (pasó con
-- "moises"). Ahora whatsapp-handler marca la caída y avisa una sola vez por
-- WhatsApp, y el panel muestra un banner.
--
-- - evolution_disconnected_at: desde cuándo está caído (null = nunca se conectó o
--   está conectado). El banner solo cuenta canales que ya estuvieron conectados,
--   para no alarmar mientras se escanea el QR de un canal recién creado.
-- - evolution_alerted_at: ya se avisó de esta caída (evita repetir el aviso si
--   Evolution reenvía el evento). Se limpia al reconectar. Es interna: sin grant.

alter table public.vendors
  add column if not exists evolution_disconnected_at timestamptz,
  add column if not exists evolution_alerted_at timestamptz;

-- Canales caídos antes de esta migración (moises): se toma su última actualización como inicio de la caída.
update public.vendors
  set evolution_disconnected_at = updated_at
  where channel_type = 'evolution' and not evolution_connected and evolution_disconnected_at is null;

grant select (evolution_disconnected_at) on public.vendors to authenticated;
