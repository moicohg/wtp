-- Duración de la cita: el modal "Nueva cita" (Agenda y botón de calendario del chat) pide cuánto
-- dura. Las citas existentes y las que propone la IA quedan en 1 hora, que era lo que se asumía.

alter table public.appointments
  add column if not exists duration_minutes integer not null default 60,
  add constraint appointments_duration_check check (duration_minutes between 5 and 1440);
