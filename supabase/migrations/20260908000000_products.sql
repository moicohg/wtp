-- Catálogo de productos: catálogo global (no por vendor) que se gestiona
-- desde la sección "Productos" del dashboard, con el mismo modelo de RLS
-- sin auth que vendors/agents/custom_fields (ver 20260907010000 y
-- 20260907080000): anon puede hacer CRUD completo desde el panel.

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(12, 2) not null default 0,
  currency text not null default 'PEN',
  quantity integer,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_currency_check check (currency in ('PEN', 'USD')),
  constraint products_price_check check (price >= 0),
  constraint products_quantity_check check (quantity is null or quantity >= 0)
);

create index idx_products_created_at on public.products using btree (created_at desc);

create trigger set_products_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

create policy anon_select_products on public.products for select to anon using (true);
create policy anon_insert_products on public.products for insert to anon with check (true);
create policy anon_update_products on public.products for update to anon using (true) with check (true);
create policy anon_delete_products on public.products for delete to anon using (true);
