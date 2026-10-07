# CRM WhatsApp (wtp)

CRM multi-empresa (SaaS) para vender por WhatsApp. Un bot de IA atiende y califica a los leads, y un panel web permite a los vendedores atender las conversaciones, priorizar su día y agendar citas. Cada empresa cliente trabaja con su propio plan: topes de canales, vendedores, uso de IA y archivos, y fecha de vencimiento.

- **Frontend**: dashboard estático (HTML + CSS + JS sin framework) desplegado en Vercel.
- **Backend**: Supabase (proyecto `crmwtp`) con Postgres + RLS, Auth, Storage, Realtime, Vault, pg_cron y Edge Functions en Deno.
- **Canales de WhatsApp**: dos formas de conectar un número.
  - **Simple (QR)**: Evolution API self-hosted. El vendedor escanea un QR desde el panel.
  - **Profesional (Meta oficial)**: WhatsApp Business Cloud API, con token manual o "Continuar con Facebook" (Embedded Signup).
- **IA**: cada canal elige su proveedor (Anthropic, OpenAI o Google) con su propia API key. La IA responde, califica, detecta citas y, en canales QR, entiende notas de voz e imágenes.

Repositorio: https://github.com/moicohg/wtp

---

## Arquitectura

```
 Cliente WhatsApp
       │
       ▼
 Evolution API ──webhook──▶ whatsapp-handler ─┐
 Meta Cloud API ──webhook──▶ meta-webhook ────┤  (Edge Functions, service_role)
                                              │   1. busca/crea el prospecto
                                              │   2. guarda el mensaje (y el adjunto en chat-media)
                                              │   3. revisa topes del plan (IA, almacenamiento, vencimiento)
                                              │   4. entiende audio/imagen, llama a la IA del canal
                                              │   5. guarda respuesta + score/label y propone citas
                                              │   6. responde por WhatsApp
                                              ▼
                                     Postgres (Supabase)
                                     organizations · profiles · vendors · agents
                                     prospects · messages · appointments · roles …
                                              ▲                         ▲
                                              │  Realtime + PostgREST   │ pg_cron (diario) ──▶ purge-media
                                              │  (RLS por empresa)
                        dashboard/ (Vercel) ──┤
                        login con Supabase Auth
                                              │
                                              └──▶ evolution-connect · send-message · admin-users
                                                   update-vendor-ai · meta-exchange
                                                   product-autocomplete · catalog-analyze-prompt
                                                   (exigen sesión + permiso)
```

---

## Estructura del repositorio

```
wtp/
├── dashboard/                  Panel web (se sirve tal cual, sin build)
│   ├── index.html              Todas las vistas, modales y la pantalla de login
│   ├── app.js                  Lógica completa del panel (~6.600 líneas)
│   ├── style.css               Estilos
│   └── privacidad.html · terminos.html · eliminar-datos.html   Páginas públicas que exige Meta
├── supabase/
│   ├── config.toml             project_id + verify_jwt de los webhooks y de purge-media
│   ├── functions/
│   │   ├── _shared/
│   │   │   ├── auth.ts          getCaller(), requirePermission(), cliente admin, chequeo de plan vencido
│   │   │   ├── permissions.ts   Lista de permisos (espejo de app.js)
│   │   │   ├── phone.ts         Login por teléfono (espejo de app.js)
│   │   │   ├── limits.ts        Consumo del plan (org_usage) y reglas aiAllowed / storageAllowed
│   │   │   ├── appointments.ts  Detección de citas con la IA del canal
│   │   │   └── media-ai.ts      Transcribir notas de voz y describir imágenes
│   │   ├── whatsapp-handler/    Webhook Evolution API → IA (texto, adjuntos, estado de la sesión)
│   │   ├── meta-webhook/        Webhook Meta Cloud API → IA
│   │   ├── evolution-connect/   Crear/reconectar/borrar canales QR (instancia + QR)
│   │   ├── send-message/        Envío manual desde el chat del panel
│   │   ├── admin-users/         Empresas, usuarios, límites y consumo del plan
│   │   ├── update-vendor-ai/    Proveedor/clave/modelo/prompt de un canal y prueba de la clave
│   │   ├── meta-exchange/       Conectar un canal de Meta (OAuth o token manual)
│   │   ├── purge-media/         Borrado diario de adjuntos viejos (lo llama pg_cron)
│   │   ├── product-autocomplete/    Generar catálogo de productos con IA
│   │   └── catalog-analyze-prompt/  Detectar productos en el system prompt
│   └── migrations/             Esquema completo (27 archivos), en orden cronológico
├── .claude/skills/             deploy · qa · esquema (ver más abajo)
├── .env.example                Secrets de las Edge Functions
└── vercel.json                 outputDirectory = dashboard
```

