---
name: canal-ia
description: Mapa del flujo de mensajes de WhatsApp y del bot de IA en wtp (webhooks de Evolution y Meta, proveedores Anthropic/OpenAI/Google, topes del plan, ráfaga, adjuntos, citas, alertas). Cargar antes de tocar whatsapp-handler, meta-webhook, _shared/ de IA o la configuración de canales.
---

# Canales y bot de IA

## Piezas

| Archivo | Rol |
|---|---|
| `functions/whatsapp-handler/index.ts` | Webhook Evolution (QR): mensajes, adjuntos, `connection.update` y aviso de caída |
| `functions/meta-webhook/index.ts` | Webhook Meta Cloud API (solo texto por ahora) |
| `functions/send-message/` | Envío manual desde el chat (Evolution o Meta) y guardado como `assistant` |
| `functions/evolution-connect/` | `create` / `status` / `delete` de canales QR |
| `functions/meta-exchange/` | Alta de canal Meta con OAuth (`code`) o token manual |
| `functions/update-vendor-ai/` | Proveedor, modelo, clave y prompt del canal; acción `test` |
| `_shared/limits.ts` | `getOrgUsage`, `aiAllowed`, `storageAllowed`, `agendaEnabled` |
| `_shared/burst.ts` | Agrupar mensajes seguidos antes de responder |
| `_shared/media-ai.ts` | Transcribir audio (Whisper/Gemini) y describir imágenes |
| `_shared/appointments.ts` | Segunda llamada a la IA que propone citas |
| `functions/lead-alerts/`, `automation-runner/` | Cron: alerta de lead sin respuesta; envío de pasos de cadencias |

El detalle paso a paso está en el README (“Flujo de un mensaje entrante”); mantenerlo sincronizado si se cambia el orden.

## Invariantes (no romper)

1. **Guardar primero, decidir después**: el mensaje del cliente se guarda aunque la IA no responda.
2. La IA responde solo si hay API key, `vendors.ia_enabled` **y** `prospects.ia_enabled`, cupo mensual (`aiAllowed`) y plan vigente. Si falla la lectura de `org_usage` se deja pasar (mejor responder de más).
3. Las respuestas del bot se guardan con `by_ai = true` (cuentan para el tope); las de cadencias con `by_automation = true` (no cuentan como respuesta humana en la alerta).
4. Cada canal usa **su propia** API key y proveedor (`anthropic` / `openai` / `google`); la clave nunca se lee desde el panel (`ai_key_set` es el booleano).
5. Ráfaga: cada webhook espera `BURST_WAIT_MS` y solo responde el del último mensaje.
6. La IA devuelve JSON (`reply`, `extracted`, `score`, `label`, `conversation_step`); se parsea con tolerancia a texto extra. Prompt por defecto “Alia” si el canal no tiene `system_prompt`.
7. Meta solo permite texto libre dentro de 24 h tras un mensaje del cliente: cualquier envío proactivo (alertas, cadencias) puede fallar fuera de esa ventana y debe tolerarlo.
8. Hora de negocio: Lima (`America/Lima`) para mes de consumo, vencimiento, fechas relativas de citas y horas de cadencias.

## Cambiar de proveedor o agregar uno

1. Agregar el valor al `check` de `vendors.ai_provider` (migración, reescribir la constraint).
2. Rama nueva en la función de llamada a la IA de `whatsapp-handler` y `meta-webhook`, y en `_shared/appointments.ts`, `_shared/media-ai.ts` y la acción `test` de `update-vendor-ai`. Los cinco sitios deben soportarlo.
3. Opción en el `<select id="f-provider">` del modal de configuración y mensaje de error claro (clave inválida, sin saldo, modelo inexistente).

## Cambios de canal

- Canal QR nuevo: `evolution_instance_id = wtp-<12 hex>`, webhook con eventos `MESSAGES_UPSERT` y `CONNECTION_UPDATE` y la clave anon en las cabeceras.
- Todo cambio en handlers → redesplegar por nombre (`/deploy functions whatsapp-handler`); respetar `verify_jwt` de `config.toml`.
- Probar con `/qa` o con datos reales de un canal de prueba; nunca dejar mensajes de prueba en leads de clientes.
