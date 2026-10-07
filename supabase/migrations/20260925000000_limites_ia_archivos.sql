-- Topes de uso por empresa: mensajes de IA al mes y almacenamiento de archivos.
--
-- Canales y vendedores ya tienen tope. Lo que más hace crecer la base y el gasto
-- son (1) las respuestas de IA, que se pagan con la clave del canal pero llenan
-- la tabla messages, y (2) los adjuntos que suben el equipo y los clientes al
-- bucket chat-media, que no tenían límite. Sin topes un plan barato puede costar
-- más de lo que paga.
--
-- - max_ai_messages: respuestas de IA por mes calendario (hora de Lima). Al
--   llegar, el bot deja de responder; el equipo sigue chateando a mano.
-- - max_storage_mb: espacio en chat-media. Al llegar no se aceptan más archivos.
-- - Los adjuntos de más de 90 días se borran solos (Edge Function purge-media,
--   programada con pg_cron). El mensaje queda; solo se pierde el archivo.

alter table public.organizations
  add column if not exists max_ai_messages integer not null default 1000,
  add column if not exists max_storage_mb integer not null default 500,
  add constraint organizations_max_ai_messages_check check (max_ai_messages >= 0),
  add constraint organizations_max_storage_mb_check check (max_storage_mb >= 0);

-- La empresa dueña de la plataforma no debe quedar limitada.
update public.organizations
  set max_ai_messages = 1000000, max_storage_mb = 100000
  where id = '00000000-0000-4000-8000-000000000007';

-- Distingue la respuesta del bot de la que escribe una persona (ambas son role = 'assistant').
alter table public.messages add column if not exists by_ai boolean not null default false;
create index if not exists idx_messages_ai_month on public.messages (organization_id, created_at) where by_ai;

-- Consumo actual y topes de una empresa. Solo la usan las Edge Functions (service_role).
create or replace function public.org_usage(p_org uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'ai_used', (
      select count(*) from public.messages m
      where m.organization_id = p_org and m.by_ai
        and m.created_at >= (date_trunc('month', now() at time zone 'America/Lima') at time zone 'America/Lima')
    ),
    'ai_max', o.max_ai_messages,
    'storage_bytes', coalesce((
      select sum((so.metadata ->> 'size')::bigint) from storage.objects so
      where so.bucket_id = 'chat-media' and (storage.foldername(so.name))[1] = p_org::text
    ), 0),
    'storage_max_bytes', o.max_storage_mb::bigint * 1024 * 1024
  )
  from public.organizations o where o.id = p_org;
$$;
revoke all on function public.org_usage(uuid) from public, anon, authenticated;
grant execute on function public.org_usage(uuid) to service_role;

-- ¿Le queda espacio a la empresa? Lo usa la política de subida de archivos del panel.
create or replace function public.org_storage_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((public.org_usage(p_org) ->> 'storage_bytes')::bigint
                  < (public.org_usage(p_org) ->> 'storage_max_bytes')::bigint, true);
$$;
revoke all on function public.org_storage_ok(uuid) from public, anon;
grant execute on function public.org_storage_ok(uuid) to authenticated, service_role;

drop policy if exists authenticated_upload_chat_media on storage.objects;
create policy authenticated_upload_chat_media on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = (select public.current_org_id())::text
    and (select public.org_storage_ok((select public.current_org_id())))
  );

-- Borrado diario de adjuntos viejos: pg_cron llama a la Edge Function purge-media.
-- El secreto compartido vive en Vault (cron_secret), no en este archivo.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('purge-chat-media') where exists (select 1 from cron.job where jobname = 'purge-chat-media');
select cron.schedule(
  'purge-chat-media',
  '0 8 * * *',
  $cron$
  select net.http_post(
    url := 'https://znalzptpffnbnzuckiid.supabase.co/functions/v1/purge-media',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
