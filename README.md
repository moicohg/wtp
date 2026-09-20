# CRM WhatsApp (wtp)

CRM multi-empresa (SaaS) para vender por WhatsApp con un bot de IA que califica leads automáticamente y un panel web donde los vendedores atienden las conversaciones.

- **Frontend**: dashboard estático (HTML + CSS + JS sin framework) desplegado en Vercel.
- **Backend**: Supabase (proyecto `crmwtp`) con Postgres + RLS, Auth, Storage, Realtime y Edge Functions en Deno.
- **Canales de WhatsApp**: Evolution API (self-hosted) y Meta WhatsApp Business Cloud API.
- **IA**: cada canal elige su proveedor (Anthropic, OpenAI o Google) con su propia API key.

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
                                              │   2. guarda el mensaje
                                              │   3. llama a la IA del canal
                                              │   4. guarda respuesta + score/label
                                              │   5. responde por WhatsApp
                                              ▼
                                     Postgres (Supabase)
                                     organizations · profiles · vendors · agents
                                     prospects · messages · roles · products …
                                              ▲
                                              │  Realtime + PostgREST (RLS por empresa)
                                              │
                        dashboard/ (Vercel) ──┤
                        login con Supabase Auth
                                              │
                                              └──▶ send-message · admin-users · update-vendor-ai
                                                   meta-exchange · product-autocomplete
                                                   catalog-analyze-prompt  (exigen sesión + permiso)
