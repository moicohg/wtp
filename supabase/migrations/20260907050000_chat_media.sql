-- Adjuntos salientes del chat (fotos/videos/archivos/notas de voz que el
-- asesor envía desde el panel). Bucket público + columnas en messages para
-- guardar la referencia. Igual que el resto del dashboard, sin capa de auth
-- propia todavía: anon puede subir y leer.

insert into storage.buckets (id, name, public)
values ('chat-media', 'chat-media', true)
on conflict (id) do nothing;

create policy anon_upload_chat_media on storage.objects
  for insert to anon
  with check (bucket_id = 'chat-media');

create policy anon_read_chat_media on storage.objects
  for select to anon
  using (bucket_id = 'chat-media');

alter table public.messages
  add column media_url text,
  add column media_type text check (media_type in ('image', 'video', 'audio', 'document'));
