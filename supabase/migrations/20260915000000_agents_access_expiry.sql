-- Fecha opcional de vencimiento de acceso para un vendedor (agents).
-- No implica todavía un login real: no hay columna de contraseña porque
-- este panel no tiene capa de auth (ver comentario en agents_and_canales.sql)
-- y anon puede leer esta tabla — guardar una contraseña ahí sería exponerla.

alter table public.agents
  add column access_expires_at date;
