-- Permite apagar la IA para una conversación puntual desde el panel de chat
-- (antes solo se podía "apagar" dejando ai_api_key vacío, lo cual afecta a
-- TODO el canal). Las Edge Functions revisan esta columna antes de llamar
-- a la IA; si es false, el mensaje del usuario se guarda igual pero no se
-- genera ni envía respuesta automática.

alter table public.prospects
  add column ia_enabled boolean not null default true;
