-- Calificación del lead por rúbrica (Necesidad/Inversión/Urgencia/Autoridad)
-- desde el panel "Info del cliente". Cada columna guarda los puntos de la
-- opción elegida por el asesor; es una evaluación manual e independiente del
-- score/label que calcula la IA (esos siguen siendo de solo la IA vía
-- service_role, ver 20260907020000_bandeja_global.sql).

alter table public.prospects
  add column calif_necesidad integer,
  add column calif_inversion integer,
  add column calif_urgencia integer,
  add column calif_autoridad integer;

alter table public.prospects
  add constraint prospects_calif_necesidad_check check (calif_necesidad is null or calif_necesidad in (25, 20, 12, 6, 2)),
  add constraint prospects_calif_inversion_check check (calif_inversion is null or calif_inversion in (30, 24, 14, 7, 2)),
  add constraint prospects_calif_urgencia_check check (calif_urgencia is null or calif_urgencia in (25, 20, 12, 6, 2)),
  add constraint prospects_calif_autoridad_check check (calif_autoridad is null or calif_autoridad in (20, 14, 6, 2));

grant update (calif_necesidad, calif_inversion, calif_urgencia, calif_autoridad) on public.prospects to anon;
