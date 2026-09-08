-- El formulario "Info del cliente" del panel de chat también edita zona,
-- presupuesto y notas, pero el grant de columnas agregado para la Bandeja
-- Global (20260907020000_bandeja_global.sql) solo cubrió etapa/etiquetas/
-- estado_conversacion/handled_by_agent_id. Sin este grant, el UPDATE de
-- esos 3 campos falla por permisos de columna (aunque la política RLS lo
-- permita), así que "Guardar cambios" nunca los guardaba realmente.

grant update (zona, presupuesto, notas) on public.prospects to anon;