---

## Módulos del panel

| Sección | Qué hace | Permiso que la muestra |
|---|---|---|
| Dashboard | KPIs (leads, ventas cerradas, por depositar, conversión) y pestañas Hoy, Dueño, Embudo, Asesores, Perdidos, Salud, Productos y Anuncios | `analytics.dashboard` |
| Agenda | Cola de leads priorizada, "siguiente mejor acción", citas del día y citas por confirmar (ver [Agenda inteligente](#agenda-inteligente)) | `agenda.view_priority_queue` |
| Bandeja global | Todos los chats de la empresa con filtros por canal, etapa, etiqueta, vendedor y fecha | `leads.view` |
| Canales | Lista de canales con filtros, carga por asesor, uso del plan y panel de detalle del canal seleccionado | `config.manage_channels` / `leads.view` |
| Canales › (cada canal) | Chat de 3 paneles: contactos, conversación e "Info del cliente" | `leads.view` |
| Productos | Catálogo de productos con precios (PEN/USD) y autocompletado por IA | `config.products` |
| Catálogo IA | Archivos que la IA puede mencionar, asignados a uno o más canales | `config.products` |
| Leads | Tabla de prospectos por canal con KPIs y drawer de detalle | `leads.view` |
| Automatización | Cadencias multi-día (plantilla, pasos, audiencia). Solo definición, sin motor | `messaging.manage_automations` |
| Disponibilidad | Estado en tiempo real de cada vendedor, historial y config de asignación/alertas | todos |
| Configuración | Usuarios de la empresa y Roles con permisos | `users.manage_users` / `users.manage_roles` |
| Empresas | Crear empresas, fijar su plan (límites y vencimiento), activarlas y ver su consumo | solo super-admin |

**Pantalla Canales**: tabla con canal, estado, IA y asesor; pestañas Todos / Conectados / Desconectados / IA inactiva; búsqueda y filtro por asesor. Al elegir una fila, el panel de la derecha muestra asesor asignado, prompt de la IA, palabras clave, integraciones y las acciones (configurar, ver conversaciones, eliminar). Abajo, "Carga por asesor" y la tarjeta "Uso del plan" (solo administradores). Pixel de Meta, Formularios e Importar aparecen como "Próximamente".

**Configurar un canal**: proveedor, modelo, API key, palabras clave y prompt. El botón **Probar conexión de IA** hace una llamada mínima al proveedor y avisa si la clave no coincide con el proveedor, es inválida, no tiene saldo o el modelo no existe.

**Chat**: el panel "Info del cliente" permite editar etapa, perfil, etiquetas, estado de conversación, calificación por rúbrica (Necesidad / Inversión / Urgencia / Autoridad), campos personalizados y apagar la IA solo para ese chat. Las notas de voz muestran su transcripción (🎙) y las imágenes su descripción (🖼).

El topbar tiene un selector rápido para que el vendedor cambie su propio estado (listo, atendiendo, pausa, fuera de atención). El menú lateral usa iconos de línea sin color.

---

## Conectar un canal de WhatsApp

**Agregar canal** (Canales) ofrece dos tipos. El tope de canales de la empresa se aplica a ambos.

### Simple (QR) — Evolution API
1. El vendedor escribe el nombre del canal y pulsa **Crear canal y generar QR**.
2. `evolution-connect` (`create`) inserta el canal (`evolution_instance_id = wtp-<12 hex>`), crea la instancia en Evolution y registra el webhook hacia `whatsapp-handler` (eventos `MESSAGES_UPSERT` y `CONNECTION_UPDATE`, con la clave anon en las cabeceras para pasar el gateway).
3. El modal muestra el QR. El panel consulta `evolution-connect` (`status`) cada 3 s: refresca el QR cuando caduca y, al detectar la sesión abierta, cierra el modal y marca el canal como conectado. A los 5 min sin escanear pide empezar de nuevo.
4. Cerrar el modal con un QR pendiente cancela el alta (`delete`: borra la instancia y el canal).

**Reconectar**: si el teléfono se desvincula, el canal queda "Sin conectar". En el detalle del canal (o desde el banner rojo) el botón **Reconectar con QR** pide un QR nuevo para la misma instancia; el canal y sus conversaciones se conservan, y cancelar no lo borra.

**Aviso de caída**: `whatsapp-handler` procesa `connection.update`. `open` marca el canal conectado y limpia la caída; `close` registra `evolution_disconnected_at` y manda un WhatsApp **una sola vez** por caída (`evolution_alerted_at`) al teléfono del asesor del canal, desde otro canal QR conectado de la misma empresa (prueba con cada candidato hasta que uno envíe). `connecting` se ignora. Además el panel muestra un banner rojo con "Reconectar con QR" para los canales que ya estuvieron conectados; consulta `vendors` cada minuto (no se usa Realtime en `vendors` porque expondría las claves).

> Limitación: una empresa con un solo canal QR no recibe el WhatsApp cuando ese canal cae (no hay otro desde el cual enviar); solo ve el banner. Meta no sirve de reemplazo: solo permite texto libre dentro de las 24 h posteriores a un mensaje del cliente.

### Profesional (Meta oficial)
`meta-exchange` crea el canal con un token manual o con el `code` de OAuth de **Continuar con Facebook** (Embedded Signup). Ese botón requiere `META_APP_ID` y `META_CONFIG_ID` en [dashboard/app.js](dashboard/app.js); vacíos, queda solo la conexión manual. Al conectar con Facebook se registra el número en Cloud API con `META_REGISTER_PIN`.

---

## Agenda inteligente

Pantalla **Agenda**. Todo sale de la base de la empresa (`prospect_inbox`, `prospects` y `appointments`).

- **Indicadores**: leads en cola, citas de hoy, citas por confirmar y monto en juego (suma de presupuestos de la cola, en la moneda que más se repite).
- **Siguiente mejor acción**: el lead de mayor prioridad, con "por qué ahora", anillo de prioridad y cuatro barras. Acciones: abrir conversación, llamar, agendar cita, **Atendido** y **Posponer** (1 h, 3 h o mañana 9:00).
- **Cola priorizada**: tabla con filtros Todos / Calientes / Tibios / Fríos (por `label`).
- **Citas**: "Por confirmar" (propuestas por la IA, con Confirmar / Editar / Descartar), "Citas de hoy" con navegación por día, calendario mensual y **Nueva cita** manual.

**Prioridad (0-100)** = 35 % urgencia + 25 % valor + 25 % frescura + 15 % momentum:

| Señal | Cómo se calcula |
|---|---|
| Urgencia | `calif_urgencia` de la rúbrica (sobre 25); si no hay, por el plazo de compra (≤2 meses 100, ≤6 60, ≤12 30) |
| Valor | presupuesto del lead frente al mayor presupuesto de la cola |
| Frescura | desde el último mensaje: ≤5 min 100, ≤1 h 80, ≤24 h 50, ≤3 d 25, más 0 |
| Momentum | el `score` que le puso la IA |

Quedan fuera de la cola los leads `DESCARTADO`, los de etapa `venta`, los pospuestos y los atendidos; un mensaje nuevo del lead lo devuelve a la cola.

**Detección de citas**: las instrucciones del bot son del vendedor y no incluyen citas, así que `_shared/appointments.ts` hace una segunda llamada, con la IA del mismo canal, solo cuando el mensaje del cliente suena a cita (visita, domingo, 5 pm…). Resuelve fechas relativas en hora de Lima y deja **una** cita `por_confirmar` por prospecto (si la IA la reajusta, se actualiza). Un humano decide. Aplica a canales QR y Meta.

---

## Planes y límites por empresa

El dueño de la plataforma fija el plan de cada empresa en **Empresas** (botón 🔢 abre la ventana de límites; "+30 días" renueva). Todos los topes se hacen cumplir en el servidor, no solo en la interfaz.

| Límite | Columna en `organizations` | Valor por defecto | Qué pasa al llegar |
|---|---|---|---|
| Canales de WhatsApp (QR + Meta) | `max_channels` | 1 en base; el formulario sugiere 5 | El trigger `enforce_channel_limit` lanza `LIMITE_CANALES:<n>` |
| Vendedores (el administrador no cuenta) | `max_agents` | 5 | El trigger `enforce_agent_limit` lanza `LIMITE_VENDEDORES:<n>` |
| Respuestas de IA por mes (calendario, hora de Lima) | `max_ai_messages` | 1000 | El bot guarda el mensaje y **no responde**; el equipo sigue a mano |
| Almacenamiento de archivos (MB en `chat-media`) | `max_storage_mb` | 500 | La política de subida lo rechaza; el handler no guarda adjuntos entrantes (queda la nota "Adjunto no guardado") |
| Vencimiento del plan | `plan_expires_at` (último día de acceso, null = sin vencimiento) | sin vencimiento | Ver abajo |

La empresa dueña de la plataforma ("007") tiene topes altísimos y el super-admin queda exento del vencimiento.

- **Vencimiento**: `current_profile()` (el filtro que usan todas las políticas RLS) deja sin acceso a la empresa cuando `plan_expires_at` es anterior a hoy (hora de Lima). `getCaller` (Edge Functions) y el panel (pantalla "Plan vencido") aplican la misma regla, y el bot se detiene (`org_usage.plan_active`). El administrador ve un aviso cuando faltan 7 días o menos. Renovar es mover la fecha.
- **Consumo**: `org_usage(p_org)` (solo `service_role`) devuelve respuestas de IA del mes, bytes de almacenamiento, topes y `plan_active`. Las respuestas del bot se marcan con `messages.by_ai` para poder contarlas (las del equipo también son `role = 'assistant'`).
- **Adjuntos viejos**: cada día `purge-media` borra los archivos de más de 90 días; el mensaje se conserva con `media_url` en null y el chat muestra "Adjunto eliminado por antigüedad".
- **Dónde se ve**: columnas "Vendedores", "Vence" y "Uso del mes" en Empresas, y la tarjeta "Uso del plan" en Canales (acción `get_usage`).

---

## Modelo de datos

Tablas principales (todas en `public`):

| Tabla | Descripción |
|---|---|
| `organizations` | Empresa cliente. Plan: `max_channels`, `max_agents`, `max_ai_messages`, `max_storage_mb`, `plan_expires_at`; además `is_active` |
| `profiles` | Una fila por usuario de Auth: empresa, tipo (`admin` / `vendedor`), super-admin, vínculo a `agents` |
| `vendors` | Canal de WhatsApp con su bot: tipo (`evolution` / `meta`), credenciales, proveedor de IA, prompt, asesor asignado, keywords. Canales QR: `evolution_instance_id`, `evolution_connected`, `evolution_disconnected_at` (visible al panel) y `evolution_alerted_at` (interna) |
| `agents` | Vendedor humano: nombre, teléfono, rol, estado en tiempo real, prioridad, vencimiento de acceso |
| `prospects` | Lead. La IA calcula `score`, `label` (CALIFICADO / TIBIO / FRIO / DESCARTADO) y `conversation_step`. El humano edita etapa, etiquetas, perfil, notas, rúbrica y campos personalizados; `snoozed_until` y `attended_at` alimentan Posponer / Atendido. Al guardar la rúbrica, el trigger `apply_calificacion_score()` recalcula `score`/`label`/`prioridad` (≥70 CALIFICADO, 40-69 TIBIO, <40 FRIO) |
| `messages` | Historial por prospecto (`user` / `assistant`), con `media_url` / `media_type` y `by_ai` (respuesta del bot) |
| `appointments` | Citas (`por_confirmar` / `confirmada` / `completada` / `cancelada`, origen `ia` / `manual`, fecha, cita textual). Tabla hija de `prospects` |
| `roles` | Roles por empresa con array de permisos. "Administrador" es de sistema |
| `products` | Catálogo de productos |
| `catalog_files` | Archivos del Catálogo IA asignados a canales |
| `custom_fields` | Definición de campos personalizados (los valores van en `prospects.custom_field_values`) |
| `automations` | Definición de automatizaciones y su audiencia |
| `agent_status_log` | Historial de estados de cada vendedor |
| `availability_settings` | Config de asignación inteligente y alertas, una fila por empresa |

Vista `prospect_inbox`: une prospecto + canal + vendedor efectivo + último mensaje. Es la fuente de la Bandeja Global y de la Agenda. Un lead está "prestado" cuando `handled_by_agent_id` difiere del vendedor asignado al canal.

**Storage** — bucket público `chat-media`: adjuntos que sube el asesor y los que llegan de los clientes por QR. Ruta `<organization_id>/<prospect_id>/…`. La política de subida exige el prefijo de la propia empresa y espacio disponible (`org_storage_ok`). Al ser público, las URL pueden seguir respondiendo un rato por caché de CDN tras borrar el archivo.

**Realtime** está habilitado en `prospects`, `messages` y `appointments`. `vendors` no se publica: sus filas incluyen claves.

**Vault y cron**: el secreto `cron_secret` (Vault) autentica a pg_cron ante `purge-media`. Ver [Tareas programadas](#tareas-programadas).

---

## Multi-empresa y seguridad

Desde el 2026-09-13 el CRM es multi-empresa con login real. Reglas:

- **Aislamiento por RLS**: toda tabla de negocio tiene `organization_id`. Las políticas son `to authenticated` y filtran por `current_org_id()`. El rol `anon` no tiene ningún privilegio en `public`; la clave publicable solo sirve para Auth.
- **Tablas raíz** (vendors, agents, roles, products, etc.): `organization_id` con default `current_org_id()`.
- **Tablas hijas** (prospects, messages, appointments, agent_status_log): un trigger deriva siempre la empresa del padre. Nadie puede colgar una fila de un padre ajeno.
- **Helpers `security definer`** en Postgres: `current_profile()`, `current_org_id()`, `is_super_admin()`, `is_org_admin()`, `has_permission(p)`, `can_access_prospect(...)`, `org_usage(...)`, `org_storage_ok(...)`.
- **Visibilidad del vendedor**: ve los leads, citas y canales de los canales asignados a él o los que le prestaron. Los admins ven toda la empresa.
- **Secretos no legibles por el cliente**: `vendors.ai_api_key` y `meta_access_token` no se pueden leer desde el panel (select por columnas). El panel usa la columna generada `ai_key_set`. Una columna nueva de `vendors` u `organizations` que el panel deba leer necesita su propio `grant select`.
- **Escrituras solo por Edge Functions**: `organizations`, `profiles` y `messages` se escriben únicamente con `service_role`. En `prospects` el panel solo puede actualizar columnas "humanas" (más `snoozed_until` y `attended_at`); score, label y paso son de la IA.
- **Un vendedor solo cambia su propio estado**: trigger `agents_guard_self_update` evita que se autoasigne un rol o cambie su vencimiento.
- **Webhooks**: `whatsapp-handler` exige JWT en el gateway (Evolution manda la clave anon en sus cabeceras); `meta-webhook` verifica `hub.verify_token`; `purge-media` exige la cabecera `x-cron-secret`.

### Permisos

Definidos en dos lugares que deben mantenerse iguales: `PERMISSION_CATEGORIES` en [dashboard/app.js](dashboard/app.js) y `ALL_PERMISSION_KEYS` en [supabase/functions/_shared/permissions.ts](supabase/functions/_shared/permissions.ts).

Grupos: `leads.*`, `messaging.*`, `agenda.*`, `analytics.*`, `config.*`, `users.*`. Los admins tienen todos. Los vendedores reciben los de su rol. En el HTML, `data-perm` y `data-perm-any` ocultan lo que el usuario no puede usar. `agenda.view_priority_queue` muestra la Agenda y `agenda.manage` permite crear, confirmar y cancelar citas.

Al crear una empresa, un trigger siembra los roles "Administrador" (sistema) y "Vendedores", y su fila de `availability_settings`.

### Cuentas y login

- **Super-admin (dueño de la plataforma)**: `kanbansuite@gmail.com`, admin de la empresa inicial "007". Ve la sección Empresas y puede administrar cualquier empresa.
- **Admins de empresa**: entran con correo y contraseña.
- **Vendedores**: entran con **teléfono** y contraseña. En Auth se crean con un correo sintético `<dígitos E.164>@vendedor.invalid` (misma lógica en `app.js` y `phone.ts`). No reciben correos.
- Todas las altas, bajas, cambios de contraseña y de estado pasan por la Edge Function `admin-users`. El modal "Nuevo usuario" muestra la empresa y sus cupos (`Vendedores: 1 de 50`).
- El acceso de un vendedor puede vencer en una fecha (`agents.access_expires_at`).

---

## Edge Functions

| Función | Quién la llama | Auth | Qué hace |
|---|---|---|---|
| `whatsapp-handler` | Evolution API (webhook, `verify_jwt=true`) | JWT en el gateway; escribe con service_role | Mensajes entrantes: crea el prospecto, guarda texto y adjuntos, revisa topes, entiende audio/imagen, llama a la IA, detecta citas y responde. También procesa `connection.update` (estado de la sesión y aviso de caída). Resuelve el número real cuando WhatsApp usa LID (`remoteJidAlt`). Ignora mensajes propios y grupos |
| `meta-webhook` | Meta Cloud API (webhook, `verify_jwt=false`) | verificación `hub.verify_token` | Igual para canales Meta (texto): topes del plan y detección de citas. No recibe adjuntos todavía |
| `evolution-connect` | Panel (canales QR) | sesión + `config.manage_channels` | `create` (canal + instancia + QR), `status` (¿escaneado? o QR fresco) y `delete` |
| `send-message` | Panel (chat) | sesión + acceso al chat | Envía texto o adjunto por Evolution o Meta y guarda el mensaje como `assistant` |
| `admin-users` | Panel (Configuración, Empresas y Canales) | sesión; la mayoría exige `users.manage_users` o super-admin | `create_organization`, `list_organizations` (con consumo), `get_usage` (administrador, su propia empresa), `set_organization_active`, `set_organization_limits` (canales, vendedores, IA, archivos, vencimiento), `create_user`, `update_user`, `reset_password`, `set_active`, `delete_user` |
| `update-vendor-ai` | Panel (config del bot) | sesión + `config.ai_settings` | Cambia proveedor, modelo, clave y prompt de un canal; acción `test` que prueba la clave |
| `meta-exchange` | Panel (agregar canal Meta) | sesión + `config.manage_channels` | Intercambia el code de OAuth o acepta un token manual y crea el canal |
| `purge-media` | pg_cron (`verify_jwt=false`) | cabecera `x-cron-secret` = `CRON_SECRET` | Borra los adjuntos con más de 90 días |
| `product-autocomplete` | Panel (Productos) | sesión + `config.products` | Genera productos con OpenAI a partir de una descripción del negocio |
| `catalog-analyze-prompt` | Panel (Catálogo IA) | sesión + `config.products` | Detecta con OpenAI qué productos menciona el system prompt del canal |

La identidad del que llama sale siempre del `access_token` del usuario (`getCaller()` en `_shared/auth.ts`), nunca de la clave publicable.

### Flujo de un mensaje entrante

1. El webhook identifica el canal por `evolution_instance_id` o `meta_phone_number_id`.
2. Busca o crea el prospecto por `(vendor_id, phone)` en `paso_0`.
3. Consulta `org_usage`: si hay espacio baja el adjunto de Evolution y lo sube a `chat-media`; si no, guarda el mensaje con la nota "Adjunto no guardado".
4. Si el bot va a responder (hay API key, `ia_enabled`, cupo y plan vigente):
   - una **nota de voz** se transcribe (OpenAI Whisper o Gemini; Anthropic no transcribe audio) y una **imagen** se describe con el modelo del canal. El texto queda en el chat (🎙 / 🖼) y es lo que lee la IA. Límites: audio 8 MB, imagen 6 MB.
5. Guarda el mensaje del cliente. Sin texto que la IA pueda leer (audio sin transcribir, imagen sin descripción), termina: lo atiende una persona.
6. Si no hay API key, el chat tiene `ia_enabled=false`, se agotó el cupo mensual o el plan venció, termina ahí (el mensaje queda guardado).
7. Llama al proveedor de IA con el `system_prompt` del canal (o el prompt por defecto "Alia", agente inmobiliaria) y el historial.
8. La IA devuelve JSON con la respuesta, datos extraídos, `score`, `label` y `conversation_step` (paso_0 → paso_1 → paso_2 → calificado / tibio / frio).
9. Actualiza el prospecto, guarda la respuesta con `by_ai = true` y la envía por WhatsApp.
10. Si el mensaje suena a cita, `detectAppointment` propone una cita por confirmar.
11. Si el prospecto queda CALIFICADO, avisa por WhatsApp al teléfono del asesor del canal.

---

## Tareas programadas

pg_cron está activo (la migración `20260925000000_limites_ia_archivos.sql` crea la extensión y el job):

| Job | Cuándo | Qué hace |
|---|---|---|
| `purge-chat-media` | todos los días 08:00 UTC | `net.http_post` a `purge-media` con `x-cron-secret` (leído de Vault en cada ejecución) |

El valor del secreto **no está en el repositorio**: se crea una vez con `select vault.create_secret('<valor>', 'cron_secret')` y el mismo valor va en el secret `CRON_SECRET` de las Edge Functions (`supabase secrets set CRON_SECRET=…`). Sin él, `purge-media` responde 401.

---

## Variables de entorno

Secrets de las Edge Functions. Configurar con `supabase secrets set --env-file .env` (ver [.env.example](.env.example)):

| Variable | Uso |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Clientes de Supabase (los provee la plataforma). La clave anon también viaja en las cabeceras del webhook de Evolution |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | Servidor de Evolution API (la API key es la `AUTHENTICATION_API_KEY` global; v2.x). Sin URL ni key no funcionan ni el alta de canales QR ni el envío por QR |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Canal Meta Cloud API |
| `META_REGISTER_PIN` | PIN de 6 dígitos con el que `meta-exchange` registra el número al conectar con "Continuar con Facebook". Sin él se omite el registro |
| `OPENAI_API_KEY` | `product-autocomplete` y `catalog-analyze-prompt` (clave de la plataforma; la IA de cada canal usa la suya) |
| `CRON_SECRET` | Autentica a pg_cron ante `purge-media` (mismo valor que el secreto `cron_secret` de Vault) |

El panel lleva `SUPABASE_URL` y la clave publicable hardcodeadas al inicio de [dashboard/app.js](dashboard/app.js). Ahí mismo van `META_APP_ID` y `META_CONFIG_ID` (públicos) para el botón "Continuar con Facebook".

Páginas públicas que exige Meta para publicar la app: [privacidad](dashboard/privacidad.html), [términos](dashboard/terminos.html) y [eliminación de datos](dashboard/eliminar-datos.html).

---

## Desarrollo local

No hay build ni dependencias de npm. El panel se sirve como archivos estáticos:

```bash
cd dashboard
python3 -m http.server 8000
# abrir http://localhost:8000
```

El panel apunta a la base de producción. Para pruebas manuales o con Playwright, crear datos con prefijo "QA …" y borrarlos al terminar (incluidos los archivos que se hayan subido a `chat-media`).

Antes de publicar un cambio en `app.js`, comprobar que carga como módulo (detecta nombres repetidos que un chequeo normal no ve):

```bash
node --input-type=module --check < dashboard/app.js
```

Docker no está disponible en la máquina de desarrollo, así que `supabase db diff` no funciona: las migraciones se escriben a mano. Para consultar la base remota:

```bash
supabase db query --linked "select count(*) from public.organizations"
```

---

## Despliegue

**Frontend (Vercel)**: integración con Git. Basta con hacer push a `main`.

```bash
git push origin main
```

**Migraciones**: aplicar **antes** de publicar un panel que lea columnas nuevas (si no, el login falla por un grant que aún no existe).

```bash
supabase db push
```

**Edge Functions**: desplegar siempre por nombre. Dos reglas:

- [supabase/config.toml](supabase/config.toml) fija el `verify_jwt` de `meta-webhook` y `whatsapp-handler` (y `purge-media`): un despliegue con otro valor rompe la entrega de mensajes.
- El código de `_shared/` se **empaqueta dentro de cada función** al desplegar. Si cambia un archivo compartido, hay que redesplegar **todas** las funciones que lo importan, o seguirán con la versión vieja:

| Archivo compartido | Lo importan |
|---|---|
| `auth.ts` | `admin-users`, `evolution-connect`, `send-message`, `update-vendor-ai`, `meta-exchange`, `product-autocomplete`, `catalog-analyze-prompt` |
| `limits.ts` | `whatsapp-handler`, `meta-webhook` |
| `appointments.ts` | `whatsapp-handler`, `meta-webhook` |
| `media-ai.ts` | `whatsapp-handler` |

```bash
supabase functions deploy whatsapp-handler
```

---

## Skills de Claude Code

En [.claude/skills/](.claude/skills/) hay tres skills de proyecto:

| Skill | Cómo se usa | Para qué |
|---|---|---|
| `/deploy` | `/deploy frontend`, `/deploy db`, `/deploy functions send-message` | Despliegue guiado con las reglas de arriba. Solo se ejecuta a pedido |
| `/qa` | `/qa probar el modal de nuevo producto` | Prueba de UI con Playwright contra producción, con datos "QA " y limpieza obligatoria |
| `/esquema` | se carga solo al tocar migraciones, permisos o funciones | Checklist multi-empresa: `organization_id`, RLS, grants por columna, archivos espejo |

---

## Convenciones

- Todo el código, comentarios y UI están en español.
- **Tabla nueva**: agregar `organization_id` (default `current_org_id()` en tablas raíz o trigger desde el padre en hijas), habilitar RLS y escribir políticas `to authenticated`. Nunca políticas `anon`.
- **Columna nueva en `vendors`, `organizations` o `prospects`**: dar el `grant` por columna que corresponda si el panel la lee o la escribe; si es un secreto, exponer un booleano generado.
- **Permiso nuevo**: agregarlo en `app.js` y en `permissions.ts`.
- **Cambios en el login por teléfono**: replicar en `app.js` y en `phone.ts`.
- **Tope o plan nuevo**: columna en `organizations`, aplicarlo en la base (trigger, política o `org_usage`) y no solo en el panel.
- Las Edge Functions responden JSON con `{ error }` y códigos HTTP claros. Usar `HttpError` de `_shared/auth.ts`.
- Las migraciones llevan un comentario inicial que explica el por qué del cambio.

---

## Estado y pendientes

Construido y en producción:

- Bot de calificación por IA en canales QR (Evolution) y Meta, con entendimiento de notas de voz e imágenes en QR.
- Conexión de canales QR desde el panel (QR, reconexión y aviso de caída) y conexión Meta con token o Facebook.
- Agenda inteligente: cola priorizada, citas detectadas por la IA y calendario.
- Panel completo: chat, bandeja global, leads, productos, catálogo IA, disponibilidad, usuarios, roles, canales (lista + detalle) y empresas.
- Multi-empresa con Auth, RLS y lockdown del rol `anon`.
- Plan por empresa: canales, vendedores, respuestas de IA, almacenamiento, vencimiento y borrado de adjuntos a 90 días.

Pendiente o solo definido:

- **Adjuntos en canales Meta**: `meta-webhook` solo procesa texto; falta descargar el media con el token de Meta (y así transcribir/describir).
- **Audio en canales Anthropic**: Anthropic no transcribe; esas notas de voz quedan guardadas para una persona.
- **Cobro automático**: un pago aprobado (Mercado Pago) podría mover `plan_expires_at` +30 días. Hoy se renueva a mano desde Empresas.
- **Interruptor de IA por canal**: la IA se apaga por chat (`ia_enabled`) o quitando la clave; no hay un interruptor por canal.
- **Pixel de Meta, Formularios e Importar** (Canales): botones marcados "Próximamente".
- **Motor de automatizaciones**: se guarda la cadencia y la audiencia, pero no existe el proceso que inscribe leads y envía mensajes programados.
- **Asignación inteligente y alertas de respuesta**: se guarda la configuración en `availability_settings`, pero no hay motor que reparta leads ni envíe la alerta por WhatsApp.
- **Permisos sin UI que gatear**: `leads.create_contacts`, `messaging.send_broadcasts`, `messaging.view_broadcasts`, `messaging.manage_templates`, `config.migrate_channels`.
- **Vincular un agente existente a un login**: `admin-users` acepta `agent_id`, pero el panel no ofrece el botón.
- **Desactivar el registro público** en Supabase Auth ("Allow new users to sign up") para que solo `admin-users` cree cuentas.
- **Meta (Facebook Login)**: el botón está activo; faltan la prueba con un tester real, App Review y pasar la app a Live. El token de Meta caduca a los 60 días.

Sin verificar de punta a punta en producción:

- **WhatsApp de aviso de caída**: el envío no se pudo probar porque no había un segundo canal QR conectado. El banner y el registro de la caída sí están probados.
- **Aviso de 7 días y pantalla "Plan vencido" con un usuario real**: la regla de la base está probada; falta una empresa cliente no super-admin para verlo en pantalla.
- **Contador de respuestas de IA** (`by_ai`): se confirma con la primera respuesta real del bot tras el despliegue.
