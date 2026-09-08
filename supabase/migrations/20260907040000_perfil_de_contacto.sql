-- Clasificación libre del contacto (Nuevo/Inversionista/Desarrollador/Agente/
-- familia/…) que se muestra como chip en el header del chat, junto a Etapa.
-- Igual que "etapa", queda como texto libre en vez de un enum: el panel deja
-- agregar perfiles nuevos sobre la marcha ("+ Agregar perfil").

alter table public.prospects
  add column perfil text not null default 'nuevo';
