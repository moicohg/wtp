-- Interruptor de IA por canal: apaga el bot de todo un canal sin tocar su clave ni su prompt.
-- Es independiente del interruptor de cada chat (prospects.ia_enabled): el bot responde solo si
-- ambos están activos. Con el canal apagado los mensajes se guardan y los atiende el equipo.
-- Por defecto queda activo, así que los canales existentes no cambian de comportamiento.

alter table public.vendors add column if not exists ia_enabled boolean not null default true;

-- El panel lo lee (select por columnas en vendors). Escribirlo ya lo cubre la política
-- vendors_update (config.manage_channels o config.ai_settings).
grant select (ia_enabled) on public.vendors to authenticated;
