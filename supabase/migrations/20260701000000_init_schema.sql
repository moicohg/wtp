-- CRM WhatsApp (wtp) — esquema inicial
-- Reconstruido desde el proyecto Supabase "crmwtp" (znalzptpffnbnzuckiid)

create extension if not exists pgcrypto;

-- ── vendors ──────────────────────────────────────────────────────────────────
-- Cada vendor es un agente/asesor con su propio canal de WhatsApp (Evolution API
-- self-hosted o Meta WhatsApp Business Cloud API) y su propia configuración de IA.

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone_number text,
  evolution_instance_id text,
  ai_provider text not null default 'anthropic',
  ai_model text not null default 'claude-sonnet-4-6',
  ai_api_key text not null,
  system_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  channel_type text not null default 'evolution',
  meta_phone_number_id text,
  meta_waba_id text,
  meta_access_token text,
  meta_verified boolean not null default false,
  constraint vendors_ai_provider_check check (ai_provider in ('anthropic', 'openai', 'google')),
  constraint vendors_channel_type_check check (channel_type in ('evolution', 'meta')),
  constraint vendors_evolution_instance_id_key unique (evolution_instance_id),
  constraint chk_vendor_channel_credentials check (
    (channel_type = 'evolution' and evolution_instance_id is not null)
    or (channel_type = 'meta' and meta_phone_number_id is not null)
  )
);

create index idx_vendors_instance_id on public.vendors using btree (evolution_instance_id);
create unique index idx_vendors_meta_phone_number_id on public.vendors using btree (meta_phone_number_id)
  where (meta_phone_number_id is not null);

-- ── prospects ────────────────────────────────────────────────────────────────
-- Leads calificados automáticamente por IA a lo largo de un flujo de 3 pasos
-- (paso_0 → paso_1 → paso_2 → calificado/tibio/frio).

create table public.prospects (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.vendors (id) on delete cascade,
  phone text not null,
  nombre text not null default '',
  canal_preferido text,
  tipo_operacion text,
  zona text,
  presupuesto bigint,
  presupuesto_moneda text not null default 'MXN',
  tipo_inmueble text,
  horizonte_meses integer,
  tiene_fondos boolean,
  es_decisor boolean not null default true,
  menciona_requisitos boolean not null default false,
  cita_horario text,
  score integer not null default 0,
  label text not null default 'FRIO',
  prioridad text not null default 'BAJA',
  conversation_step text not null default 'paso_0',
  retries_current_step integer not null default 0,
  evasive_count integer not null default 0,
  notas text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospects_vendor_id_phone_key unique (vendor_id, phone),
  constraint prospects_score_check check (score >= 0 and score <= 100),
  constraint prospects_label_check check (label in ('CALIFICADO', 'TIBIO', 'FRIO', 'DESCARTADO')),
  constraint prospects_prioridad_check check (prioridad in ('ALTA', 'MEDIA', 'BAJA', 'NINGUNA')),
  constraint prospects_tipo_operacion_check check (tipo_operacion in ('compra', 'renta')),
  constraint prospects_tipo_inmueble_check check (tipo_inmueble in ('casa', 'departamento', 'terreno')),
  constraint prospects_canal_preferido_check check (canal_preferido in ('llamada', 'whatsapp'))
);

create index idx_prospects_vendor_id on public.prospects using btree (vendor_id);
create index idx_prospects_phone on public.prospects using btree (phone);

-- ── messages ─────────────────────────────────────────────────────────────────
-- Historial de conversación por prospecto (usado como contexto para la IA).

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now(),
  constraint messages_role_check check (role in ('user', 'assistant'))
);

create index idx_messages_prospect on public.messages using btree (prospect_id, created_at desc);

-- ── updated_at helper ────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Solo lectura anónima (para un futuro dashboard con anon key). Todas las
-- escrituras las hacen las Edge Functions con la service_role key, que
-- siempre pasa por encima de RLS.

alter table public.vendors enable row level security;
alter table public.prospects enable row level security;
alter table public.messages enable row level security;

create policy anon_select_vendors on public.vendors for select to anon using (true);
create policy anon_select_prospects on public.prospects for select to anon using (true);
create policy anon_select_messages on public.messages for select to anon using (true);
