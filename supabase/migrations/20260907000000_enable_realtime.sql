-- Habilita Realtime en prospects y messages para que el dashboard reciba
-- actualizaciones en vivo (nuevos mensajes, cambios de score/label).

alter publication supabase_realtime add table public.prospects, public.messages;
