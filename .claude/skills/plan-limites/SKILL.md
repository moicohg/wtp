---
name: plan-limites
description: Cómo agregar un tope, módulo contratable o regla de plan por empresa en wtp (columna en organizations, trigger/org_usage, admin-users, modal de Empresas y panel). Cargar antes de tocar planes, límites, vencimiento o enabled_sections.
---

# Planes y límites por empresa

Principio: **el tope se aplica en la base o en la Edge Function, nunca solo en la interfaz.** La UI solo informa.

## Límites existentes (`organizations`)

`max_channels`, `max_agents`, `max_ai_messages`, `max_storage_mb`, `plan_expires_at`, `enabled_sections`, `is_active`. Referencia de comportamiento en el README (“Planes y límites por empresa”).

## Tope numérico nuevo — checklist

1. **Migración** (cargar `/esquema`): columna `integer not null default N` con `check (>= 0)`, `grant select (columna) on public.organizations to authenticated` (el panel la lee), y fijar un valor alto a la empresa dueña `00000000-0000-4000-8000-000000000007`.
2. **Cómo se hace cumplir**, según el caso:
   - Cuenta de filas → trigger `before insert` que lanza `LIMITE_X:<n>` (modelo: `enforce_agent_limit`).
   - Consumo medible (mensajes, bytes) → agregarlo a `org_usage(p_org)` y evaluarlo en `_shared/limits.ts`; el handler decide qué hacer (p. ej. guardar y no responder).
   - Archivos → política de storage con `org_storage_ok`.
3. **`admin-users`**: aceptar la clave en `create_organization` (con default y validación) y en `set_organization_limits`; incluirla en `list_organizations`/`get_usage` si se debe mostrar.
4. **Panel**: campo en el formulario de crear empresa y en el modal de límites (`orgLimitsForm`), columna en la tabla de Empresas, y actualizar `state.me.organization` y el `select` del perfil (`organization:organizations(…)`) si se usa en pantalla.
5. **Mensaje de error**: el panel traduce `LIMITE_X:<n>` a un texto claro.
6. Redesplegar `admin-users` y las funciones que cambien (`/deploy`), y actualizar la tabla del README.

## Módulo contratable nuevo

Tres lugares con la misma lista: `PLAN_SECTIONS` (app.js), `ALL_SECTION_KEYS` (`_shared/sections.ts`) y el `check` de `enabled_sections` (migración nueva; reescribir la constraint). Con la sección apagada: el panel la oculta y no deja abrirla, y las funciones que la respaldan llaman `requireSection` (403). `null` = todas. Canales y Configuración nunca se apagan. Es restricción comercial, no de seguridad: el aislamiento sigue siendo RLS.

## Vencimiento

`plan_expires_at` es el **último día de acceso** (hora de Lima). `current_profile()` deja sin acceso a la empresa si ya pasó, `getCaller` y la pantalla “Plan vencido” aplican la misma regla, y `org_usage.plan_active` detiene el bot. El super-admin está exento. Renovar = mover la fecha (botón “+30 días”). El cobro automático (Mercado Pago) sigue pendiente.

## Probar

Con `supabase db query --linked` en una transacción con rollback, o con empresa “QA ” creada y borrada al terminar (`/qa`). Nunca modificar límites de empresas reales para probar.
