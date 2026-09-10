-- Catálogo IA: archivos (productos/propiedades/servicios) que la IA puede
-- mencionar/enviar cuando un cliente pregunta por algo. Cada archivo se
-- asigna a uno o más canales (vendors) vía un array de uuids — igual de
-- simple que custom_fields/products, sin auth todavía (ver 20260907010000).

create table public.catalog_files (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vendor_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_catalog_files_created_at on public.catalog_files using btree (created_at desc);
create index idx_catalog_files_vendor_ids on public.catalog_files using gin (vendor_ids);

create trigger set_catalog_files_updated_at
  before update on public.catalog_files
  for each row execute function public.set_updated_at();

alter table public.catalog_files enable row level security;

create policy anon_select_catalog_files on public.catalog_files for select to anon using (true);
create policy anon_insert_catalog_files on public.catalog_files for insert to anon with check (true);
create policy anon_update_catalog_files on public.catalog_files for update to anon using (true) with check (true);
create policy anon_delete_catalog_files on public.catalog_files for delete to anon using (true);