```

---

## Estructura del repositorio

```
wtp/
├── dashboard/                  Panel web (se sirve tal cual, sin build)
│   ├── index.html              Todas las vistas, modales y la pantalla de login
│   ├── app.js                  Lógica completa del panel (~5.400 líneas)
│   └── style.css               Estilos
├── supabase/
│   ├── config.toml             project_id + verify_jwt de los webhooks
│   ├── functions/
│   │   ├── _shared/
│   │   │   ├── auth.ts         getCaller(), requirePermission(), cliente admin
│   │   │   ├── permissions.ts  Lista de permisos (espejo de app.js)
│   │   │   └── phone.ts        Login por teléfono (espejo de app.js)
│   │   ├── whatsapp-handler/   Webhook Evolution API → IA
│   │   ├── meta-webhook/       Webhook Meta Cloud API → IA
│   │   ├── send-message/       Envío manual desde el chat del panel
│   │   ├── admin-users/        Alta/baja de empresas y usuarios
│   │   ├── update-vendor-ai/   Cambiar proveedor/clave/modelo/prompt de un canal
│   │   ├── meta-exchange/      Conectar un canal de Meta (OAuth o token manual)
│   │   ├── product-autocomplete/    Generar catálogo de productos con IA
│   │   └── catalog-analyze-prompt/  Detectar productos en el system prompt
│   └── migrations/             Esquema completo, en orden cronológico
├── .env.example                Secrets de las Edge Functions
└── vercel.json                 outputDirectory = dashboard
```

---

## Módulos del panel

| Sección | Qué hace | Permiso que la muestra |
|---|---|---|
| Dashboard | KPIs (leads, ventas cerradas, por depositar, conversión) y pestañas Hoy, Dueño, Embudo, Asesores, Perdidos, Salud, Productos y Anuncios | `analytics.dashboard` |
| Canales › Lista de asesores | Tarjetas de canales (vendors), agregar canal, asignar vendedor, config del bot | `config.manage_channels` |
| Canales › Bandeja Global | Todos los chats de la empresa con filtros por canal, etapa, etiqueta, vendedor y fecha | `leads.view` |
| Canales › (cada canal) | Chat de 3 paneles: contactos, conversación e "Info del cliente" | `leads.view` |
| Productos | Catálogo de productos con precios (PEN/USD) y autocompletado por IA | `config.products` |
| Catálogo IA | Archivos que la IA puede mencionar, asignados a uno o más canales | `config.products` |
| Leads | Tabla de prospectos por canal con KPIs y drawer de detalle | `leads.view` |
| Automatización | Cadencias multi-día (plantilla, pasos, audiencia). Solo definición, sin motor | `messaging.manage_automations` |
| Disponibilidad | Estado en tiempo real de cada vendedor, historial y config de asignación/alertas | todos |
| Configuración | Usuarios de la empresa y Roles con permisos | `users.manage_users` / `users.manage_roles` |
| Empresas | Crear empresas, activarlas y fijar `max_channels` | solo super-admin |

En el chat, el panel "Info del cliente" permite editar etapa, perfil, etiquetas, estado de conversación, calificación por rúbrica (Necesidad / Inversión / Urgencia / Autoridad), campos personalizados y apagar la IA solo para ese chat.

El topbar tiene un selector rápido para que el vendedor cambie su propio estado (listo, atendiendo, pausa, fuera de atención).

---

## Modelo de datos

Tablas principales (todas en `public`):

| Tabla | Descripción |
|---|---|
| `organizations` | Empresa cliente del SaaS. `max_channels` limita cuántos canales puede crear |
| `profiles` | Una fila por usuario de Auth: empresa, tipo (`admin` / `vendedor`), super-admin, vínculo a `agents` |
| `vendors` | Canal de WhatsApp con su bot: tipo (`evolution` / `meta`), credenciales, proveedor de IA, prompt, vendedor asignado, keywords |
| `agents` | Vendedor humano: nombre, teléfono, rol, estado en tiempo real, prioridad, vencimiento de acceso |
| `prospects` | Lead. La IA calcula `score`, `label` (CALIFICADO / TIBIO / FRIO / DESCARTADO) y `conversation_step`. El humano edita etapa, etiquetas, perfil, notas, rúbrica y campos personalizados. Al guardar la rúbrica, el trigger `apply_calificacion_score()` recalcula `score`/`label`/`prioridad` (suma de puntos: ≥70 CALIFICADO, 40-69 TIBIO, <40 FRIO) |
| `messages` | Historial por prospecto (`user` / `assistant`), con adjuntos opcionales |
| `roles` | Roles por empresa con array de permisos. "Administrador" es de sistema |
| `products` | Catálogo de productos |
| `catalog_files` | Archivos del Catálogo IA asignados a canales |
| `custom_fields` | Definición de campos personalizados (los valores van en `prospects.custom_field_values`) |
| `automations` | Definición de automatizaciones y su audiencia |
| `agent_status_log` | Historial de estados de cada vendedor |
| `availability_settings` | Config de asignación inteligente y alertas, una fila por empresa |

Vista `prospect_inbox`: une prospecto + canal + vendedor efectivo + último mensaje. Es la fuente de la Bandeja Global. Un lead está "prestado" cuando `handled_by_agent_id` difiere del vendedor asignado al canal.

Bucket de Storage `chat-media` (público): adjuntos que el asesor envía desde el chat. Se sube bajo el prefijo de la empresa.

Realtime está habilitado en `prospects` y `messages`.

---

## Multi-empresa y seguridad

Desde el 2026-09-13 el CRM es multi-empresa con login real. Reglas:

- **Aislamiento por RLS**: toda tabla de negocio tiene `organization_id`. Las políticas son `to authenticated` y filtran por `current_org_id()`. El rol `anon` no tiene ningún privilegio en `public`; la clave publicable solo sirve para Auth.
- **Tablas raíz** (vendors, agents, roles, products, etc.): `organization_id` con default `current_org_id()`.
- **Tablas hijas** (prospects, messages, agent_status_log): un trigger deriva siempre la empresa del padre. Nadie puede colgar una fila de un padre ajeno.
- **Helpers `security definer`** en Postgres: `current_profile()`, `current_org_id()`, `is_super_admin()`, `is_org_admin()`, `has_permission(p)`, `can_access_prospect(...)`.
- **Visibilidad del vendedor**: ve los leads de los canales asignados a él o los que le prestaron. Los admins ven toda la empresa.
- **Secretos no legibles por el cliente**: `vendors.ai_api_key` y `meta_access_token` no se pueden leer desde el panel. El panel usa la columna generada `ai_key_set`.
- **Escrituras solo por Edge Functions**: `organizations`, `profiles` y `messages` se escriben únicamente con `service_role`. En `prospects` el panel solo puede actualizar columnas "humanas"; score, label y paso son de la IA.
- **Límite de canales**: trigger `enforce_channel_limit` lanza `LIMITE_CANALES:<n>` al superar `max_channels`.
- **Un vendedor solo cambia su propio estado**: trigger `agents_guard_self_update` evita que se autoasigne un rol o cambie su vencimiento.

### Permisos

Definidos en dos lugares que deben mantenerse iguales: `PERMISSION_CATEGORIES` en [dashboard/app.js](dashboard/app.js) y `ALL_PERMISSION_KEYS` en [supabase/functions/_shared/permissions.ts](supabase/functions/_shared/permissions.ts).

Grupos: `leads.*`, `messaging.*`, `agenda.*`, `analytics.*`, `config.*`, `users.*`. Los admins tienen todos. Los vendedores reciben los de su rol. En el HTML, `data-perm` y `data-perm-any` ocultan lo que el usuario no puede usar.

Al crear una empresa, un trigger siembra los roles "Administrador" (sistema) y "Vendedores", y su fila de `availability_settings`.

### Cuentas y login

- **Super-admin (dueño de la plataforma)**: `kanbansuite@gmail.com`, admin de la empresa inicial "007". Ve la sección Empresas y puede administrar cualquier empresa.
- **Admins de empresa**: entran con correo y contraseña.
- **Vendedores**: entran con **teléfono** y contraseña. En Auth se crean con un correo sintético `<dígitos E.164>@vendedor.invalid` (misma lógica en `app.js` y `phone.ts`). No reciben correos.
- Todas las altas, bajas, cambios de contraseña y de estado pasan por la Edge Function `admin-users`.
- El acceso de un vendedor puede vencer en una fecha (`agents.access_expires_at`).

---

## Edge Functions

| Función | Quién la llama | Auth | Qué hace |
|---|---|---|---|
| `whatsapp-handler` | Evolution API (webhook, `verify_jwt=true`) | JWT en el gateway; escribe con service_role | Recibe el mensaje, crea/actualiza el prospecto, llama a la IA del canal y responde. Ignora mensajes propios, grupos y mensajes sin texto |
| `meta-webhook` | Meta Cloud API (webhook, `verify_jwt=false`) | verificación `hub.verify_token` | Igual que la anterior para canales Meta. GET responde el challenge de verificación |
| `send-message` | Panel (chat) | sesión + acceso al chat | Envía texto o adjunto por Evolution o Meta y guarda el mensaje como `assistant` |
| `admin-users` | Panel (Configuración y Empresas) | sesión + `users.manage_users` o super-admin | Acciones: `create_organization`, `list_organizations`, `set_organization_active`, `set_organization_limits`, `create_user`, `update_user`, `reset_password`, `set_active`, `delete_user` |
| `update-vendor-ai` | Panel (config del bot) | sesión + `config.ai_settings` | Cambia proveedor, clave, modelo y prompt de un canal de la empresa |
| `meta-exchange` | Panel (agregar canal Meta) | sesión + `config.manage_channels` | Intercambia el code de OAuth o acepta un token manual y crea el canal |
| `product-autocomplete` | Panel (Productos) | sesión + `config.products` | Genera productos con OpenAI a partir de una descripción del negocio |
| `catalog-analyze-prompt` | Panel (Catálogo IA) | sesión + `config.products` | Detecta con OpenAI qué productos menciona el system prompt del canal |

La identidad del que llama sale siempre del `access_token` del usuario (`getCaller()` en `_shared/auth.ts`), nunca de la clave publicable.

### Flujo de un mensaje entrante

1. El webhook identifica el canal por `evolution_instance_id` o `meta_phone_number_id`.
2. Busca o crea el prospecto por `(vendor_id, phone)` en `paso_0`.
3. Guarda el mensaje del cliente.
4. Si el canal no tiene API key o el chat tiene `ia_enabled=false`, termina ahí.
5. Llama al proveedor de IA con el `system_prompt` del canal (o el prompt por defecto "Alia", agente inmobiliaria) y el historial.
6. La IA devuelve JSON con la respuesta, datos extraídos, `score`, `label` y `conversation_step` (paso_0 → paso_1 → paso_2 → calificado / tibio / frio).
7. Actualiza el prospecto, guarda la respuesta y la envía por WhatsApp.

---

## Variables de entorno

Secrets de las Edge Functions. Configurar con `supabase secrets set --env-file .env` (ver [.env.example](.env.example)):

| Variable | Uso |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | Clientes de Supabase (los provee la plataforma) |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | Canal Evolution API |
| `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` | Canal Meta Cloud API |
| `META_REGISTER_PIN` | PIN de 6 dígitos con el que `meta-exchange` registra el número al conectar un canal con "Continuar con Facebook" (Embedded Signup). Sin él se omite el registro |
| `OPENAI_API_KEY` | `product-autocomplete` y `catalog-analyze-prompt` |

El panel lleva `SUPABASE_URL` y la clave publicable hardcodeadas al inicio de [dashboard/app.js](dashboard/app.js). Ahí mismo van `META_APP_ID` y `META_CONFIG_ID` (públicos) para el botón "Continuar con Facebook"; vacíos, el botón se oculta y queda solo la conexión manual con token.

Páginas públicas que exige Meta para publicar la app: [privacidad](dashboard/privacidad.html), [términos](dashboard/terminos.html) y [eliminación de datos](dashboard/eliminar-datos.html).

---

## Desarrollo local

No hay build ni dependencias de npm. El panel se sirve como archivos estáticos:

```bash
cd dashboard
python3 -m http.server 8000
# abrir http://localhost:8000
```

El panel apunta a la base de producción. Para pruebas manuales o con Playwright, crear datos con prefijo "QA …" y borrarlos al terminar.

Docker no está disponible en la máquina de desarrollo, así que `supabase db diff` no funciona. Para consultar la base remota:

```bash
supabase db query --linked "select count(*) from public.organizations"
```

---

## Despliegue

**Frontend (Vercel)**: integración con Git. Basta con hacer push a `main`.

```bash
git push origin main
gh api repos/moicohg/wtp/deployments   # verificar
```

**Migraciones**:

```bash
supabase db push --yes
```

**Edge Functions**: desplegar siempre por nombre. Nunca correr un `supabase functions deploy` genérico ni redesplegar `meta-webhook` o `whatsapp-handler` sin necesidad: [supabase/config.toml](supabase/config.toml) fija su `verify_jwt` y un despliegue con otro valor rompe la entrega de mensajes.

```bash
supabase functions deploy send-message admin-users update-vendor-ai
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
- **Permiso nuevo**: agregarlo en `app.js` y en `permissions.ts`.
- **Cambios en el login por teléfono**: replicar en `app.js` y en `phone.ts`.
- Las Edge Functions responden JSON con `{ error }` y códigos HTTP claros. Usar `HttpError` de `_shared/auth.ts`.
- Las migraciones llevan un comentario inicial que explica el por qué del cambio.

---

## Estado y pendientes

Construido y en producción:

- Bot de calificación por IA en canales Evolution y Meta.
- Panel completo con chat, bandeja global, leads, productos, catálogo IA, disponibilidad, usuarios, roles y empresas.
- Multi-empresa con Auth, RLS y lockdown del rol `anon`.

Pendiente o solo definido:

- **Motor de automatizaciones**: se guarda la cadencia y la audiencia, pero no existe el proceso que inscribe leads y envía mensajes programados.
- **Asignación inteligente y alertas de respuesta**: se guarda la configuración en `availability_settings`, pero no hay motor que reparta leads ni envíe la alerta por WhatsApp.
- **Permisos sin UI que gatear**: `leads.create_contacts`, `messaging.send_broadcasts`, `messaging.view_broadcasts`, `messaging.manage_templates`, `agenda.*`, `config.migrate_channels`.
- **Vincular un agente existente a un login**: `admin-users` acepta `agent_id`, pero el panel no ofrece el botón.
- **Desactivar el registro público** en Supabase Auth ("Allow new users to sign up") para que solo `admin-users` cree cuentas.
