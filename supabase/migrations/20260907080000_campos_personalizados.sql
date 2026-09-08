-- Campos personalizados (custom fields): la DEFINICIÓN de cada campo (nombre,
-- tipo, opciones, si es obligatorio) es global — se crea una sola vez desde
-- el panel "Info del cliente" y aparece en todos los chats de todos los
-- canales. El VALOR de cada campo sí es propio de cada prospecto, guardado
-- en prospects.custom_field_values.

create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  field_type text not null,
  help_text text,
  required boolean not null default false,
  options jsonb, -- array de strings; solo aplica a 'select'/'multiselect'
  created_at timestamptz not null default now(),
  constraint custom_fields_field_type_check check (
    field_type in ('text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'textarea', 'email', 'phone', 'url')
  )
);

alter table public.prospects
  add column custom_field_values jsonb not null default '{}';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Mismo modelo que agents/vendors: sin capa de auth todavía, así que anon
-- puede leer y crear campos personalizados desde el panel. No se exponen
-- policies de update/delete porque el UI actual solo permite crear campos.

alter table public.custom_fields enable row level security;

create policy anon_select_custom_fields on public.custom_fields for select to anon using (true);
create policy anon_insert_custom_fields on public.custom_fields for insert to anon with check (true);

-- prospects tiene grants de columna explícitos (ver 20260907020000 y
-- 20260907060000) — sumamos custom_field_values a lo que anon puede guardar
-- desde el formulario "Info del cliente".
grant update (custom_field_values) on public.prospects to anon;
