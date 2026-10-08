---
name: edge-function
description: Plantilla y reglas para crear o modificar una Edge Function de wtp (Deno): auth con getCaller, permisos, HttpError, verify_jwt en config.toml, secrets y qué redesplegar cuando cambia _shared/. Cargar antes de escribir o tocar supabase/functions/.
---

# Edge Functions de wtp

Complementa a `/esquema` (RLS, grants, migraciones). Despliegue: `/deploy functions <nombre>`.

## Dos tipos

| Tipo | Quién la llama | Identidad | `verify_jwt` |
|---|---|---|---|
| **Del panel** | El dashboard con la sesión del usuario | `getCaller(req)` → perfil, empresa y permisos | por defecto (true) |
| **Webhook / cron** | Evolution, Meta o pg_cron | Secreto propio (`hub.verify_token`, `x-cron-secret`) o la clave anon que manda Evolution | false solo si el llamador no puede mandar JWT → declararlo en `supabase/config.toml` |

`config.toml` es espejo de la configuración viva: sin la entrada, un deploy genérico las vuelve a `true` y dejan de llegar los mensajes.

## Función del panel

```ts
import { admin, getCaller, handleError, HttpError, json, preflight, requirePermission } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);            // OPTIONS y método
  if (pre) return pre;
  try {
    const caller = await getCaller(req); // identidad sale del access_token, nunca de la anon key
    requirePermission(caller, 'x.y');
    const body = await req.json();
    // operar con `admin` (service_role, pasa por encima de RLS) FILTRANDO por caller.organizationId
    return json({ ok: true });
  } catch (err) {
    return handleError(err);             // HttpError → { error } con su status; lo demás → 500
  }
});
```

Reglas:
- `admin` ignora RLS: **todo** query lleva `.eq('organization_id', caller.organizationId)`. No confiar en un `organization_id` del body salvo super-admin (ver `targetOrgId()` en `admin-users`).
- Errores con `throw new HttpError(status, 'mensaje en español')`; el panel muestra `json.error`.
- Si la función depende de una sección contratada, usar `requireSection` (responde 403).
- `getCaller` ya rechaza plan vencido y empresa desactivada.
- Webhooks: guardar siempre el mensaje antes de decidir si la IA responde; ignorar mensajes propios y grupos.
- Secrets: `Deno.env.get('X')`, documentarlos en `.env.example` y en la tabla de Variables de entorno del README. Se cargan con `supabase secrets set`.
- Funciones de cron: validar `x-cron-secret` contra `CRON_SECRET`, agregar el job de pg_cron en una migración (`net.http_post` con el secreto leído de Vault).

## Código compartido (`_shared/`)

Se **empaqueta dentro de cada función** al desplegar. Si cambia un archivo de `_shared/`, redesplegar todas las que lo importan (tabla en el README, sección Despliegue). Para saberlo con certeza: `grep -rl "_shared/<archivo>" supabase/functions`.

Espejos que deben mantenerse iguales entre `app.js` y `_shared/`: permisos (`permissions.ts`), login por teléfono (`phone.ts`) y secciones (`sections.ts`).

## Al terminar

- [ ] Función agregada a la tabla del README (y a `config.toml` si `verify_jwt=false`).
- [ ] Secrets nuevos en `.env.example` y README.
- [ ] Redespliegue de las funciones afectadas (solo a pedido del usuario).
