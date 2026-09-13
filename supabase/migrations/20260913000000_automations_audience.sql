-- Paso 3 del flujo "Nueva automatización": aprobar la audiencia. Guarda los
-- criterios de segmentación (temperatura = prospects.label, etapa =
-- prospects.etapa texto libre, rango de score) junto con la definición de la
-- automatización. El motor que realmente inscribe/envía sigue sin construirse
-- — esto solo persiste a quién iría dirigida cuando exista.

alter table public.automations
  add column audience_temperaturas text[] not null default '{}',
  add column audience_etapas text[] not null default '{}',
  add column audience_score_min integer,
  add column audience_score_max integer;
