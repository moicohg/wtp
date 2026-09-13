---
name: esquema
description: Checklist obligatoria para cambios de esquema o backend en wtp bajo el modelo multi-empresa. Cargar antes de escribir una migración, agregar una tabla o columna, crear un permiso nuevo o una Edge Function. Cubre organization_id, RLS to authenticated, grants por columna y los archivos espejo entre app.js y las funciones.
---

# Cambios de esquema en wtp (multi-empresa)

Desde el lockdown del 2026-09-13, `anon` no tiene privilegios en `public` y toda la data se aísla por `organization_id` con políticas `to authenticated`. Cualquier cambio que ignore esto abre un hueco entre empresas.

## Migraciones

- Archivo en `supabase/migrations/` con nombre `YYYYMMDDHHMMSS_nombre_corto.sql`. Usar una fecha posterior a la última migración existente (revisar con `ls supabase/migrations | tail -3`).
- Empezar con un comentario que explique **por qué** existe el cambio, no solo qué hace. Todas las migraciones del repo siguen ese estilo.
- Docker no está disponible: `supabase db diff` no funciona. Escribir el SQL a mano.
- Aplicar solo cuando el usuario lo pida, con `/deploy db`.
- Para leer el estado remoto: `supabase db query --linked "<sql>"`.

## Tabla nueva

Decidir primero si es **raíz** o **hija**.

**Tabla raíz** (se crea desde el panel, sin padre obvio; ejemplos: vendors, agents, roles, products):

```sql
create table public.ejemplo (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null default public.current_org_id()
    references public.organizations (id) on delete restrict,
  ...
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ejemplo_organization on public.ejemplo (organization_id);
create trigger set_ejemplo_updated_at before update on public.ejemplo
  for each row execute function public.set_updated_at();
```

**Tabla hija** (siempre cuelga de un padre con empresa; ejemplos: prospects ← vendors, messages ← prospects):

- `organization_id uuid not null references public.organizations (id) on delete restrict`, **sin default**.
- Trigger `before insert` que copia la empresa del padre y falla si el padre no existe. Copiar el patrón de `set_org_from_vendor()` en la migración `20260920000000_multi_tenant.sql`.

**RLS y grants**, para ambos tipos:

```sql
alter table public.ejemplo enable row level security;
revoke truncate, references, trigger on public.ejemplo from authenticated;

create policy ejemplo_select on public.ejemplo for select to authenticated
  using (organization_id = (select public.current_org_id()));
create policy ejemplo_insert on public.ejemplo for insert to authenticated
  with check (organization_id = (select public.current_org_id()) and (select public.has_permission('x.y')));
create policy ejemplo_update on public.ejemplo for update to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('x.y')));
create policy ejemplo_delete on public.ejemplo for delete to authenticated
  using (organization_id = (select public.current_org_id()) and (select public.has_permission('x.y')));
```

- Siempre `(select fn())` dentro de la política: se evalúa una vez por sentencia, no por fila.
- **Nunca** políticas `to anon`. Los defaults ya revocan todo a `anon` en tablas nuevas.
- Si una fila referencia a un agente, rol o canal, validar que sea de la misma empresa con `agent_in_my_org()`, `role_in_my_org()` o `vendors_in_my_org()`.
- Si la tabla debe existir por empresa desde el inicio (como `availability_settings`), agregar el insert en `seed_organization()` y un backfill para las empresas existentes.
- Si el panel necesita cambios en vivo, agregarla a la publicación: `alter publication supabase_realtime add table public.ejemplo;`

## Columna nueva en una tabla existente

Dos tablas tienen **grants por columna**, y una columna nueva no queda cubierta sola:

- **`prospects`**: el panel solo puede actualizar columnas "humanas". Si la columna nueva la edita el usuario desde la UI, agregar `grant update (columna) on public.prospects to authenticated;`. Si la escribe la IA (score, label, paso), no darle grant.
- **`vendors`**: el select de `authenticated` es por lista de columnas para ocultar `ai_api_key` y `meta_access_token`. Una columna nueva que el panel deba leer necesita `grant select (columna) on public.vendors to authenticated;`. Si es un secreto, no agregarla y exponer un booleano generado como `ai_key_set`.

Los enums son `check` constraints con texto, no tipos enum. Al agregar un valor, reescribir la constraint.

## Permiso nuevo

Tres lugares, en este orden:

1. `PERMISSION_CATEGORIES` en `dashboard/app.js` (con `label` y `desc` en español).
2. `ALL_PERMISSION_KEYS` en `supabase/functions/_shared/permissions.ts`.
3. Migración que lo agrega a los roles que deban tenerlo (`update public.roles set permissions = array_append(...) where name = '...' and not (... = any(permissions))`) y a las listas de `seed_organization()` para empresas futuras.

Luego gatear la UI con `data-perm="x.y"` o `data-perm-any="x.y a.b"` en `index.html`, y el backend con `has_permission('x.y')` en las políticas o `requirePermission(caller, 'x.y')` en la función.

## Edge Function nueva

- Importar de `../_shared/auth.ts`: `preflight`, `getCaller`, `requirePermission`, `handleError`, `HttpError`, `json` y el cliente `admin`.
- Estructura: `preflight` → `getCaller` → `requirePermission` → parsear body → operar con `admin` **filtrando siempre por `caller.organizationId`** → `json({...})`. Los errores van por `handleError`.
- Nunca confiar en `organization_id` del body salvo que el que llama sea super-admin (ver `targetOrgId()` en `admin-users`).
- Los secrets se leen con `Deno.env.get`; documentarlos en `.env.example`.
- Solo agregar la función a `supabase/config.toml` si necesita `verify_jwt = false` (webhooks externos).
- Desplegar por nombre con `/deploy functions <nombre>`.

## Login por teléfono

`normalizePhone`, `normalizeE164` y `vendorLoginEmail` viven duplicados en `dashboard/app.js` y `supabase/functions/_shared/phone.ts`. Cualquier cambio va en los dos, con la misma lógica exacta.

## Antes de dar por terminado

- [ ] Toda tabla nueva tiene `organization_id`, RLS habilitado y políticas `to authenticated`.
- [ ] Ninguna política menciona `anon`.
- [ ] Columnas nuevas en `prospects` o `vendors` tienen su grant por columna si el panel las usa.
- [ ] Permisos nuevos están en `app.js`, `permissions.ts` y en los roles.
- [ ] El `README.md` se actualizó si cambió el modelo de datos, las funciones o los secrets.
