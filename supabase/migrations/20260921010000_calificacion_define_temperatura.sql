-- La rúbrica de calificación (Necesidad/Inversión/Urgencia/Autoridad) ahora
-- gobierna la temperatura del lead. Antes era una evaluación manual aislada
-- (20260907070000_calificacion_rubrica.sql): elegir opciones no movía el
-- score/label, porque esas columnas no tienen grant de UPDATE para el panel
-- (solo las escribe la IA vía service_role).
--
-- Se resuelve con un trigger en vez de abrir el grant: el trigger modifica NEW
-- desde la base, así que el cliente sigue sin poder escribir score/label a mano
-- y la regla vive en un solo lugar sin importar quién guarde la rúbrica.
--
-- Cada opción aporta sus puntos (máx. 30+25+25+20 = 100) y las que aún no se
-- eligieron cuentan 0, igual que el "0/25" que muestra el panel. Umbrales y
-- prioridad idénticos a los de la IA (whatsapp-handler / meta-webhook):
-- CALIFICADO ≥70 (ALTA), TIBIO 40-69 (MEDIA), FRIO <40 (BAJA).
--
-- Solo dispara cuando alguna calif_* cambia de verdad: el panel manda las
-- cuatro columnas en cada guardado, y guardar solo notas/zona no debe pisar el
-- score más reciente de la IA. Un lead DESCARTADO conserva su label y
-- prioridad (es una decisión, no una temperatura) pero sí actualiza el score.
-- No se hace backfill: los leads ya calificados conservan su score actual
-- hasta que se vuelva a guardar su rúbrica.

create or replace function public.apply_calificacion_score()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_score integer;
begin
  if new.calif_necesidad is null and new.calif_inversion is null
     and new.calif_urgencia is null and new.calif_autoridad is null then
    return new;
  end if;

  v_score := coalesce(new.calif_necesidad, 0) + coalesce(new.calif_inversion, 0)
           + coalesce(new.calif_urgencia, 0) + coalesce(new.calif_autoridad, 0);
  new.score := v_score;

  if new.label <> 'DESCARTADO' then
    if v_score >= 70 then
      new.label := 'CALIFICADO';
      new.prioridad := 'ALTA';
    elsif v_score >= 40 then
      new.label := 'TIBIO';
      new.prioridad := 'MEDIA';
    else
      new.label := 'FRIO';
      new.prioridad := 'BAJA';
    end if;
  end if;

  return new;
end;
$$;

create trigger prospects_apply_calificacion
  before update of calif_necesidad, calif_inversion, calif_urgencia, calif_autoridad
  on public.prospects
  for each row
  when (
    old.calif_necesidad  is distinct from new.calif_necesidad  or
    old.calif_inversion  is distinct from new.calif_inversion  or
    old.calif_urgencia   is distinct from new.calif_urgencia   or
    old.calif_autoridad  is distinct from new.calif_autoridad
  )
  execute function public.apply_calificacion_score();
