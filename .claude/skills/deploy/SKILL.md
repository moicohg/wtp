---
name: deploy
description: Despliega el CRM wtp a producción. Frontend a Vercel por git push, migraciones con supabase db push y Edge Functions por nombre. Solo se ejecuta cuando el usuario lo pide.
argument-hint: [frontend | db | functions <nombres> | todo]
disable-model-invocation: true
allowed-tools: Bash, Read, Grep
---

# Desplegar wtp

Qué desplegar según lo que pidió el usuario: `$ARGUMENTS`
Si no indicó nada, preguntar antes de tocar producción.

Estado del repo ahora:

```
!`git status --short`
```

Commits locales que aún no están en origin/main:

```
!`git log origin/main..HEAD --oneline`
```

## Reglas que no se rompen

1. **Desplegar solo lo pedido.** "frontend" no implica migraciones ni funciones, y viceversa.
2. **Edge Functions siempre por nombre.** Nunca `supabase functions deploy` sin argumentos.
3. **No redesplegar `meta-webhook` ni `whatsapp-handler`** salvo que sus archivos hayan cambiado. `supabase/config.toml` fija su `verify_jwt`; un despliegue con otro valor corta la entrega de mensajes de WhatsApp.
4. **Las migraciones sin commitear `2026091[234]000000_*.sql`** (automations, availability) ya están aplicadas en remoto. No incluirlas en un commit salvo que el usuario lo pida.
5. **No mostrar secretos.** Nada de `echo` de claves ni tokens.
6. Docker no está disponible: `supabase db diff` no funciona. Usar `supabase migration list` para comparar local y remoto.

## Frontend (Vercel)

Vercel despliega por integración con Git al recibir push en `main`.

```bash
git push origin main
gh api repos/moicohg/wtp/deployments --jq '.[0] | {sha: .sha[0:7], created_at, environment}'
```

Si hay cambios sin commitear que el usuario quiere desplegar, hacer el commit primero (mensaje en español, imperativo, una línea) y luego el push. Si no dijo que quiere commitear, preguntar.

## Base de datos

```bash
supabase migration list
supabase db push --yes
supabase migration list
```

El segundo `migration list` confirma que la migración aparece en remoto. Si la migración toca RLS o grants, verificar con una consulta:

```bash
supabase db query --linked "select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2"
```

## Edge Functions

```bash
supabase functions deploy <nombre> [<nombre> ...]
```

Si cambió algo en `supabase/functions/_shared/`, redesplegar todas las funciones que lo importan:

```
admin-users catalog-analyze-prompt meta-exchange product-autocomplete send-message update-vendor-ai
```

Los dos webhooks (`whatsapp-handler`, `meta-webhook`) no importan `_shared`, así que no entran en ese lote.

Si hay secrets nuevos, el usuario los carga con `supabase secrets set --env-file .env`. No leer ni imprimir el `.env`.

## Reporte final

Decir qué se desplegó y qué no, el commit que quedó en producción, y el resultado de cada verificación. Si algo falló, pegar la salida del error tal cual.
