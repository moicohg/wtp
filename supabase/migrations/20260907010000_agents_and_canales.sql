-- Agentes/vendedores humanos asignables a cada canal (vendor = canal de
-- WhatsApp con su bot; agent = persona que atiende ese canal).

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

alter table public.vendors
  add column assigned_agent_id uuid references public.agents (id) on delete set null,
  add column keywords text[] not null default '{}';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Mismo modelo de confianza que el resto del dashboard: sin capa de auth
-- todavía, así que anon puede leer y administrar canales/agentes desde el
-- panel. prospects/messages siguen siendo de solo lectura para anon (los
-- escriben las Edge Functions con service_role).

alter table public.agents enable row level security;

create policy anon_select_agents on public.agents for select to anon using (true);
create policy anon_insert_agents on public.agents for insert to anon with check (true);
create policy anon_update_agents on public.agents for update to anon using (true) with check (true);
create policy anon_delete_agents on public.agents for delete to anon using (true);

create policy anon_insert_vendors on public.vendors for insert to anon with check (true);
create policy anon_update_vendors on public.vendors for update to anon using (true) with check (true);
create policy anon_delete_vendors on public.vendors for delete to anon using (true);
