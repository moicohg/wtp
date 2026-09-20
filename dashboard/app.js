import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Config ───────────────────────────────────────────────────────────────────
// La anon/publishable key es segura de exponer en el cliente para lecturas
// (RLS solo permite SELECT en prospects/messages). vendors y agents también
// aceptan escritura anon porque este panel todavía no tiene una capa de auth
// propia — ver supabase/migrations/20260907010000_agents_and_canales.sql.
// Antes de exponer este dashboard fuera de tu red, ponle autenticación.

const SUPABASE_URL = 'https://znalzptpffnbnzuckiid.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_OyjpoUWipe8vJL5GNgQjWw_WVtmGGFE';
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// App de Meta para "Continuar con Facebook" al conectar un canal (Embedded Signup).
// Ambos valores son públicos. Mientras estén vacíos el botón queda oculto y solo
// funciona la conexión manual con token.
//   META_APP_ID:    developers.facebook.com → tu app → Configuración → Básica
//   META_CONFIG_ID: Facebook Login for Business → Configuraciones (plantilla WhatsApp Embedded Signup)
const META_APP_ID = '';
const META_CONFIG_ID = '';
const FB_SDK_VERSION = 'v25.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Estado ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_INFO = {};

const AGENT_STATUS_META = {
  listo: { icon: '⚡', label: 'Listo para vender', color: 'ok', desc: 'Recibís leads y ofertas de reasignación' },
  atendiendo: { icon: '🎧', label: 'Atendiendo cliente', color: 'cold', desc: 'Atendiendo un lead activamente' },
  pausa: { icon: '☕', label: 'Pausa breve', color: 'warn', desc: 'Pausa temporal — máximo 10 minutos' },
  fuera_de_atencion: { icon: '🌙', label: 'Fuera de atención', color: 'off', desc: 'No recibís leads ni ofertas' },
  inactivo_sistema: { icon: '⛔', label: 'Inactivo (sistema)', color: 'danger' },
  difusiones: { icon: '📣', label: 'Enviando difusiones', color: 'purple' },
};
const AGENT_STATUS_ORDER = ['listo', 'atendiendo', 'pausa', 'fuera_de_atencion', 'inactivo_sistema', 'difusiones'];
// Estados que un vendedor puede elegirse a sí mismo desde el selector rápido
// del topbar (los otros dos los pone el sistema: inactividad y difusiones).
const MANUAL_STATUS_ORDER = ['listo', 'atendiendo', 'pausa', 'fuera_de_atencion'];

// ── Login por teléfono (vendedores) ──────────────────────────────────────────
// Espejo exacto de supabase/functions/_shared/phone.ts: el vendedor se crea en
// Auth con un correo sintético derivado de su número E.164, y aquí se deriva
// el mismo correo para iniciar sesión (sin SMS). Cualquier cambio va en ambos.
const VENDOR_LOGIN_DOMAIN = 'vendedor.invalid';
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

function normalizePhone(dial, number) {
  const cc = String(dial ?? '').replace(/\D/g, '');
  const n = String(number ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!cc || !n) return null;
  const e164 = `+${cc}${n}`;
  return E164_RE.test(e164) ? e164 : null;
}

function vendorLoginEmail(e164) {
  return `${e164.replace(/\D/g, '')}@${VENDOR_LOGIN_DOMAIN}`;
}

const COUNTRY_CODES = [
  { iso: 'PE', name: 'Perú', dial: '51' },
  { iso: 'MX', name: 'México', dial: '52' },
  { iso: 'CO', name: 'Colombia', dial: '57' },
  { iso: 'AR', name: 'Argentina', dial: '54' },
  { iso: 'CL', name: 'Chile', dial: '56' },
  { iso: 'EC', name: 'Ecuador', dial: '593' },
  { iso: 'BO', name: 'Bolivia', dial: '591' },
  { iso: 'VE', name: 'Venezuela', dial: '58' },
  { iso: 'UY', name: 'Uruguay', dial: '598' },
  { iso: 'PY', name: 'Paraguay', dial: '595' },
  { iso: 'BR', name: 'Brasil', dial: '55' },
  { iso: 'PA', name: 'Panamá', dial: '507' },
  { iso: 'CR', name: 'Costa Rica', dial: '506' },
  { iso: 'GT', name: 'Guatemala', dial: '502' },
  { iso: 'SV', name: 'El Salvador', dial: '503' },
  { iso: 'HN', name: 'Honduras', dial: '504' },
  { iso: 'NI', name: 'Nicaragua', dial: '505' },
  { iso: 'DO', name: 'Rep. Dominicana', dial: '1' },
  { iso: 'PR', name: 'Puerto Rico', dial: '1' },
  { iso: 'CU', name: 'Cuba', dial: '53' },
  { iso: 'US', name: 'Estados Unidos', dial: '1' },
  { iso: 'CA', name: 'Canadá', dial: '1' },
  { iso: 'ES', name: 'España', dial: '34' },
  { iso: 'PT', name: 'Portugal', dial: '351' },
  { iso: 'IT', name: 'Italia', dial: '39' },
  { iso: 'FR', name: 'Francia', dial: '33' },
  { iso: 'DE', name: 'Alemania', dial: '49' },
  { iso: 'GB', name: 'Reino Unido', dial: '44' },
];

const flagEmoji = (iso) => String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

function fillDialSelects() {
  const options = COUNTRY_CODES.map((c) => `<option value="${c.dial}" ${c.iso === 'PE' ? 'selected' : ''}>${flagEmoji(c.iso)} ${c.name} +${c.dial}</option>`).join('');
  document.querySelectorAll('#login-dial, #agent-dial').forEach((sel) => (sel.innerHTML = options));
}

// ── Roles y permisos ─────────────────────────────────────────────────────────
// Solo define los permisos disponibles y cómo se agrupan en la UI de
// Configuración › Roles. No se hacen cumplir en ningún lado todavía — quedan
// listos para usarse cuando el panel tenga login real (ver migración
// 20260916000000_roles.sql).

const PERMISSION_CATEGORIES = [
  {
    key: 'leads', label: 'Leads y contactos',
    permissions: [
      { key: 'leads.view', label: 'Ver leads', desc: 'Ver el listado de leads, sus negociaciones, etiquetas y campos personalizados.' },
      { key: 'leads.edit', label: 'Editar leads', desc: 'Crear, editar y eliminar leads y negociaciones, y gestionar su calificación.' },
      { key: 'leads.assign', label: 'Asignar leads', desc: 'Asignar y reasignar leads entre vendedores.' },
      { key: 'leads.create_contacts', label: 'Crear contactos', desc: 'Crear contactos nuevos y reactivar contactos dados de baja.' },
      { key: 'leads.manage_tags', label: 'Gestionar etiquetas', desc: 'Crear y eliminar las etiquetas de la empresa.' },
    ],
  },
  {
    key: 'messaging', label: 'Mensajería y campañas',
    permissions: [
      { key: 'messaging.view_broadcasts', label: 'Ver difusiones', desc: 'Entrar a Difusiones y ver el historial de campañas.' },
      { key: 'messaging.send_broadcasts', label: 'Enviar difusiones', desc: 'Crear, enviar y cancelar campañas masivas.' },
      { key: 'messaging.manage_templates', label: 'Gestionar plantillas', desc: 'Sincronizar plantillas con el proveedor y generarlas con IA.' },
      { key: 'messaging.manage_automations', label: 'Gestionar automatizaciones', desc: 'Crear y administrar automatizaciones de seguimiento.' },
    ],
  },
  {
    key: 'agenda', label: 'Agenda y prioridad',
    permissions: [
      { key: 'agenda.view_priority_queue', label: 'Ver cola de prioridad', desc: 'Usar la cola de prioridad: ver a quién atender primero y posponer.' },
      { key: 'agenda.manage', label: 'Gestionar agenda', desc: 'Gestionar la agenda de citas y conectar Google Calendar.' },
    ],
  },
  {
    key: 'analytics', label: 'Analítica',
    permissions: [
      { key: 'analytics.dashboard', label: 'Ver dashboard / analíticas', desc: 'Ver el dashboard de analítica (un vendedor solo ve sus propios datos).' },
      { key: 'analytics.ai_usage', label: 'Ver consumo de IA', desc: 'Ver el consumo y costo de IA (un vendedor solo ve el suyo).' },
    ],
  },
  {
    key: 'config', label: 'Configuración e integraciones',
    warn: 'Cambia la configuración de toda la empresa, no solo el trabajo del vendedor.',
    permissions: [
      { key: 'config.manage_channels', label: 'Gestionar canales', desc: 'Conectar, editar y eliminar canales, y asignarles vendedores.' },
      { key: 'config.migrate_channels', label: 'Migrar canales', desc: 'Migrar canales entre proveedores.' },
      { key: 'config.ai_settings', label: 'Configurar IA', desc: 'Configurar la integración de IA: clave de API y encendido por canal.' },
      { key: 'config.alerts', label: 'Gestionar alertas', desc: 'Configurar las alertas de leads sin responder.' },
      { key: 'config.products', label: 'Editar productos', desc: 'Crear, editar y eliminar productos del catálogo.' },
    ],
  },
  {
    key: 'users', label: 'Administración de usuarios',
    danger: 'Permite administrar vendedores y roles. Quien tiene «Gestionar roles» puede otorgarse cualquier otro permiso.',
    permissions: [
      { key: 'users.manage_users', label: 'Gestionar usuarios', desc: 'Administrar los vendedores de la empresa.' },
      { key: 'users.manage_roles', label: 'Gestionar roles', desc: 'Crear y editar roles, y asignárselos a los usuarios.' },
    ],
  },
];

const ALL_PERMISSION_KEYS = PERMISSION_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.key));
const ALL_PERMISSIONS_BY_KEY = Object.fromEntries(PERMISSION_CATEGORIES.flatMap((c) => c.permissions.map((p) => [p.key, p])));

const ROLE_TEMPLATES = {
  vendedor: {
    label: 'Vendedor',
    description: 'Trabaja sus leads, su agenda y ve sus propios resultados.',
    permissions: [
      'leads.view', 'leads.edit', 'leads.create_contacts', 'leads.manage_tags',
      'messaging.view_broadcasts', 'messaging.manage_automations',
      'agenda.view_priority_queue', 'agenda.manage',
      'analytics.dashboard', 'analytics.ai_usage',
    ],
  },
  supervisor: {
    label: 'Supervisor',
    description: 'Lo de Vendedor, más reparto de leads, campañas y automatizaciones.',
    permissions: [
      'leads.view', 'leads.edit', 'leads.assign', 'leads.create_contacts', 'leads.manage_tags',
      'messaging.view_broadcasts', 'messaging.send_broadcasts', 'messaging.manage_templates', 'messaging.manage_automations',
      'agenda.view_priority_queue', 'agenda.manage',
      'analytics.dashboard', 'analytics.ai_usage',
    ],
  },
  administrador: {
    label: 'Administrador',
    description: 'Control total, incluida la gestión de usuarios y roles.',
    warn: true,
    permissions: [...ALL_PERMISSION_KEYS],
  },
  blank: {
    label: 'Empezar en blanco',
    description: 'Elige los permisos uno por uno.',
    permissions: [],
  },
};

const AVAIL_ETAPA_META = {
  frio: 'Frío',
  por_depositar: 'Por depositar',
  venta: 'Venta',
  perdido: 'Perdido',
};

const AUTOMATION_TEMPLATES = {
  webinar: {
    label: 'Webinar — 14 días',
    description: 'Seguimiento de invitación a webinar: invitación, recordatorio con beneficio, caso de éxito y last call.',
    steps: [
      { day: 1, title: 'Invitación', hour: 10, message: 'Hola {{nombre}} 👋 Te invitamos a nuestro webinar gratuito. Cupos limitados, ¿te reservo un lugar?' },
      { day: 3, title: 'Recordatorio con beneficio', hour: 11, message: 'Hola {{nombre}}, quedan pocos cupos para el webinar. Los asistentes acceden a un beneficio exclusivo el mismo día 🎁 ¿Te apunto?' },
      { day: 5, title: 'Caso de éxito', hour: 10, message: '{{nombre}}, en el último webinar varios participantes concretaron su inversión en menos de un mes. Me encantaría que veas cómo lo lograron. ¿Te reservo el cupo?' },
      { day: 12, title: 'Last call', hour: 10, message: '{{nombre}}, último aviso: el webinar es muy pronto y estamos cerrando la lista. ¿Confirmo tu asistencia? ✅' },
    ],
  },
  promocion: {
    label: 'Promoción — 7 días',
    description: 'Seguimiento corto para promociones con fecha límite: anuncio, beneficio concreto y cierre por urgencia.',
    steps: [
      { day: 1, title: 'Anuncio de promoción', hour: 10, message: 'Hola {{nombre}} 👋 Lanzamos una promoción especial por tiempo limitado. ¿Te comparto los detalles?' },
      { day: 3, title: 'Beneficio concreto', hour: 11, message: '{{nombre}}, la promo incluye condiciones especiales de financiamiento que rara vez ofrecemos. ¿Conversamos hoy?' },
      { day: 6, title: 'Cierre por urgencia', hour: 10, message: '{{nombre}}, mañana termina la promoción. No quiero que la pierdas si estabas interesado/a. ¿Te llamo?' },
    ],
  },
  lanzamiento: {
    label: 'Lanzamiento — 10 días',
    description: 'Seguimiento para lanzamiento de proyecto/producto: expectativa, revelación, prueba social y última oportunidad.',
    steps: [
      { day: 1, title: 'Expectativa', hour: 10, message: 'Hola {{nombre}} 👋 Estamos por lanzar algo que creemos que te va a interesar mucho. ¿Quieres ser de los primeros en conocerlo?' },
      { day: 4, title: 'Revelación', hour: 11, message: '{{nombre}}, ¡ya está aquí! Te comparto la información del lanzamiento con condiciones preferenciales para los primeros interesados.' },
      { day: 7, title: 'Prueba social', hour: 10, message: '{{nombre}}, la acogida ha sido increíble: ya se reservó gran parte de la primera etapa. ¿Te separo una opción antes de que se agote?' },
      { day: 10, title: 'Última oportunidad', hour: 10, message: '{{nombre}}, cerramos la etapa de pre-venta esta semana. Es la última oportunidad con estas condiciones. ¿Coordinamos una llamada?' },
    ],
  },
};

const state = {
  section: 'canales-lista',
  vendors: [],
  agents: [],
  me: null, // sesión: { user, profile, organization, agent, isAdmin, isSuperAdmin, permissions }
  loginModeAttempt: null, // 'empresa' | 'vendedor' — pestaña con la que se intentó entrar
  profiles: [], // usuarios (profiles) visibles: los de mi empresa, o todos si soy super-admin
  organizations: [], // solo super-admin (sección Empresas)
  expandedOrgIds: new Set(),
  agentModalOrgId: null, // super-admin creando un usuario en otra empresa
  configTab: 'vendedores',
  roles: [],
  expandedRoleIds: new Set(),
  roleModalMode: 'create',
  editingRoleId: null,
  roleModalPermissions: new Set(),
  roleModalOpenCats: new Set(),
  roleModalTemplate: null,
  vendorId: null, // vendor seleccionado en la pestaña Prospectos
  configVendorId: null, // vendor que se está editando en el modal de Configuración
  assignVendorId: null, // vendor que se está editando en el modal de Asignar
  prospects: [],
  filter: 'TODOS',
  search: '',
  sortKey: 'score',
  sortDir: 'desc',
  activeProspectId: null,
  channel: null,
  threadChannel: null,

  // Dashboard
  dashTab: 'hoy',
  dashboardRows: [],

  // Bandeja Global / chats por asesor
  inboxRows: [],
  inboxVendorLock: null, // set = viendo los chats de UN asesor puntual (sidebar)
  inboxTab: 'todos',
  inboxSearch: '',
  inboxFilters: {
    canales: new Set(),
    etapas: new Set(),
    etiquetas: new Set(),
    vendedores: new Set(),
  },
  inboxDateMode: 'last_message_at',
  inboxDateRange: { start: null, end: null }, // rango aplicado
  calendarBase: new Date(new Date().getFullYear(), new Date().getMonth(), 1), // primer mes visible del picker
  calendarPick: { start: null, end: null }, // selección en curso, antes de "Aplicar"
  inboxSortByScore: false,
  inboxChannel: null,
  activeDrawerProspect: null,
};

const AVATAR_COLORS = ['#128c7e', '#e07a3f', '#3763d6', '#a24fc9', '#c9455a', '#0e9488', '#8a6d3b'];

Object.assign(state, {
  // Vista de chat de un canal (3 paneles, sidebar > vendor:<id>)
  channelVendorId: null,
  channelProspects: [],
  channelTab: 'chats',
  channelSearch: '',
  channelActiveProspectId: null,
  channelProspectsRealtime: null,
  channelThreadRealtime: null,
  ciTags: [], // etiquetas del prospecto abierto en el panel "Info del cliente" (edición en curso)
  ciCalif: { necesidad: null, inversion: null, urgencia: null, autoridad: null }, // puntos de la rúbrica de calificación (edición en curso)
  customFields: [], // definición global de campos personalizados (compartida en todos los canales/chats)
  ciCustomValues: {}, // valores del prospecto abierto: { [custom_field_id]: value } (edición en curso)

  products: [],
  productsSearch: '',

  catalogFiles: [],
  catalogSearch: '',
  catalogChannelFilter: '',
  catalogMultiSelect: false,
  catalogSelectedIds: new Set(),

  automations: [],
  automationTemplateKey: null,
  automationPending: null, // { name, template, ignore_exit_on_conversion, steps } — entre el editor y el paso de audiencia

  availTab: 'tiempo-real',
  availRangeDays: 7,
  availColaRows: [],
  availAssigningProspectId: null,
  availSettings: null, // fila singleton de availability_settings
  availAlertPhones: [], // edición en curso (antes de "Guardar configuración")
  availAlertEtapas: [],

  // Composer: grabación de nota de voz
  mediaRecorder: null,
  recordingChunks: [],
});

// ── DOM refs ─────────────────────────────────────────────────────────────────

const sidenavEl = document.getElementById('sidenav');
const sidenavVendorsEl = document.getElementById('sidenav-vendors');
const topbarTitle = document.getElementById('topbar-title');

const viewDashboard = document.getElementById('view-dashboard');
const dashKpiLeads = document.getElementById('dash-kpi-leads');
const dashKpiVentas = document.getElementById('dash-kpi-ventas');
const dashKpiDepositar = document.getElementById('dash-kpi-depositar');
const dashKpiConversion = document.getElementById('dash-kpi-conversion');
const dashTabsEl = document.getElementById('dash-tabs');
const dashPanelEl = document.getElementById('dash-panel');

const viewCanales = document.getElementById('view-canales');
const viewLeads = document.getElementById('view-leads');
const viewInbox = document.getElementById('view-inbox');
const viewChannel = document.getElementById('view-channel');
const channelContactsEl = document.getElementById('channel-contacts');
const channelSearchInput = document.getElementById('channel-search');
const channelThreadEmptyEl = document.getElementById('channel-thread-empty');
const channelThreadEl = document.getElementById('channel-thread');
const channelThreadBodyEl = document.getElementById('channel-thread-body');
const ctAvatar = document.getElementById('ct-avatar');
const ctName = document.getElementById('ct-name');
const ctPhone = document.getElementById('ct-phone');
const ctPerfilTrigger = document.getElementById('ct-perfil-trigger');
const ctPerfilDot = document.getElementById('ct-perfil-dot');
const ctPerfilLabel = document.getElementById('ct-perfil-label');
const ctPerfilPanel = document.getElementById('ct-perfil-panel');
const ctEtapaTrigger = document.getElementById('ct-etapa-trigger');
const ctEtapaIcon = document.getElementById('ct-etapa-icon');
const ctEtapaLabel = document.getElementById('ct-etapa-label');
const ctEtapaPanel = document.getElementById('ct-etapa-panel');
const ctIaToggle = document.getElementById('ct-ia-toggle');

const PERFIL_OPTIONS = [
  { value: 'nuevo', label: 'Nuevo', color: '#6b7280' },
  { value: 'inversionista', label: 'Inversionista', color: '#e0a83f' },
  { value: 'desarrollador', label: 'Desarrollador', color: '#1a9c5b' },
  { value: 'agente', label: 'Agente', color: '#d1352a' },
  { value: 'familia', label: 'familia', color: '#3763d6' },
];

const ETAPA_OPTIONS = [
  { value: '', label: 'Sin etapa', icon: '—', color: '#6b7280' },
  { value: 'frio', label: 'Frío', icon: '🌡️', color: '#3763d6' },
  { value: 'tibio', label: 'Tibio', icon: '🌡️', color: '#e0a83f' },
  { value: 'caliente', label: 'Caliente', icon: '🌡️', color: '#d1352a' },
  { value: 'por_depositar', label: 'Por depositar', icon: '📦', color: '#e0a83f' },
  { value: 'venta', label: 'Venta', icon: '🛒', color: '#3763d6' },
  { value: 'lead_perdido', label: 'Lead perdido', icon: '🏷️', color: '#6b7280' },
];
const channelComposer = document.getElementById('channel-composer');
const channelComposerInput = document.getElementById('channel-composer-input');
const composerStatus = document.getElementById('composer-status');
const composerEmojiBtn = document.getElementById('composer-emoji-btn');
const composerEmojiPanel = document.getElementById('composer-emoji-panel');
const composerEmojiSearch = document.getElementById('composer-emoji-search');
const composerEmojiGrid = document.getElementById('composer-emoji-grid');
const composerAttachBtn = document.getElementById('composer-attach-btn');
const composerAttachPanel = document.getElementById('composer-attach-panel');
const composerFileInput = document.getElementById('composer-file-input');
const composerMicBtn = document.getElementById('composer-mic-btn');
const channelInfoPane = document.getElementById('channel-info-pane');
const channelInfoForm = document.getElementById('channel-info-form');
const ciEstadoPill = document.getElementById('ci-estado-pill');
const ciTempLabel = document.getElementById('ci-temp-label');
const ciTempScore = document.getElementById('ci-temp-score');
const ciTempFill = document.getElementById('ci-temp-fill');
const ciAgent = document.getElementById('ci-agent');
const ciTagsList = document.getElementById('ci-tags-list');
const ciTagInput = document.getElementById('ci-tag-input');
const ciTagsAddBtn = document.getElementById('ci-tags-add');
const ciZona = document.getElementById('ci-zona');
const ciPresupuesto = document.getElementById('ci-presupuesto');
const ciNotas = document.getElementById('ci-notas');
const ciStatus = document.getElementById('ci-status');
const ciCustomFieldsList = document.getElementById('ci-customfields-list');
const ciCustomFieldAddBtn = document.getElementById('ci-customfield-add-btn');

const customfieldOverlay = document.getElementById('customfield-overlay');
const customfieldForm = document.getElementById('customfield-form');
const customfieldStatus = document.getElementById('customfield-status');
const cfTypeTrigger = document.getElementById('cf-type-trigger');
const cfTypeTriggerIcon = document.getElementById('cf-type-trigger-icon');
const cfTypeTriggerLabel = document.getElementById('cf-type-trigger-label');
const cfTypePanel = document.getElementById('cf-type-panel');
const cfTypeValue = document.getElementById('cf-type-value');
const cfOptionsGroup = document.getElementById('cf-options-group');

const viewPlaceholder = document.getElementById('view-placeholder');
const placeholderIcon = document.getElementById('placeholder-icon');
const placeholderTitle = document.getElementById('placeholder-title');
const placeholderText = document.getElementById('placeholder-text');

const vendorCardsEl = document.getElementById('vendor-cards');

const viewProductos = document.getElementById('view-productos');
const productsSearchInput = document.getElementById('products-search');
const productsListEl = document.getElementById('products-list');
const productsNewBtn = document.getElementById('products-new-btn');
const productsAutofillBtn = document.getElementById('products-autofill-btn');

const productOverlay = document.getElementById('product-overlay');
const productForm = document.getElementById('product-form');
const productStatus = document.getElementById('product-status');

const autofillOverlay = document.getElementById('autofill-overlay');
const autofillForm = document.getElementById('autofill-form');
const autofillStatus = document.getElementById('autofill-status');

const viewCatalogo = document.getElementById('view-catalogo');
const catalogChannelFilterSelect = document.getElementById('catalog-channel-filter');
const catalogAnalyzeBtn = document.getElementById('catalog-analyze-btn');
const catalogMultiToggle = document.getElementById('catalog-multi-toggle');
const catalogSearchInput = document.getElementById('catalog-search');
const catalogBulkBar = document.getElementById('catalog-bulk-bar');
const catalogBulkCount = document.getElementById('catalog-bulk-count');
const catalogBulkDeleteBtn = document.getElementById('catalog-bulk-delete-btn');
const catalogListEl = document.getElementById('catalog-list');
const catalogNewBtn = document.getElementById('catalog-new-btn');

const catalogOverlay = document.getElementById('catalog-overlay');
const catalogForm = document.getElementById('catalog-form');
const catalogStatus = document.getElementById('catalog-status');
const catalogVendorChecklist = document.getElementById('catalog-vendor-checklist');

const catalogAnalyzeOverlay = document.getElementById('catalog-analyze-overlay');
const catalogAnalyzeForm = document.getElementById('catalog-analyze-form');
const catalogAnalyzeStatus = document.getElementById('catalog-analyze-status');
const catalogAnalyzeVendorSelect = document.getElementById('catalog-analyze-vendor');

const viewAutomatizacion = document.getElementById('view-automatizacion');
const automationsListEl = document.getElementById('automations-list');
const automationNewBtn = document.getElementById('automation-new-btn');

const automationTemplateOverlay = document.getElementById('automation-template-overlay');
const automationTemplateListEl = document.getElementById('automation-template-list');
const automationScratchBtn = document.getElementById('automation-scratch-btn');

const automationEditorOverlay = document.getElementById('automation-editor-overlay');
const automationEditorForm = document.getElementById('automation-editor-form');
const automationEditorStatus = document.getElementById('automation-editor-status');
const automationNameInput = document.getElementById('automation-name-input');
const automationStepsListEl = document.getElementById('automation-steps-list');
const automationIgnoreExitInput = document.getElementById('automation-ignore-exit');
const automationAddStepBtn = document.getElementById('automation-add-step-btn');
const automationBackBtn = document.getElementById('automation-back-btn');

const automationAudienceOverlay = document.getElementById('automation-audience-overlay');
const audienceTempChipsEl = document.getElementById('audience-temp-chips');
const audienceEtapaChipsEl = document.getElementById('audience-etapa-chips');
const audienceScoreMinInput = document.getElementById('audience-score-min');
const audienceScoreMaxInput = document.getElementById('audience-score-max');
const audiencePreviewBtn = document.getElementById('audience-preview-btn');
const audiencePreviewResult = document.getElementById('audience-preview-result');
const automationAudienceStatus = document.getElementById('automation-audience-status');
const automationSaveDraftBtn = document.getElementById('automation-save-draft-btn');
const automationActivateBtn = document.getElementById('automation-activate-btn');

const viewDisponibilidad = document.getElementById('view-disponibilidad');
const viewConfiguracion = document.getElementById('view-configuracion');
const configVendorsTbody = document.getElementById('config-vendors-tbody');
const configTabsEl = document.getElementById('config-tabs');
const configPanels = {
  vendedores: document.getElementById('config-panel-vendedores'),
  roles: document.getElementById('config-panel-roles'),
};
const rolesTbody = document.getElementById('roles-tbody');
const roleOverlay = document.getElementById('role-overlay');
const roleForm = document.getElementById('role-form');
const roleModalTitle = document.getElementById('role-modal-title');
const roleModalSubtitle = document.getElementById('role-modal-subtitle');
const roleTemplatePicker = document.getElementById('role-template-picker');
const roleNameInput = document.getElementById('role-name-input');
const rolePermissionsList = document.getElementById('role-permissions-list');
const rolePermissionsCount = document.getElementById('role-permissions-count');
const roleSubmitBtn = document.getElementById('role-submit-btn');
const roleStatus = document.getElementById('role-status');
const availQueueBadge = document.getElementById('avail-queue-badge');
const availQueueCount = document.getElementById('avail-queue-count');
const availQueueWord = document.getElementById('avail-queue-word');
const availTabsEl = document.getElementById('avail-tabs');
const availTabColaBadge = document.getElementById('avail-tab-cola-badge');
const availPanels = {
  'tiempo-real': document.getElementById('avail-panel-tiempo-real'),
  kpis: document.getElementById('avail-panel-kpis'),
  cola: document.getElementById('avail-panel-cola'),
  config: document.getElementById('avail-panel-config'),
};

const availStatusKpisEl = document.getElementById('avail-status-kpis');
const availAgentCardsEl = document.getElementById('avail-agent-cards');

const availRangeTrigger = document.getElementById('avail-range-trigger');
const availRangePanel = document.getElementById('avail-range-panel');
const availRangeLabel = document.getElementById('avail-range-label');
const availAgentCountEl = document.getElementById('avail-agent-count');
const availKpiGridEl = document.getElementById('avail-kpi-grid');
const availDetailTbody = document.getElementById('avail-detail-tbody');

const availColaBanner = document.getElementById('avail-cola-banner');
const availColaListEl = document.getElementById('avail-cola-list');

const availSmartToggle = document.getElementById('avail-smart-toggle');
const availPriorityTbody = document.getElementById('avail-priority-tbody');
const availAlertPill = document.getElementById('avail-alert-pill');
const availAlertToggle = document.getElementById('avail-alert-toggle');
const availAlertHint = document.getElementById('avail-alert-hint');
const availPhoneInput = document.getElementById('avail-phone-input');
const availPhoneAddBtn = document.getElementById('avail-phone-add-btn');
const availPhoneListEl = document.getElementById('avail-phone-list');
const availEtapasTrigger = document.getElementById('avail-etapas-trigger');
const availEtapasPanel = document.getElementById('avail-etapas-panel');
const availEtapasListEl = document.getElementById('avail-etapas-list');
const availMinutesChipsEl = document.getElementById('avail-minutes-chips');
const availMinutesInput = document.getElementById('avail-minutes-input');
const availPreviewEtapa = document.getElementById('avail-preview-etapa');
const availPreviewTimeout = document.getElementById('avail-preview-timeout');
const availPreviewTimeoutNote = document.getElementById('avail-preview-timeout-note');
const availConfigStatus = document.getElementById('avail-config-status');
const availConfigSaveBtn = document.getElementById('avail-config-save-btn');

const availAssignOverlay = document.getElementById('avail-assign-overlay');
const availAssignLeadName = document.getElementById('avail-assign-lead-name');
const availAssignSelect = document.getElementById('avail-assign-select');
const availAssignStatus = document.getElementById('avail-assign-status');
const availAssignConfirmBtn = document.getElementById('avail-assign-confirm-btn');

const inboxSearchInput = document.getElementById('inbox-search');
const inboxCanalesTrigger = document.querySelector('.filter-trigger[data-filter="canales"]');
const inboxFechasTrigger = document.getElementById('fp-fechas-trigger');
const inboxFechasCalendarsEl = document.getElementById('fp-fechas-calendars');
const inboxEtiquetasSearchInput = document.getElementById('fp-etiquetas-search');
const inboxSortBtn = document.getElementById('inbox-sort-score');
const inboxListEl = document.getElementById('inbox-list');
const inboxCountTodos = document.getElementById('inbox-count-todos');
const inboxCountPrestados = document.getElementById('inbox-count-prestados');

const INBOX_UNASSIGNED = '__sin_asignar__';

const manageForm = document.getElementById('manage-form');
const manageStatus = document.getElementById('manage-status');

const vendorSelect = document.getElementById('vendor-select');
const tbody = document.getElementById('prospects-tbody');
const filtersEl = document.getElementById('filters');
const searchInput = document.getElementById('search');
const tableHead = document.querySelector('#prospects-table thead');

const drawerOverlay = document.getElementById('drawer-overlay');
const drawerName = document.getElementById('drawer-name');
const prospectFacts = document.getElementById('prospect-facts');
const messagesThread = document.getElementById('messages-thread');

const settingsOverlay = document.getElementById('settings-overlay');
const settingsTitle = document.getElementById('settings-title');
const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');

const vendorOverlay = document.getElementById('vendor-overlay');
const vendorForm = document.getElementById('vendor-form');
const vendorStatus = document.getElementById('vendor-status');
const vendorConnectionType = document.getElementById('vf-connection-type');
const vendorEvolutionFields = document.getElementById('vf-evolution-fields');
const vendorMetaFields = document.getElementById('vf-meta-fields');
const vendorConnectionHint = document.getElementById('vf-connection-hint');
const vendorSubmitBtn = document.getElementById('vendor-submit-btn');
const vendorEvolutionInstanceInput = document.getElementById('vf-evolution-instance-id');
const vendorMetaPhoneNumberIdInput = document.getElementById('vf-meta-phone-number-id');
const vendorMetaWabaIdInput = document.getElementById('vf-meta-waba-id');
const vendorMetaAccessTokenInput = document.getElementById('vf-meta-access-token');
const vendorFbConnect = document.getElementById('vf-fb-connect');
const vendorFbConnectBtn = document.getElementById('vf-fb-connect-btn');
const FB_CONNECT_ENABLED = Boolean(META_APP_ID && META_CONFIG_ID);

const VENDOR_CONNECTION_COPY = {
  evolution: {
    hint: 'Conecta con tu instancia de Evolution API (requiere Evolution self-hosted).',
    submitLabel: 'Crear canal',
  },
  meta: {
    hint: 'Conexión oficial vía WhatsApp Business Cloud API. Pega el token permanente que generaste desde tu Meta Business dashboard.',
    submitLabel: 'Conectar con Meta',
  },
};

function updateVendorFormConnectionType() {
  const type = vendorConnectionType.value;
  const isMeta = type === 'meta';

  vendorEvolutionFields.hidden = isMeta;
  vendorMetaFields.hidden = !isMeta;
  vendorFbConnect.hidden = !(isMeta && FB_CONNECT_ENABLED);
  // El SDK se precarga para que FB.login corra dentro del clic (si no, el navegador bloquea el popup).
  if (isMeta && FB_CONNECT_ENABLED) loadFacebookSdk().catch(() => {});

  vendorEvolutionInstanceInput.required = !isMeta;
  vendorMetaPhoneNumberIdInput.required = isMeta;
  vendorMetaWabaIdInput.required = isMeta;
  vendorMetaAccessTokenInput.required = isMeta;

  const copy = VENDOR_CONNECTION_COPY[type] ?? VENDOR_CONNECTION_COPY.evolution;
  vendorConnectionHint.textContent = copy.hint;
  vendorSubmitBtn.textContent = copy.submitLabel;
}

const agentOverlay = document.getElementById('agent-overlay');
const agentForm = document.getElementById('agent-form');
const agentStatus = document.getElementById('agent-status');

const assignOverlay = document.getElementById('assign-overlay');
const assignForm = document.getElementById('assign-form');
const assignSelect = document.getElementById('assign-select');
const assignStatus = document.getElementById('assign-status');

// ── Formato ──────────────────────────────────────────────────────────────────

const fmtMoney = (n, currency) => {
  if (n === null || n === undefined) return '—';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN', maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${n.toLocaleString('es-MX')} ${currency || ''}`;
  }
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

const colorFor = (id) => {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};

// ── Navegación (sidebar) ──────────────────────────────────────────────────────

// Canales que el usuario puede abrir: admin → todos los de su empresa;
// vendedor → solo los que tiene asignados (los leads prestados le llegan por
// Bandeja Global).
function visibleVendors() {
  if (!state.me) return [];
  if (state.me.isAdmin) return state.vendors;
  const agentId = state.me.agent?.id;
  return agentId ? state.vendors.filter((v) => v.assigned_agent_id === agentId) : [];
}

function renderSidenavVendors() {
  sidenavVendorsEl.innerHTML = (can('leads.view') ? visibleVendors() : [])
    .map(
      (v) =>
        `<button class="sidenav-subitem" data-section="vendor:${v.id}" type="button" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</button>`
    )
    .join('');
  syncSidenavActive();
}

function syncSidenavActive() {
  const canalesParentActive = state.section === 'canales-lista' || state.section === 'bandeja-global' || state.section.startsWith('vendor:');
  sidenavEl.querySelectorAll('.sidenav-item, .sidenav-subitem').forEach((el) => {
    const isCanalesParent = el.classList.contains('is-parent');
    const matches = isCanalesParent ? canalesParentActive : el.dataset.section === state.section;
    el.classList.toggle('is-active', matches);
  });
}

// Permiso mínimo para entrar a cada sección (el servidor lo hace cumplir de
// todos modos vía RLS; esto solo evita mostrar pantallas vacías).
const SECTION_PERMS = {
  dashboard: ['analytics.dashboard'],
  'canales-lista': ['config.manage_channels'],
  leads: ['leads.view'],
  'bandeja-global': ['leads.view'],
  productos: ['config.products'],
  'catalogo-ia': ['config.products'],
  automatizacion: ['messaging.manage_automations'],
  configuracion: ['users.manage_users', 'users.manage_roles'],
};

function sectionAllowed(section) {
  if (section === 'empresas') return Boolean(state.me?.isSuperAdmin);
  if (section.startsWith('vendor:')) {
    const id = section.slice('vendor:'.length);
    return can('leads.view') && visibleVendors().some((v) => v.id === id);
  }
  const perms = SECTION_PERMS[section];
  return !perms || perms.some(can);
}

function defaultSection() {
  return ['canales-lista', 'bandeja-global', 'leads', 'dashboard', 'productos', 'automatizacion'].find(sectionAllowed) || 'disponibilidad';
}

async function setSection(section) {
  if (!sectionAllowed(section)) section = defaultSection();
  state.section = section;
  syncSidenavActive();

  const isCanales = section === 'canales-lista';
  const isLeads = section === 'leads';
  const isInbox = section === 'bandeja-global';
  const isChannel = section.startsWith('vendor:');
  const isDashboard = section === 'dashboard';
  const isProductos = section === 'productos';
  const isCatalogo = section === 'catalogo-ia';
  const isAutomatizacion = section === 'automatizacion';
  const isDisponibilidad = section === 'disponibilidad';
  const isConfiguracion = section === 'configuracion';
  const isEmpresas = section === 'empresas';
  const isPlaceholder =
    !isCanales &&
    !isLeads &&
    !isInbox &&
    !isChannel &&
    !isDashboard &&
    !isProductos &&
    !isCatalogo &&
    !isAutomatizacion &&
    !isDisponibilidad &&
    !isConfiguracion &&
    !isEmpresas;

  viewDashboard.hidden = !isDashboard;
  viewCanales.hidden = !isCanales;
  viewLeads.hidden = !isLeads;
  viewInbox.hidden = !isInbox;
  viewChannel.hidden = !isChannel;
  viewProductos.hidden = !isProductos;
  viewCatalogo.hidden = !isCatalogo;
  viewAutomatizacion.hidden = !isAutomatizacion;
  viewDisponibilidad.hidden = !isDisponibilidad;
  viewConfiguracion.hidden = !isConfiguracion;
  viewEmpresas.hidden = !isEmpresas;
  viewPlaceholder.hidden = !isPlaceholder;
  document.querySelector('[data-section-group="canales"]').hidden = !isCanales;
  document.querySelector('[data-section-group="leads"]').hidden = !isLeads;
  document.querySelector('[data-section-group="productos"]').hidden = !isProductos;
  document.querySelector('[data-section-group="catalogo-ia"]').hidden = !isCatalogo;

  if (isDashboard) {
    topbarTitle.textContent = 'Dashboard';
    await loadDashboard();
  } else if (isCanales) {
    topbarTitle.textContent = 'Canales';
  } else if (isLeads) {
    topbarTitle.textContent = 'Leads';
  } else if (isProductos) {
    topbarTitle.textContent = 'Productos';
    await loadProducts();
  } else if (isCatalogo) {
    topbarTitle.textContent = 'Catálogo IA';
    await loadCatalogFiles();
  } else if (isAutomatizacion) {
    topbarTitle.textContent = 'Automatización';
    await loadAutomations();
  } else if (isDisponibilidad) {
    topbarTitle.textContent = 'Disponibilidad';
    await loadAvailability();
  } else if (isConfiguracion) {
    topbarTitle.textContent = 'Configuración';
    setConfigTab(can('users.manage_users') ? state.configTab : 'roles');
    await Promise.all([loadRoles(), loadProfiles()]);
    renderConfigVendedores();
    renderRolesTable();
  } else if (isEmpresas) {
    topbarTitle.textContent = 'Empresas';
    await Promise.all([loadProfiles(), loadOrganizations()]);
  } else if (section === 'bandeja-global') {
    topbarTitle.textContent = 'Bandeja Global';
    state.inboxVendorLock = null;
    inboxCanalesTrigger.disabled = false;
    await loadInbox();
  } else if (isChannel) {
    const vendorId = section.slice('vendor:'.length);
    const v = state.vendors.find((x) => x.id === vendorId);
    topbarTitle.textContent = v ? v.name : 'Chats';
    await loadChannel(vendorId);
  } else {
    const [icon, title, text] = PLACEHOLDER_INFO[section] ?? ['🚧', 'Próximamente', 'Esta sección todavía no está construida.'];
    placeholderIcon.textContent = icon;
    placeholderTitle.textContent = title;
    placeholderText.textContent = text;
    topbarTitle.textContent = title;
  }
}

sidenavEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.sidenav-item, .sidenav-subitem');
  if (!btn || !btn.dataset.section) return;
  setSection(btn.dataset.section);
});

// ── Carga de datos ───────────────────────────────────────────────────────────

// Sin ai_api_key ni meta_access_token: el cliente no necesita los secretos
// (y el lockdown revoca su lectura). ai_key_set dice si hay clave.
const VENDOR_COLUMNS =
  'id, name, phone_number, channel_type, evolution_instance_id, meta_phone_number_id, meta_waba_id, meta_verified, ' +
  'ai_provider, ai_model, ai_key_set, system_prompt, assigned_agent_id, keywords, organization_id, created_at, updated_at';

async function loadVendors() {
  const { data, error } = await supabase.from('vendors').select(VENDOR_COLUMNS).order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando vendors:', error.message);
    return;
  }
  state.vendors = data ?? [];

  const mine = visibleVendors();
  vendorSelect.innerHTML = mine
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)} · ${v.channel_type}</option>`)
    .join('');
  if (state.vendorId && !mine.some((v) => v.id === state.vendorId)) state.vendorId = null;
  if (mine.length && !state.vendorId) {
    state.vendorId = mine[0].id;
  }
  if (state.vendorId) vendorSelect.value = state.vendorId;

  renderCanalesFilter();

  renderVendorCards();
  renderChannelLimit();
  renderSidenavVendors();
  renderCatalogVendorOptions();
}

function renderChannelLimit() {
  const label = document.getElementById('channel-limit-label');
  const btn = document.getElementById('create-vendor-btn');
  const max = state.me?.organization?.max_channels;
  if (max === undefined || max === null) {
    label.textContent = '';
    btn.disabled = false;
    return;
  }
  const used = state.vendors.length;
  label.textContent = `${used} de ${max} canales`;
  const full = used >= max;
  btn.disabled = full;
  btn.title = full ? 'Tu empresa alcanzó su límite de canales. Pide al administrador de la plataforma ampliarlo.' : '';
}

function friendlyDbError(message) {
  const limit = String(message ?? '').match(/LIMITE_CANALES:(\d+)/);
  if (limit) return `Tu empresa alcanzó el límite de ${limit[1]} canales de WhatsApp. Pide al administrador de la plataforma ampliarlo.`;
  return message;
}

async function loadAgents() {
  const { data, error } = await supabase.from('agents').select('*').order('name', { ascending: true });
  if (error) {
    console.error('Error cargando agents:', error.message);
    return;
  }
  state.agents = data ?? [];

  const agentOptions = state.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  document.getElementById('m-agent').innerHTML = '<option value="">Vendedor del canal</option>' + agentOptions;
  ciAgent.innerHTML = '<option value="">Vendedor del canal</option>' + agentOptions;
  renderVendedoresFilter();
  renderStatusPill();
}

// Usuarios con login. RLS: un admin ve los de su empresa; el super-admin, todos.
async function loadProfiles() {
  if (!state.me?.isSuperAdmin && !can('users.manage_users')) {
    state.profiles = [];
    return;
  }
  const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando profiles:', error.message);
    return;
  }
  state.profiles = data ?? [];
}

// Campos personalizados: definición global (compartida en todos los canales y
// chats); el valor de cada campo sí es por prospecto (custom_field_values).
async function loadCustomFields() {
  const { data, error } = await supabase.from('custom_fields').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando campos personalizados:', error.message);
    return;
  }
  state.customFields = data ?? [];
  renderCustomFields();
}

// Catálogo de productos: global, se gestiona desde la sección "Productos".
async function loadProducts() {
  productsListEl.innerHTML = '<p class="muted">Cargando productos…</p>';
  const { data, error } = await supabase.from('products').select('*').order('created_at', { ascending: false });
  if (error) {
    console.error('Error cargando productos:', error.message);
    productsListEl.innerHTML = `<p class="muted">Error al cargar productos: ${escapeHtml(error.message)}</p>`;
    return;
  }
  state.products = data ?? [];
  renderProductsList();
}

function renderProductsList() {
  const q = state.productsSearch.trim().toLowerCase();
  const rows = q
    ? state.products.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
    : state.products;

  if (!rows.length) {
    productsListEl.innerHTML = state.products.length
      ? `<div class="products-empty">
           <div class="products-empty-icon">📦</div>
           <h3>Sin resultados</h3>
           <p class="muted">No hay productos que coincidan con tu búsqueda.</p>
         </div>`
      : `<div class="products-empty">
           <div class="products-empty-icon">📦</div>
           <h3>Sin productos aún</h3>
           <p class="muted">Crea el primer producto para tu catálogo</p>
           <button type="button" class="btn btn-primary" id="products-empty-create-btn">＋ Crear producto</button>
         </div>`;
    if (!state.products.length) {
      document.getElementById('products-empty-create-btn')?.addEventListener('click', openProductModal);
    }
    return;
  }

  productsListEl.innerHTML = rows
    .map((p) => {
      const qty = p.quantity === null || p.quantity === undefined ? '' : `<span class="product-card-qty">Stock: ${p.quantity}</span>`;
      const desc = p.description ? `<p class="product-card-desc">${escapeHtml(p.description)}</p>` : '';
      return `
        <div class="product-card" data-id="${p.id}">
          <div class="product-card-top">
            <span class="product-card-name">${escapeHtml(p.name)}</span>
            <button type="button" class="btn-icon product-card-delete" data-delete-product="${p.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
          </div>
          <span class="product-card-price">${fmtMoney(p.price, p.currency)}</span>
          ${qty}
          ${desc}
        </div>`;
    })
    .join('');
}

productsSearchInput?.addEventListener('input', () => {
  state.productsSearch = productsSearchInput.value;
  renderProductsList();
});

productsListEl?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-delete-product]');
  if (!btn) return;
  const id = btn.dataset.deleteProduct;
  if (!confirm('¿Eliminar este producto del catálogo?')) return;
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) {
    alert(`Error al eliminar: ${error.message}`);
    return;
  }
  state.products = state.products.filter((p) => p.id !== id);
  renderProductsList();
});

function openProductModal() {
  productForm.reset();
  productStatus.textContent = '';
  productStatus.className = 'settings-status';
  productOverlay.hidden = false;
}
function closeProductModal() {
  productOverlay.hidden = true;
}
productsNewBtn?.addEventListener('click', openProductModal);
document.getElementById('product-modal-close')?.addEventListener('click', closeProductModal);
document.getElementById('product-cancel-btn')?.addEventListener('click', closeProductModal);
productOverlay?.addEventListener('click', (ev) => {
  if (ev.target === productOverlay) closeProductModal();
});

async function createProduct(ev) {
  ev.preventDefault();
  const fd = new FormData(productForm);
  const name = String(fd.get('name') || '').trim();
  if (!name) {
    productStatus.textContent = 'El nombre del producto es obligatorio.';
    productStatus.className = 'settings-status err';
    return;
  }
  const priceRaw = fd.get('price');
  const quantityRaw = fd.get('quantity');

  productStatus.textContent = 'Creando…';
  productStatus.className = 'settings-status';

  const { error } = await supabase.from('products').insert({
    name,
    price: priceRaw === '' || priceRaw === null ? 0 : Number(priceRaw),
    currency: fd.get('currency') || 'PEN',
    quantity: quantityRaw === '' || quantityRaw === null ? null : Number(quantityRaw),
    description: String(fd.get('description') || '').trim() || null,
  });

  if (error) {
    productStatus.textContent = `Error: ${error.message}`;
    productStatus.className = 'settings-status err';
    return;
  }

  productStatus.textContent = 'Producto creado ✓';
  productStatus.className = 'settings-status ok';
  productForm.reset();
  await loadProducts();
  setTimeout(closeProductModal, 500);
}
productForm?.addEventListener('submit', createProduct);

function openAutofillModal() {
  autofillForm.reset();
  autofillStatus.textContent = '';
  autofillStatus.className = 'settings-status';
  autofillOverlay.hidden = false;
}
function closeAutofillModal() {
  autofillOverlay.hidden = true;
}
productsAutofillBtn?.addEventListener('click', openAutofillModal);
document.getElementById('autofill-modal-close')?.addEventListener('click', closeAutofillModal);
document.getElementById('autofill-cancel-btn')?.addEventListener('click', closeAutofillModal);
autofillOverlay?.addEventListener('click', (ev) => {
  if (ev.target === autofillOverlay) closeAutofillModal();
});

async function generateProductCatalog(ev) {
  ev.preventDefault();
  const fd = new FormData(autofillForm);
  const description = String(fd.get('description') || '').trim();
  if (!description) {
    autofillStatus.textContent = 'Cuéntanos qué vende tu negocio.';
    autofillStatus.className = 'settings-status err';
    return;
  }
  const count = Number(fd.get('count')) || 6;

  autofillStatus.textContent = 'Generando catálogo con IA…';
  autofillStatus.className = 'settings-status';

  try {
    const resp = await fetch(`${FUNCTIONS_URL}/product-autocomplete`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ description, count }),
    });
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);

    const { error } = await supabase.from('products').insert(json.products);
    if (error) throw new Error(error.message);

    autofillStatus.textContent = `${json.products.length} productos generados ✓`;
    autofillStatus.className = 'settings-status ok';
    await loadProducts();
    setTimeout(closeAutofillModal, 700);
  } catch (err) {
    autofillStatus.textContent = `Error: ${err.message}`;
    autofillStatus.className = 'settings-status err';
  }
}
autofillForm?.addEventListener('submit', generateProductCatalog);

// ── Catálogo IA ──────────────────────────────────────────────────────────────
// Archivos (productos/propiedades/servicios) que la IA puede mencionar/enviar
// en chat. Cada archivo se asigna a uno o más canales (vendors.id[]).

function vendorName(id) {
  return state.vendors.find((v) => v.id === id)?.name ?? '—';
}

function renderCatalogVendorOptions() {
  const options = state.vendors.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
  catalogChannelFilterSelect.innerHTML = '<option value="">Todos los canales</option>' + options;
  catalogAnalyzeVendorSelect.innerHTML = '<option value="">Selecciona un canal…</option>' + options;

  catalogVendorChecklist.innerHTML = state.vendors.length
    ? state.vendors
        .map(
          (v) => `
        <label class="filter-option">
          <input type="checkbox" name="vendor_ids" value="${v.id}" />
          ${escapeHtml(v.name)}
        </label>`
        )
        .join('')
    : '<p class="muted filter-panel-empty">No hay canales creados todavía.</p>';
}

async function loadCatalogFiles() {
  catalogListEl.innerHTML = '<p class="muted">Cargando catálogo…</p>';
  const { data, error } = await supabase.from('catalog_files').select('*').order('created_at', { ascending: false });
  if (error) {
    console.error('Error cargando catálogo IA:', error.message);
    catalogListEl.innerHTML = `<p class="muted">Error al cargar el catálogo: ${escapeHtml(error.message)}</p>`;
    return;
  }
  state.catalogFiles = data ?? [];
  renderCatalogList();
}

function renderCatalogBulkBar() {
  const count = state.catalogSelectedIds.size;
  catalogBulkBar.hidden = !state.catalogMultiSelect || count === 0;
  catalogBulkCount.textContent = `${count} seleccionado${count === 1 ? '' : 's'}`;
}

function renderCatalogList() {
  const q = state.catalogSearch.trim().toLowerCase();
  const channel = state.catalogChannelFilter;

  const rows = state.catalogFiles.filter((f) => {
    if (channel && !(f.vendor_ids ?? []).includes(channel)) return false;
    if (q && !f.name.toLowerCase().includes(q)) return false;
    return true;
  });

  if (!rows.length) {
    catalogListEl.innerHTML = state.catalogFiles.length
      ? `<div class="products-empty">
           <div class="products-empty-icon">📖</div>
           <h3>Sin resultados</h3>
           <p class="muted">No hay archivos que coincidan con tu búsqueda o filtro.</p>
         </div>`
      : `<div class="products-empty">
           <div class="products-empty-icon">📖</div>
           <h3>Catálogo vacío</h3>
           <p class="muted">Crea un archivo a mano o usa "Analizar prompt" para detectarlos automáticamente.</p>
           <button type="button" class="btn btn-ghost" id="catalog-empty-create-btn">＋ Crear archivo</button>
         </div>`;
    if (!state.catalogFiles.length) {
      document.getElementById('catalog-empty-create-btn')?.addEventListener('click', openCatalogModal);
    }
    renderCatalogBulkBar();
    return;
  }

  catalogListEl.innerHTML = rows
    .map((f) => {
      const tags = (f.vendor_ids ?? []).map((id) => `<span class="catalog-card-tag">${escapeHtml(vendorName(id))}</span>`).join('');
      const checkbox = state.catalogMultiSelect
        ? `<input type="checkbox" class="catalog-card-check" data-select-catalog="${f.id}" ${state.catalogSelectedIds.has(f.id) ? 'checked' : ''} />`
        : '';
      return `
        <div class="product-card catalog-card" data-id="${f.id}">
          <div class="catalog-card-top">
            <div style="display:flex; align-items:flex-start; gap:8px;">
              ${checkbox}
              <span class="product-card-name">${escapeHtml(f.name)}</span>
            </div>
            <button type="button" class="btn-icon product-card-delete" data-delete-catalog="${f.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
          </div>
          ${tags ? `<div class="catalog-card-tags">${tags}</div>` : '<p class="muted" style="margin:0;">Sin canales asignados</p>'}
        </div>`;
    })
    .join('');
  renderCatalogBulkBar();
}

catalogSearchInput?.addEventListener('input', () => {
  state.catalogSearch = catalogSearchInput.value;
  renderCatalogList();
});
catalogChannelFilterSelect?.addEventListener('change', () => {
  state.catalogChannelFilter = catalogChannelFilterSelect.value;
  renderCatalogList();
});
catalogMultiToggle?.addEventListener('change', () => {
  state.catalogMultiSelect = catalogMultiToggle.checked;
  state.catalogSelectedIds.clear();
  renderCatalogList();
});

catalogListEl?.addEventListener('click', async (ev) => {
  const delBtn = ev.target.closest('[data-delete-catalog]');
  if (delBtn) {
    const id = delBtn.dataset.deleteCatalog;
    if (!confirm('¿Eliminar este archivo del catálogo?')) return;
    const { error } = await supabase.from('catalog_files').delete().eq('id', id);
    if (error) {
      alert(`Error al eliminar: ${error.message}`);
      return;
    }
    state.catalogFiles = state.catalogFiles.filter((f) => f.id !== id);
    state.catalogSelectedIds.delete(id);
    renderCatalogList();
    return;
  }
});
catalogListEl?.addEventListener('change', (ev) => {
  const checkbox = ev.target.closest('[data-select-catalog]');
  if (!checkbox) return;
  const id = checkbox.dataset.selectCatalog;
  if (checkbox.checked) state.catalogSelectedIds.add(id);
  else state.catalogSelectedIds.delete(id);
  renderCatalogBulkBar();
});

catalogBulkDeleteBtn?.addEventListener('click', async () => {
  const ids = Array.from(state.catalogSelectedIds);
  if (!ids.length) return;
  if (!confirm(`¿Eliminar ${ids.length} archivo(s) del catálogo?`)) return;
  const { error } = await supabase.from('catalog_files').delete().in('id', ids);
  if (error) {
    alert(`Error al eliminar: ${error.message}`);
    return;
  }
  state.catalogFiles = state.catalogFiles.filter((f) => !ids.includes(f.id));
  state.catalogSelectedIds.clear();
  renderCatalogList();
});

function openCatalogModal() {
  catalogForm.reset();
  catalogStatus.textContent = '';
  catalogStatus.className = 'settings-status';
  catalogOverlay.hidden = false;
}
function closeCatalogModal() {
  catalogOverlay.hidden = true;
}
catalogNewBtn?.addEventListener('click', openCatalogModal);
document.getElementById('catalog-modal-close')?.addEventListener('click', closeCatalogModal);
document.getElementById('catalog-cancel-btn')?.addEventListener('click', closeCatalogModal);
catalogOverlay?.addEventListener('click', (ev) => {
  if (ev.target === catalogOverlay) closeCatalogModal();
});

async function createCatalogFile(ev) {
  ev.preventDefault();
  const fd = new FormData(catalogForm);
  const name = String(fd.get('name') || '').trim();
  if (!name) {
    catalogStatus.textContent = 'El nombre es obligatorio.';
    catalogStatus.className = 'settings-status err';
    return;
  }
  const vendorIds = fd.getAll('vendor_ids');

  catalogStatus.textContent = 'Creando…';
  catalogStatus.className = 'settings-status';

  const { error } = await supabase.from('catalog_files').insert({ name, vendor_ids: vendorIds });

  if (error) {
    catalogStatus.textContent = `Error: ${error.message}`;
    catalogStatus.className = 'settings-status err';
    return;
  }

  catalogStatus.textContent = 'Archivo creado ✓';
  catalogStatus.className = 'settings-status ok';
  catalogForm.reset();
  await loadCatalogFiles();
  setTimeout(closeCatalogModal, 500);
}
catalogForm?.addEventListener('submit', createCatalogFile);

function openCatalogAnalyzeModal() {
  catalogAnalyzeForm.reset();
  catalogAnalyzeStatus.textContent = '';
  catalogAnalyzeStatus.className = 'settings-status';
  catalogAnalyzeOverlay.hidden = false;
}
function closeCatalogAnalyzeModal() {
  catalogAnalyzeOverlay.hidden = true;
}
catalogAnalyzeBtn?.addEventListener('click', openCatalogAnalyzeModal);
document.getElementById('catalog-analyze-modal-close')?.addEventListener('click', closeCatalogAnalyzeModal);
document.getElementById('catalog-analyze-cancel-btn')?.addEventListener('click', closeCatalogAnalyzeModal);
catalogAnalyzeOverlay?.addEventListener('click', (ev) => {
  if (ev.target === catalogAnalyzeOverlay) closeCatalogAnalyzeModal();
});

async function analyzeCatalogPrompt(ev) {
  ev.preventDefault();
  const vendorId = catalogAnalyzeVendorSelect.value;
  if (!vendorId) {
    catalogAnalyzeStatus.textContent = 'Selecciona un canal.';
    catalogAnalyzeStatus.className = 'settings-status err';
    return;
  }
  const vendor = state.vendors.find((v) => v.id === vendorId);
  const prompt = (vendor?.system_prompt || '').trim();
  if (!prompt) {
    catalogAnalyzeStatus.textContent = 'Este canal no tiene un prompt configurado todavía.';
    catalogAnalyzeStatus.className = 'settings-status err';
    return;
  }

  catalogAnalyzeStatus.textContent = 'Analizando prompt con IA…';
  catalogAnalyzeStatus.className = 'settings-status';

  try {
    const resp = await fetch(`${FUNCTIONS_URL}/catalog-analyze-prompt`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ prompt }),
    });
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);

    if (!json.items.length) {
      catalogAnalyzeStatus.textContent = 'No se detectaron productos o propiedades en este prompt.';
      catalogAnalyzeStatus.className = 'settings-status err';
      return;
    }

    const rows = json.items.map((it) => ({ name: it.name, vendor_ids: [vendorId] }));
    const { error } = await supabase.from('catalog_files').insert(rows);
    if (error) throw new Error(error.message);

    catalogAnalyzeStatus.textContent = `${rows.length} archivo(s) detectado(s) ✓`;
    catalogAnalyzeStatus.className = 'settings-status ok';
    await loadCatalogFiles();
    setTimeout(closeCatalogAnalyzeModal, 700);
  } catch (err) {
    catalogAnalyzeStatus.textContent = `Error: ${err.message}`;
    catalogAnalyzeStatus.className = 'settings-status err';
  }
}
catalogAnalyzeForm?.addEventListener('submit', analyzeCatalogPrompt);

// ── Motor de Automatizaciones ────────────────────────────────────────────────
// Por ahora solo se guarda la DEFINICIÓN (plantilla + pasos) como borrador.
// El motor que inscribe leads y envía los mensajes programados es una fase
// futura (todavía no decidimos cómo se inscriben los leads ni qué canal envía).

async function loadAutomations() {
  automationsListEl.innerHTML = '<p class="muted">Cargando automatizaciones…</p>';
  const { data, error } = await supabase.from('automations').select('*').order('created_at', { ascending: false });
  if (error) {
    console.error('Error cargando automatizaciones:', error.message);
    automationsListEl.innerHTML = `<p class="muted">Error al cargar: ${escapeHtml(error.message)}</p>`;
    return;
  }
  state.automations = data ?? [];
  renderAutomationsList();
}

function renderAutomationsList() {
  if (!state.automations.length) {
    automationsListEl.innerHTML = `
      <div class="products-empty">
        <div class="products-empty-icon">🚀</div>
        <p style="margin:0;">Crea tu primera automatización: di "webinar el domingo" y la IA te propone el plan.</p>
      </div>`;
    return;
  }

  const TEMP_LABELS = { CALIFICADO: 'Calientes', TIBIO: 'Tibios', FRIO: 'Fríos' };
  const ETAPA_LABELS = { por_depositar: 'Por depositar', venta: 'Venta', perdido: 'Perdido' };

  automationsListEl.innerHTML = state.automations
    .map((a) => {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const temps = (a.audience_temperaturas ?? []).map((t) => TEMP_LABELS[t] ?? t);
      const etapas = (a.audience_etapas ?? []).map((e) => ETAPA_LABELS[e] ?? e);
      const audienceBits = [...temps, ...etapas];
      const audienceLine = audienceBits.length ? `<p class="automation-card-steps">👥 ${audienceBits.join(', ')}</p>` : '';
      return `
        <div class="product-card" data-id="${a.id}">
          <div class="automation-card-top">
            <span class="product-card-name">${escapeHtml(a.name)}</span>
            <button type="button" class="btn-icon product-card-delete" data-delete-automation="${a.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
          </div>
          <span class="automation-card-badge${a.status === 'activa' ? ' is-active' : ''}">${escapeHtml(a.status || 'borrador')}</span>
          <p class="automation-card-steps">${steps.length} paso${steps.length === 1 ? '' : 's'}${a.ignore_exit_on_conversion ? ' · ignora salida por conversión' : ''}</p>
          ${audienceLine}
        </div>`;
    })
    .join('');
}

automationsListEl?.addEventListener('click', async (ev) => {
  const delBtn = ev.target.closest('[data-delete-automation]');
  if (!delBtn) return;
  const id = delBtn.dataset.deleteAutomation;
  if (!confirm('¿Eliminar esta automatización?')) return;
  const { error } = await supabase.from('automations').delete().eq('id', id);
  if (error) {
    alert(`Error al eliminar: ${error.message}`);
    return;
  }
  state.automations = state.automations.filter((a) => a.id !== id);
  renderAutomationsList();
});

// Paso 1: elegir plantilla ------------------------------------------------

function openAutomationTemplatePicker() {
  automationTemplateListEl.innerHTML = Object.entries(AUTOMATION_TEMPLATES)
    .map(
      ([key, t]) => `
      <button type="button" class="automation-template-option" data-template-key="${key}">
        <span class="automation-template-option-text">
          <span class="automation-template-option-title">${escapeHtml(t.label)}</span>
          <span class="automation-template-option-desc">${escapeHtml(t.description)}</span>
        </span>
        <span class="automation-template-option-chevron">›</span>
      </button>`
    )
    .join('');
  automationTemplateOverlay.hidden = false;
}
function closeAutomationTemplatePicker() {
  automationTemplateOverlay.hidden = true;
}
automationNewBtn?.addEventListener('click', openAutomationTemplatePicker);
document.getElementById('automation-template-modal-close')?.addEventListener('click', closeAutomationTemplatePicker);
automationTemplateOverlay?.addEventListener('click', (ev) => {
  if (ev.target === automationTemplateOverlay) closeAutomationTemplatePicker();
});

automationTemplateListEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-template-key]');
  if (!btn) return;
  closeAutomationTemplatePicker();
  openAutomationEditor(btn.dataset.templateKey);
});
automationScratchBtn?.addEventListener('click', () => {
  closeAutomationTemplatePicker();
  openAutomationEditor(null);
});

// Paso 2: ajustar el plan día a día ---------------------------------------

function automationStepRowHtml(step) {
  const { day = 1, title = '', hour = 10, message = '' } = step;
  return `
    <div class="automation-step">
      <div class="automation-step-top">
        <label class="automation-step-day">
          Día
          <input type="number" min="1" class="as-day" value="${day}" />
        </label>
        <input type="text" class="automation-step-title" placeholder="Título del paso" value="${escapeHtml(title)}" />
        <label class="automation-step-hour">
          🕐 <input type="number" min="0" max="23" class="as-hour" value="${hour}" /> h
        </label>
        <button type="button" class="btn-icon automation-step-remove" aria-label="Eliminar paso">✕</button>
      </div>
      <textarea class="automation-step-message" rows="2" placeholder="Mensaje…">${escapeHtml(message)}</textarea>
    </div>`;
}

function addAutomationStepRow(step) {
  automationStepsListEl.insertAdjacentHTML('beforeend', automationStepRowHtml(step));
}

automationStepsListEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.automation-step-remove');
  if (!btn) return;
  btn.closest('.automation-step')?.remove();
});
automationAddStepBtn?.addEventListener('click', () => {
  const rows = automationStepsListEl.querySelectorAll('.as-day');
  const lastDay = rows.length ? Number(rows[rows.length - 1].value) || 1 : 0;
  addAutomationStepRow({ day: lastDay + 1, title: '', hour: 10, message: '' });
});

function openAutomationEditor(templateKey) {
  state.automationTemplateKey = templateKey;
  const template = templateKey ? AUTOMATION_TEMPLATES[templateKey] : null;

  automationEditorForm.reset();
  automationEditorStatus.textContent = '';
  automationEditorStatus.className = 'settings-status';
  automationNameInput.value = template?.label ?? '';
  automationStepsListEl.innerHTML = '';
  (template?.steps ?? [{ day: 1, title: '', hour: 10, message: '' }]).forEach(addAutomationStepRow);

  automationEditorOverlay.hidden = false;
}
function closeAutomationEditor() {
  automationEditorOverlay.hidden = true;
}
document.getElementById('automation-editor-modal-close')?.addEventListener('click', closeAutomationEditor);
automationEditorOverlay?.addEventListener('click', (ev) => {
  if (ev.target === automationEditorOverlay) closeAutomationEditor();
});
automationBackBtn?.addEventListener('click', () => {
  closeAutomationEditor();
  openAutomationTemplatePicker();
});

function collectAutomationEditorData() {
  const name = automationNameInput.value.trim();
  if (!name) {
    automationEditorStatus.textContent = 'El nombre del evento/objetivo es obligatorio.';
    automationEditorStatus.className = 'settings-status err';
    return null;
  }

  const steps = Array.from(automationStepsListEl.querySelectorAll('.automation-step')).map((row) => ({
    day: Math.max(1, Number(row.querySelector('.as-day').value) || 1),
    title: row.querySelector('.automation-step-title').value.trim(),
    hour: Math.min(23, Math.max(0, Number(row.querySelector('.as-hour').value) || 0)),
    message: row.querySelector('.automation-step-message').value.trim(),
  }));

  if (!steps.length) {
    automationEditorStatus.textContent = 'Agrega al menos un paso.';
    automationEditorStatus.className = 'settings-status err';
    return null;
  }

  return {
    name,
    template: state.automationTemplateKey,
    ignore_exit_on_conversion: automationIgnoreExitInput.checked,
    steps,
  };
}

function goToAudienceStep(ev) {
  ev.preventDefault();
  const data = collectAutomationEditorData();
  if (!data) return;
  state.automationPending = data;
  closeAutomationEditor();
  openAudienceStep();
}
automationEditorForm?.addEventListener('submit', goToAudienceStep);

async function saveAutomationDraftFromEditor() {
  const data = collectAutomationEditorData();
  if (!data) return;

  automationEditorStatus.textContent = 'Guardando borrador…';
  automationEditorStatus.className = 'settings-status';

  const { error } = await supabase.from('automations').insert({
    ...data,
    status: 'borrador',
    audience_temperaturas: [],
    audience_etapas: [],
    audience_score_min: null,
    audience_score_max: null,
  });

  if (error) {
    automationEditorStatus.textContent = `Error: ${error.message}`;
    automationEditorStatus.className = 'settings-status err';
    return;
  }

  automationEditorStatus.textContent = 'Guardado como borrador ✓';
  automationEditorStatus.className = 'settings-status ok';
  await loadAutomations();
  setTimeout(closeAutomationEditor, 500);
}
document.getElementById('automation-editor-save-draft-btn')?.addEventListener('click', saveAutomationDraftFromEditor);

// Paso 3: aprobar la audiencia --------------------------------------------

function openAudienceStep() {
  audienceTempChipsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.temp === 'CALIFICADO'));
  audienceEtapaChipsEl.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
  audienceScoreMinInput.value = '';
  audienceScoreMaxInput.value = '';
  audiencePreviewResult.textContent = '';
  automationAudienceStatus.textContent = '';
  automationAudienceStatus.className = 'settings-status';
  automationAudienceOverlay.hidden = false;
}
function closeAudienceStep() {
  automationAudienceOverlay.hidden = true;
  state.automationPending = null;
}
document.getElementById('automation-audience-modal-close')?.addEventListener('click', closeAudienceStep);
automationAudienceOverlay?.addEventListener('click', (ev) => {
  if (ev.target === automationAudienceOverlay) closeAudienceStep();
});

audienceTempChipsEl?.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  chip.classList.toggle('is-active');
});
audienceEtapaChipsEl?.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  chip.classList.toggle('is-active');
});

function selectedAudienceTemps() {
  return Array.from(audienceTempChipsEl.querySelectorAll('.chip.is-active')).map((c) => c.dataset.temp);
}
function selectedAudienceEtapas() {
  return Array.from(audienceEtapaChipsEl.querySelectorAll('.chip.is-active')).map((c) => c.dataset.etapa);
}

// PostgREST or() con un grupo and() anidado: el rango de score solo aplica a
// la rama de temperatura (label) — las etapas post-conversión no manejan score.
function buildAudienceOrFilter(temps, etapas, min, max) {
  const parts = [];
  if (temps.length) {
    const scoreClauses = [];
    if (min !== null) scoreClauses.push(`score.gte.${min}`);
    if (max !== null) scoreClauses.push(`score.lte.${max}`);
    const labelClause = `label.in.(${temps.join(',')})`;
    parts.push(scoreClauses.length ? `and(${labelClause},${scoreClauses.join(',')})` : labelClause);
  }
  if (etapas.length) {
    parts.push(`etapa.in.(${etapas.join(',')})`);
  }
  return parts.join(',');
}

async function previewAudience() {
  const temps = selectedAudienceTemps();
  const etapas = selectedAudienceEtapas();
  const min = audienceScoreMinInput.value === '' ? null : Number(audienceScoreMinInput.value);
  const max = audienceScoreMaxInput.value === '' ? null : Number(audienceScoreMaxInput.value);

  if (!temps.length && !etapas.length) {
    audiencePreviewResult.textContent = 'Selecciona al menos una temperatura o etapa.';
    return;
  }

  audiencePreviewResult.textContent = 'Calculando…';
  const orFilter = buildAudienceOrFilter(temps, etapas, min, max);
  const { count, error } = await supabase.from('prospects').select('id', { count: 'exact', head: true }).or(orFilter);

  if (error) {
    audiencePreviewResult.textContent = `Error: ${error.message}`;
    return;
  }
  audiencePreviewResult.textContent = `👥 ${count ?? 0} lead${count === 1 ? '' : 's'} coinciden con estos criterios.`;
}
audiencePreviewBtn?.addEventListener('click', previewAudience);

async function saveAutomation(status) {
  if (!state.automationPending) return;

  automationAudienceStatus.textContent = status === 'activa' ? 'Activando…' : 'Guardando…';
  automationAudienceStatus.className = 'settings-status';

  const min = audienceScoreMinInput.value === '' ? null : Number(audienceScoreMinInput.value);
  const max = audienceScoreMaxInput.value === '' ? null : Number(audienceScoreMaxInput.value);

  const { error } = await supabase.from('automations').insert({
    ...state.automationPending,
    status,
    audience_temperaturas: selectedAudienceTemps(),
    audience_etapas: selectedAudienceEtapas(),
    audience_score_min: min,
    audience_score_max: max,
  });

  if (error) {
    automationAudienceStatus.textContent = `Error: ${error.message}`;
    automationAudienceStatus.className = 'settings-status err';
    return;
  }

  automationAudienceStatus.textContent = status === 'activa' ? 'Automatización activada ✓' : 'Guardada como borrador ✓';
  automationAudienceStatus.className = 'settings-status ok';
  state.automationPending = null;
  await loadAutomations();
  setTimeout(() => (automationAudienceOverlay.hidden = true), 600);
}
automationSaveDraftBtn?.addEventListener('click', () => saveAutomation('borrador'));
automationActivateBtn?.addEventListener('click', () => saveAutomation('activa'));

// ── Disponibilidad del equipo ────────────────────────────────────────────────
// El estado por vendedor es real (se cambia acá mismo y queda loggeado en
// agent_status_log para las métricas de tiempo). Lo que NO está construido
// todavía son los dos motores automáticos: repartir leads solos
// ("Asignación inteligente") y enviar el WhatsApp de "Alerta de respuesta" —
// ambas pantallas de Config solo guardan su configuración por ahora.

const fmtRelativeTime = (iso) => {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Justo ahora';
  if (mins < 60) return `Hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours} h`;
  return `Hace ${Math.floor(hours / 24)} d`;
};

function closeAllAvailDropdowns(except) {
  document.querySelectorAll('#view-disponibilidad .filter-panel, #view-disponibilidad .avail-status-panel').forEach((p) => {
    if (p !== except) p.hidden = true;
  });
}
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#view-disponibilidad .filter-dropdown, #view-disponibilidad .avail-status-dropdown')) {
    closeAllAvailDropdowns();
  }
});

function setAvailTab(tab) {
  state.availTab = tab;
  availTabsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.availTab === tab));
  Object.entries(availPanels).forEach(([key, el]) => (el.hidden = key !== tab));
}
availTabsEl?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.chip[data-avail-tab]');
  if (!btn) return;
  setAvailTab(btn.dataset.availTab);
  if (btn.dataset.availTab === 'kpis') await loadAvailKpis();
  else if (btn.dataset.availTab === 'config') await loadAvailConfig();
  else if (btn.dataset.availTab === 'cola') await loadAvailCola();
});

async function loadAvailability() {
  await loadAgents();
  renderAvailTiempoReal();
  await loadAvailCola();
  setAvailTab(state.availTab);
  if (state.availTab === 'kpis') await loadAvailKpis();
  else if (state.availTab === 'config') await loadAvailConfig();
}

// Tab: Tiempo real -----------------------------------------------------------

function renderAvailTiempoReal() {
  const counts = Object.fromEntries(AGENT_STATUS_ORDER.map((s) => [s, 0]));
  state.agents.forEach((a) => (counts[a.status] = (counts[a.status] ?? 0) + 1));

  availStatusKpisEl.innerHTML = AGENT_STATUS_ORDER.map((s) => {
    const meta = AGENT_STATUS_META[s];
    return `
      <div class="avail-status-kpi">
        <div class="avail-status-kpi-top">
          <span class="avail-status-kpi-dot" style="background:var(--${meta.color})"></span>
          <span class="avail-status-kpi-value">${counts[s]}</span>
        </div>
        <span class="avail-status-kpi-label">${escapeHtml(meta.label)}</span>
      </div>`;
  }).join('');

  if (!state.agents.length) {
    availAgentCardsEl.innerHTML = '<p class="muted">No hay vendedores creados todavía. Créalos desde Canales → Crear vendedor.</p>';
    return;
  }

  availAgentCardsEl.innerHTML = state.agents
    .map((a) => {
      const meta = AGENT_STATUS_META[a.status] ?? AGENT_STATUS_META.fuera_de_atencion;
      return `
        <div class="product-card avail-agent-card" data-agent-id="${a.id}">
          <div class="avail-agent-card-top">
            <div class="avail-agent-identity">
              <span class="avatar" style="background:${colorFor(a.id)}">${initials(a.name)}</span>
              <span class="product-card-name">${escapeHtml(a.name)}</span>
            </div>
          </div>
          <div class="avail-status-dropdown">
            <button type="button" class="avail-status-trigger" data-agent-id="${a.id}">${meta.icon} ${escapeHtml(meta.label)} ▾</button>
            <div class="avail-status-panel" data-agent-id="${a.id}" hidden>
              ${AGENT_STATUS_ORDER.map(
                (s) =>
                  `<button type="button" class="avail-status-option" data-agent-id="${a.id}" data-status="${s}">${AGENT_STATUS_META[s].icon} ${escapeHtml(AGENT_STATUS_META[s].label)}</button>`
              ).join('')}
            </div>
          </div>
          <span class="avail-agent-updated">${fmtRelativeTime(a.status_updated_at)}</span>
        </div>`;
    })
    .join('');
}

availAgentCardsEl?.addEventListener('click', async (ev) => {
  const trigger = ev.target.closest('.avail-status-trigger');
  if (trigger) {
    const panel = availAgentCardsEl.querySelector(`.avail-status-panel[data-agent-id="${trigger.dataset.agentId}"]`);
    const willOpen = panel.hidden;
    closeAllAvailDropdowns();
    panel.hidden = !willOpen;
    return;
  }
  const option = ev.target.closest('.avail-status-option');
  if (option) {
    closeAllAvailDropdowns();
    await setAgentStatus(option.dataset.agentId, option.dataset.status);
  }
});

async function setAgentStatus(agentId, status) {
  const now = new Date().toISOString();
  await supabase.from('agent_status_log').update({ ended_at: now }).eq('agent_id', agentId).is('ended_at', null);
  const { error: logError } = await supabase.from('agent_status_log').insert({ agent_id: agentId, status, started_at: now });
  const { error } = await supabase.from('agents').update({ status, status_updated_at: now }).eq('id', agentId);
  if (logError || error) {
    alert(`Error al cambiar estado: ${(error || logError).message}`);
    return;
  }
  const agent = state.agents.find((a) => a.id === agentId);
  if (agent) {
    agent.status = status;
    agent.status_updated_at = now;
  }
  renderAvailTiempoReal();
  if (state.availTab === 'config') renderAvailPriorityTable();
}

// Tab: Cola de emergencia -----------------------------------------------------

async function loadAvailCola() {
  const { data, error } = await supabase
    .from('prospect_inbox')
    .select('id, nombre, phone, created_at, effective_agent_id')
    .is('effective_agent_id', null)
    .order('created_at', { ascending: true });

  state.availColaRows = error ? [] : data ?? [];
  if (error) console.error('Error cargando cola de emergencia:', error.message);

  const count = state.availColaRows.length;
  availQueueBadge.hidden = count === 0;
  availQueueCount.textContent = count;
  availQueueWord.textContent = count === 1 ? 'lead' : 'leads';
  availTabColaBadge.hidden = count === 0;
  availTabColaBadge.textContent = count;

  renderAvailCola();
}

function renderAvailCola() {
  const rows = state.availColaRows;
  if (!rows.length) {
    availColaBanner.hidden = true;
    availColaListEl.innerHTML = '<p class="muted">No hay leads esperando asignación manual 🎉</p>';
    return;
  }
  availColaBanner.hidden = false;
  availColaBanner.textContent = `⚠️ ${rows.length} lead${rows.length === 1 ? '' : 's'} esperando asignación manual`;
  availColaListEl.innerHTML = rows
    .map((p) => {
      const waitMin = Math.max(0, Math.round((Date.now() - new Date(p.created_at).getTime()) / 60000));
      return `
        <div class="avail-cola-row" data-id="${p.id}">
          <span class="avail-cola-icon">⚠️</span>
          <div class="avail-cola-info">
            <div class="avail-cola-name">${escapeHtml(p.nombre || 'Sin nombre')}</div>
            <div class="avail-cola-phone">${escapeHtml(p.phone)}</div>
          </div>
          <span class="avail-cola-wait">Esperando ${waitMin} min</span>
          <button type="button" class="btn btn-primary" data-assign-prospect="${p.id}">🤝 Asignar</button>
        </div>`;
    })
    .join('');
}

availColaListEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-assign-prospect]');
  if (!btn) return;
  const row = state.availColaRows.find((p) => p.id === btn.dataset.assignProspect);
  state.availAssigningProspectId = btn.dataset.assignProspect;
  availAssignLeadName.textContent = row ? `Asignando a: ${row.nombre || row.phone}` : '';
  availAssignSelect.innerHTML = state.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  availAssignStatus.textContent = '';
  availAssignStatus.className = 'settings-status';
  availAssignOverlay.hidden = false;
});
document.getElementById('avail-assign-modal-close')?.addEventListener('click', () => (availAssignOverlay.hidden = true));
availAssignOverlay?.addEventListener('click', (ev) => {
  if (ev.target === availAssignOverlay) availAssignOverlay.hidden = true;
});
availAssignConfirmBtn?.addEventListener('click', async () => {
  const prospectId = state.availAssigningProspectId;
  const agentId = availAssignSelect.value;
  if (!prospectId || !agentId) return;
  availAssignStatus.textContent = 'Asignando…';
  availAssignStatus.className = 'settings-status';
  const { error } = await supabase.from('prospects').update({ handled_by_agent_id: agentId }).eq('id', prospectId);
  if (error) {
    availAssignStatus.textContent = `Error: ${error.message}`;
    availAssignStatus.className = 'settings-status err';
    return;
  }
  availAssignStatus.textContent = 'Lead asignado ✓';
  availAssignStatus.className = 'settings-status ok';
  await loadAvailCola();
  setTimeout(() => (availAssignOverlay.hidden = true), 500);
});

// Tab: KPIs --------------------------------------------------------------------

availRangeTrigger?.addEventListener('click', () => {
  const willOpen = availRangePanel.hidden;
  closeAllAvailDropdowns();
  availRangePanel.hidden = !willOpen;
});
availRangePanel?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.avail-range-option');
  if (!btn) return;
  state.availRangeDays = Number(btn.dataset.days);
  availRangeLabel.textContent = btn.textContent;
  availRangePanel.hidden = true;
  await loadAvailKpis();
});

function availKpiCard(icon, label, value) {
  return `
    <div class="avail-kpi-card">
      <div class="avail-kpi-card-label">${icon} ${escapeHtml(label)}</div>
      <div class="avail-kpi-card-value">${escapeHtml(value)}</div>
    </div>`;
}

async function loadAvailKpis() {
  availAgentCountEl.textContent = state.agents.length;
  const rangeEnd = new Date();
  const rangeStart = new Date(rangeEnd.getTime() - state.availRangeDays * 86400000);

  const [{ data: logs, error: logsError }, { data: inboxRows, error: inboxError }] = await Promise.all([
    supabase
      .from('agent_status_log')
      .select('agent_id, status, started_at, ended_at')
      .lt('started_at', rangeEnd.toISOString())
      .or(`ended_at.is.null,ended_at.gte.${rangeStart.toISOString()}`),
    supabase
      .from('prospect_inbox')
      .select('id, effective_agent_id, created_at')
      .gte('created_at', rangeStart.toISOString())
      .lte('created_at', rangeEnd.toISOString()),
  ]);
  if (logsError) console.error('Error cargando agent_status_log:', logsError.message);
  if (inboxError) console.error('Error cargando leads del rango:', inboxError.message);

  const perAgentTime = {};
  const totals = Object.fromEntries(AGENT_STATUS_ORDER.map((s) => [s, 0]));
  (logs ?? []).forEach((log) => {
    const start = Math.max(new Date(log.started_at).getTime(), rangeStart.getTime());
    const end = Math.min(log.ended_at ? new Date(log.ended_at).getTime() : Date.now(), rangeEnd.getTime());
    if (end <= start) return;
    const minutes = (end - start) / 60000;
    totals[log.status] = (totals[log.status] ?? 0) + minutes;
    perAgentTime[log.agent_id] = perAgentTime[log.agent_id] ?? Object.fromEntries(AGENT_STATUS_ORDER.map((s) => [s, 0]));
    perAgentTime[log.agent_id][log.status] += minutes;
  });

  const perAgentLeads = {};
  (inboxRows ?? []).forEach((r) => {
    if (!r.effective_agent_id) return;
    perAgentLeads[r.effective_agent_id] = (perAgentLeads[r.effective_agent_id] ?? 0) + 1;
  });

  const fmtMin = (m) => `${Math.round(m)} min`;

  availKpiGridEl.innerHTML = [
    availKpiCard('⚡', 'Tiempo listo', fmtMin(totals.listo)),
    availKpiCard('🎧', 'Tiempo atendiendo', fmtMin(totals.atendiendo)),
    availKpiCard('☕', 'Tiempo en pausa', fmtMin(totals.pausa)),
    availKpiCard('🌙', 'Tiempo fuera', fmtMin(totals.fuera_de_atencion)),
    availKpiCard('⛔', 'Tiempo inactivo', fmtMin(totals.inactivo_sistema)),
    availKpiCard('👥', 'Leads ingresados', String((inboxRows ?? []).length)),
    availKpiCard('🤖', 'Ofrecidos por IA', '0'),
    availKpiCard('✅', 'Leads aceptados', '0'),
    availKpiCard('❌', 'Leads rechazados', '0'),
    availKpiCard('🔄', 'Leads reasignados', '0'),
    availKpiCard('⏱', 'Tiempo promedio de respuesta', '—'),
    availKpiCard('📞', 'Tasa de contacto', '—'),
    availKpiCard('📈', 'Tasa de conversión', '—'),
    availKpiCard('📊', 'Disponibilidad productiva', '—'),
  ].join('');

  availDetailTbody.innerHTML =
    state.agents
      .map((a) => {
        const t = perAgentTime[a.id] ?? Object.fromEntries(AGENT_STATUS_ORDER.map((s) => [s, 0]));
        return `
          <tr>
            <td>${escapeHtml(a.name)}</td>
            <td>${fmtMin(t.listo)}</td>
            <td>${fmtMin(t.atendiendo)}</td>
            <td>${perAgentLeads[a.id] ?? 0}</td>
            <td>0</td>
            <td>0</td>
            <td>—</td>
            <td>—</td>
          </tr>`;
      })
      .join('') || `<tr class="empty-row"><td colspan="8">No hay vendedores creados todavía.</td></tr>`;
}

// Tab: Config ------------------------------------------------------------------

function renderAvailPriorityTable() {
  availPriorityTbody.innerHTML =
    state.agents
      .map((a) => {
        const meta = AGENT_STATUS_META[a.status] ?? AGENT_STATUS_META.fuera_de_atencion;
        return `
          <tr data-agent-id="${a.id}">
            <td>${escapeHtml(a.name)}</td>
            <td><span class="status-pill ${meta.color === 'ok' ? 'is-on' : meta.color === 'off' ? '' : 'is-' + meta.color}">${meta.icon} ${escapeHtml(meta.label)}</span></td>
            <td>
              <span class="avail-priority-stepper">
                <button type="button" data-priority-step="-1" data-agent-id="${a.id}">−</button>
                <span>${a.priority}</span>
                <button type="button" data-priority-step="1" data-agent-id="${a.id}">+</button>
              </span>
            </td>
          </tr>`;
      })
      .join('') || `<tr class="empty-row"><td colspan="3">No hay vendedores creados todavía.</td></tr>`;
}
availPriorityTbody?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-priority-step]');
  if (!btn) return;
  const agent = state.agents.find((a) => a.id === btn.dataset.agentId);
  if (!agent) return;
  const next = Math.min(10, Math.max(1, agent.priority + Number(btn.dataset.priorityStep)));
  if (next === agent.priority) return;
  agent.priority = next;
  renderAvailPriorityTable();
  const { error } = await supabase.from('agents').update({ priority: next }).eq('id', agent.id);
  if (error) console.error('Error guardando prioridad:', error.message);
});

function updateAlertPillAndHint() {
  const on = availAlertToggle.checked;
  availAlertPill.textContent = on ? 'Activa' : 'Inactiva';
  availAlertPill.classList.toggle('is-on', on);
  availAlertHint.hidden = on;
}
availAlertToggle?.addEventListener('change', updateAlertPillAndHint);

function renderAvailPhoneList() {
  availPhoneListEl.innerHTML =
    state.availAlertPhones
      .map((phone) => `<span class="avail-phone-chip">${escapeHtml(phone)}<button type="button" data-remove-phone="${escapeHtml(phone)}" aria-label="Quitar">✕</button></span>`)
      .join('') || '<p class="muted" style="margin:0;">Sin números agregados.</p>';
}
availPhoneAddBtn?.addEventListener('click', () => {
  const digits = availPhoneInput.value.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    alert('El número debe tener entre 8 y 15 dígitos, incluyendo el código de país.');
    return;
  }
  if (!state.availAlertPhones.includes(digits)) state.availAlertPhones.push(digits);
  availPhoneInput.value = '';
  renderAvailPhoneList();
});
availPhoneListEl?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-remove-phone]');
  if (!btn) return;
  state.availAlertPhones = state.availAlertPhones.filter((p) => p !== btn.dataset.removePhone);
  renderAvailPhoneList();
});

function updateEtapasTriggerLabel() {
  const labels = state.availAlertEtapas.map((k) => AVAIL_ETAPA_META[k]).filter(Boolean);
  availEtapasTrigger.innerHTML = `${labels.length ? escapeHtml(labels.join(', ')) : 'Seleccionar etapas…'} <span class="filter-caret">▾</span>`;
}
function renderAvailEtapasList() {
  availEtapasListEl.innerHTML = Object.entries(AVAIL_ETAPA_META)
    .map(
      ([key, label]) =>
        `<label class="filter-option"><input type="checkbox" value="${key}" ${state.availAlertEtapas.includes(key) ? 'checked' : ''} /> ${escapeHtml(label)}</label>`
    )
    .join('');
  updateEtapasTriggerLabel();
}
availEtapasTrigger?.addEventListener('click', () => {
  const willOpen = availEtapasPanel.hidden;
  closeAllAvailDropdowns();
  availEtapasPanel.hidden = !willOpen;
});
availEtapasListEl?.addEventListener('change', (ev) => {
  const cb = ev.target.closest('input[type="checkbox"]');
  if (!cb) return;
  if (cb.checked) {
    if (!state.availAlertEtapas.includes(cb.value)) state.availAlertEtapas.push(cb.value);
  } else {
    state.availAlertEtapas = state.availAlertEtapas.filter((v) => v !== cb.value);
  }
  updateEtapasTriggerLabel();
  renderAvailPreview();
});

function syncMinutesChips(value) {
  availMinutesChipsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.minutes) === Number(value)));
}
availMinutesChipsEl?.addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip[data-minutes]');
  if (!chip) return;
  availMinutesInput.value = chip.dataset.minutes;
  syncMinutesChips(chip.dataset.minutes);
  renderAvailPreview();
});
availMinutesInput?.addEventListener('input', () => {
  syncMinutesChips(availMinutesInput.value);
  renderAvailPreview();
});

function renderAvailPreview() {
  if (state.availAlertEtapas.length) {
    const labels = state.availAlertEtapas.map((k) => AVAIL_ETAPA_META[k]).filter(Boolean).join(', ');
    availPreviewEtapa.textContent = `🔔 Juan Pérez entró a la etapa "${labels}" en el canal ventas-wsp (vendedor: Karin Goicochea).`;
  } else {
    availPreviewEtapa.textContent = 'Selecciona al menos una etapa para ver el aviso que se enviará cuando un lead llegue a ella.';
  }
  const minutes = Math.min(1440, Math.max(1, Number(availMinutesInput.value) || 15));
  availPreviewTimeout.textContent = `⚠️ Lead sin responder: Juan Pérez en el canal ventas-wsp lleva ${minutes} min sin respuesta.`;
  availPreviewTimeoutNote.textContent = `Se enviará cuando un lead supere ${minutes} min sin respuesta.`;
}

async function loadAvailConfig() {
  const { data, error } = await supabase.from('availability_settings').select('*').eq('organization_id', state.me.organization.id).maybeSingle();
  if (error) console.error('Error cargando availability_settings:', error.message);

  state.availSettings = data ?? {
    smart_assignment_enabled: false,
    alert_enabled: false,
    alert_phones: [],
    alert_etapas: [],
    alert_minutes: 15,
  };
  state.availAlertPhones = [...(state.availSettings.alert_phones ?? [])];
  state.availAlertEtapas = [...(state.availSettings.alert_etapas ?? [])];

  availSmartToggle.checked = state.availSettings.smart_assignment_enabled;
  availAlertToggle.checked = state.availSettings.alert_enabled;
  updateAlertPillAndHint();
  renderAvailPhoneList();
  renderAvailEtapasList();
  availMinutesInput.value = state.availSettings.alert_minutes;
  syncMinutesChips(state.availSettings.alert_minutes);
  renderAvailPreview();
  renderAvailPriorityTable();

  availConfigStatus.textContent = '';
  availConfigStatus.className = 'settings-status';
}

availSmartToggle?.addEventListener('change', async () => {
  const { error } = await supabase
    .from('availability_settings')
    .update({ smart_assignment_enabled: availSmartToggle.checked })
    .eq('organization_id', state.me.organization.id);
  if (error) alert(`Error al guardar: ${error.message}`);
});

availConfigSaveBtn?.addEventListener('click', async () => {
  const minutes = Math.min(1440, Math.max(1, Number(availMinutesInput.value) || 15));
  availConfigStatus.textContent = 'Guardando…';
  availConfigStatus.className = 'settings-status';
  const { error } = await supabase
    .from('availability_settings')
    .update({
      alert_enabled: availAlertToggle.checked,
      alert_phones: state.availAlertPhones,
      alert_etapas: state.availAlertEtapas,
      alert_minutes: minutes,
    })
    .eq('organization_id', state.me.organization.id);
  if (error) {
    availConfigStatus.textContent = `Error: ${error.message}`;
    availConfigStatus.className = 'settings-status err';
    return;
  }
  availConfigStatus.textContent = 'Configuración guardada ✓';
  availConfigStatus.className = 'settings-status ok';
});

async function loadProspects() {
  if (!state.vendorId) return;
  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('vendor_id', state.vendorId)
    .order('updated_at', { ascending: false });
  if (error) {
    console.error('Error cargando prospects:', error.message);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Error cargando prospectos.</td></tr>`;
    return;
  }
  state.prospects = data ?? [];
  renderKpis();
  renderTable();
}

async function loadMessages(prospectId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('prospect_id', prospectId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando messages:', error.message);
    return [];
  }
  return data ?? [];
}

// ── Bandeja Global / chats por asesor ────────────────────────────────────────

async function loadInbox() {
  let q = supabase.from('prospect_inbox').select('*').order('last_message_at', { ascending: false, nullsFirst: false });
  if (state.inboxVendorLock) q = q.eq('vendor_id', state.inboxVendorLock);

  const { data, error } = await q;
  if (error) {
    console.error('Error cargando inbox:', error.message);
    inboxListEl.innerHTML = '<p class="muted">Error cargando conversaciones.</p>';
    return;
  }
  state.inboxRows = data ?? [];

  renderEtapasFilter();
  renderEtiquetasFilter(inboxEtiquetasSearchInput.value);
  renderInboxList();
  subscribeInbox();
}

function getFilteredInbox() {
  let rows = state.inboxRows;
  const f = state.inboxFilters;

  if (state.inboxVendorLock) {
    rows = rows.filter((r) => r.vendor_id === state.inboxVendorLock);
  } else if (f.canales.size) {
    rows = rows.filter((r) => f.canales.has(r.vendor_id));
  }

  if (f.etapas.size) rows = rows.filter((r) => f.etapas.has(r.etapa));
  if (f.etiquetas.size) rows = rows.filter((r) => (r.etiquetas || []).some((t) => f.etiquetas.has(t)));
  if (f.vendedores.size) {
    rows = rows.filter((r) => f.vendedores.has(r.effective_agent_id || INBOX_UNASSIGNED));
  }

  const { start, end } = state.inboxDateRange;
  if (start || end) {
    rows = rows.filter((r) => {
      const raw = r[state.inboxDateMode];
      if (!raw) return false;
      const d = new Date(raw);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  if (state.inboxSearch.trim()) {
    const q = state.inboxSearch.trim().toLowerCase();
    rows = rows.filter(
      (r) => (r.nombre || '').toLowerCase().includes(q) || (r.phone || '').includes(q) || (r.last_message || '').toLowerCase().includes(q)
    );
  }
  return rows;
}

// ── Bandeja Global: dropdowns de filtro (canales/etapas/etiquetas/vendedores) ─

function updateFilterBadge(group) {
  const btn = document.querySelector(`.filter-trigger[data-filter="${group}"]`);
  const badge = btn.querySelector('.filter-badge');
  const n = state.inboxFilters[group].size;
  badge.hidden = n === 0;
  badge.textContent = n;
}

function renderCanalesFilter() {
  const listEl = document.getElementById('fp-canales-list');
  listEl.innerHTML =
    state.vendors
      .map(
        (v) => `
      <label class="filter-option">
        <input type="checkbox" data-group="canales" value="${v.id}" ${state.inboxFilters.canales.has(v.id) ? 'checked' : ''} />
        <span>${escapeHtml(v.name)}</span>
      </label>`
      )
      .join('') || '<p class="muted filter-panel-empty">No hay canales disponibles.</p>';
  updateFilterBadge('canales');
}

function renderEtapasFilter() {
  const etapas = [...new Set(state.inboxRows.map((r) => r.etapa).filter(Boolean))].sort();
  state.inboxFilters.etapas = new Set([...state.inboxFilters.etapas].filter((e) => etapas.includes(e)));

  const listEl = document.getElementById('fp-etapas-list');
  listEl.innerHTML =
    etapas
      .map(
        (e) => `
      <label class="filter-option">
        <input type="checkbox" data-group="etapas" value="${escapeHtml(e)}" ${state.inboxFilters.etapas.has(e) ? 'checked' : ''} />
        <span>${escapeHtml(e)}</span>
      </label>`
      )
      .join('') || '<p class="muted filter-panel-empty">Todavía no hay etapas asignadas.</p>';
  updateFilterBadge('etapas');
}

function renderEtiquetasFilter(query = '') {
  const all = [...new Set(state.inboxRows.flatMap((r) => r.etiquetas || []))].sort();
  state.inboxFilters.etiquetas = new Set([...state.inboxFilters.etiquetas].filter((t) => all.includes(t)));

  const q = query.trim().toLowerCase();
  const filtered = q ? all.filter((t) => t.toLowerCase().includes(q)) : all;

  const listEl = document.getElementById('fp-etiquetas-list');
  listEl.innerHTML =
    filtered
      .map(
        (t) => `
      <label class="filter-option">
        <input type="checkbox" data-group="etiquetas" value="${escapeHtml(t)}" ${state.inboxFilters.etiquetas.has(t) ? 'checked' : ''} />
        <span>${escapeHtml(t)}</span>
      </label>`
      )
      .join('') || '<p class="muted filter-panel-empty">Sin etiquetas todavía.</p>';
  updateFilterBadge('etiquetas');
}

function renderVendedoresFilter() {
  const options = [{ id: INBOX_UNASSIGNED, name: 'Sin asignar' }, ...state.agents];
  const listEl = document.getElementById('fp-vendedores-list');
  listEl.innerHTML = options
    .map(
      (a) => `
    <label class="filter-option">
      <input type="checkbox" data-group="vendedores" value="${a.id}" ${state.inboxFilters.vendedores.has(a.id) ? 'checked' : ''} />
      <span>${escapeHtml(a.name)}</span>
    </label>`
    )
    .join('');
  updateFilterBadge('vendedores');
}

document.getElementById('view-inbox').addEventListener('change', (ev) => {
  const cb = ev.target.closest('input[type="checkbox"][data-group]');
  if (!cb) return;
  const set = state.inboxFilters[cb.dataset.group];
  if (cb.checked) set.add(cb.value);
  else set.delete(cb.value);
  updateFilterBadge(cb.dataset.group);
  renderInboxList();
});
inboxEtiquetasSearchInput.addEventListener('input', () => renderEtiquetasFilter(inboxEtiquetasSearchInput.value));

// ── Bandeja Global: apertura/cierre de dropdowns de filtro ───────────────────

function closeAllFilterPanels(except) {
  document.querySelectorAll('#view-inbox .filter-panel').forEach((p) => {
    if (p !== except) p.hidden = true;
  });
}
document.querySelectorAll('#view-inbox .filter-trigger').forEach((btn) => {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (btn.disabled) return;
    const panel = btn.parentElement.querySelector('.filter-panel');
    const willOpen = panel.hidden;
    closeAllFilterPanels();
    panel.hidden = !willOpen;
    if (willOpen && btn.dataset.filter === 'fechas') renderCalendars();
  });
});
document.addEventListener('click', (ev) => {
  // Usamos composedPath() en vez de ev.target.closest(): un clic en un día del
  // calendario reemplaza su propio contenedor vía innerHTML de forma síncrona
  // (ver renderCalendars), así que al llegar acá ev.target ya está desprendido
  // del DOM y closest() devolvería null aunque el clic haya sido "adentro".
  const path = ev.composedPath ? ev.composedPath() : [];
  const insideDropdown = path.some((el) => el.classList?.contains('filter-dropdown'));
  if (!insideDropdown) closeAllFilterPanels();
});

// ── Bandeja Global: selector de rango de fechas ──────────────────────────────

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAY_NAMES = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];

const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const isSameDay = (a, b) => a && b && a.toDateString() === b.toDateString();

function renderCalendarMonth(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toDateString();
  const { start, end } = state.calendarPick;

  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += '<span class="cal-day cal-day-empty"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const classes = ['cal-day'];
    if (d.toDateString() === todayStr) classes.push('is-today');
    if (start && end && d > start && d < end) classes.push('is-in-range');
    if ((start && isSameDay(d, start)) || (end && isSameDay(d, end))) classes.push('is-range-edge');
    cells += `<button type="button" class="${classes.join(' ')}" data-date="${d.getTime()}">${day}</button>`;
  }

  return `
    <div class="calendar">
      <div class="calendar-title">${MONTH_NAMES[month]} ${year}</div>
      <div class="calendar-weekdays">${WEEKDAY_NAMES.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="calendar-grid">${cells}</div>
    </div>`;
}

function pickCalendarDate(timestamp) {
  const d = new Date(timestamp);
  const p = state.calendarPick;
  if (!p.start || (p.start && p.end)) {
    state.calendarPick = { start: d, end: null };
  } else if (d < p.start) {
    state.calendarPick = { start: d, end: p.start };
  } else {
    state.calendarPick = { start: p.start, end: d };
  }
  renderCalendars();
}

function renderCalendars() {
  const second = addMonths(state.calendarBase, 1);
  inboxFechasCalendarsEl.innerHTML = `
    <button type="button" class="cal-nav cal-nav-prev" id="cal-prev">‹</button>
    ${renderCalendarMonth(state.calendarBase)}
    ${renderCalendarMonth(second)}
    <button type="button" class="cal-nav cal-nav-next" id="cal-next">›</button>
  `;
  document.getElementById('cal-prev').addEventListener('click', () => {
    state.calendarBase = addMonths(state.calendarBase, -1);
    renderCalendars();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.calendarBase = addMonths(state.calendarBase, 1);
    renderCalendars();
  });
  inboxFechasCalendarsEl.querySelectorAll('.cal-day:not(.cal-day-empty)').forEach((btn) => {
    btn.addEventListener('click', () => pickCalendarDate(Number(btn.dataset.date)));
  });
}

function updateFechasTriggerLabel() {
  const { start, end } = state.inboxDateRange;
  if (!start && !end) {
    inboxFechasTrigger.textContent = '📅 Selecciona un rango de fechas';
    return;
  }
  const fmt = (d) => d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  inboxFechasTrigger.textContent = end && !isSameDay(start, end) ? `📅 ${fmt(start)} – ${fmt(end)}` : `📅 ${fmt(start)}`;
}

document.querySelectorAll('.date-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.inboxDateMode = btn.dataset.dateMode;
    document.querySelectorAll('.date-mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderInboxList();
  });
});
document.getElementById('fp-fechas-apply').addEventListener('click', () => {
  const { start, end } = state.calendarPick;
  const endPick = end ?? start;
  state.inboxDateRange = {
    start: start ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0) : null,
    end: endPick ? new Date(endPick.getFullYear(), endPick.getMonth(), endPick.getDate(), 23, 59, 59, 999) : null,
  };
  updateFechasTriggerLabel();
  closeAllFilterPanels();
  renderInboxList();
});
document.getElementById('fp-fechas-clear').addEventListener('click', () => {
  state.calendarPick = { start: null, end: null };
  state.inboxDateRange = { start: null, end: null };
  updateFechasTriggerLabel();
  renderCalendars();
  renderInboxList();
});

function renderInboxList() {
  const base = getFilteredInbox();
  const prestadosCount = base.filter((r) => r.is_prestado).length;
  inboxCountTodos.textContent = base.length;
  inboxCountPrestados.textContent = prestadosCount;

  let rows = state.inboxTab === 'prestados' ? base.filter((r) => r.is_prestado) : base;
  if (state.inboxSortByScore) rows = [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (!rows.length) {
    inboxListEl.innerHTML = '<p class="muted" style="padding:20px;">Sin conversaciones para este filtro.</p>';
    return;
  }

  inboxListEl.innerHTML = rows
    .map((r) => {
      const name = r.nombre || r.phone;
      const preview = r.last_message ? (r.last_message_role === 'assistant' ? `Tú: ${r.last_message}` : r.last_message) : 'Sin mensajes todavía';
      const tags = [
        r.etapa ? `<span class="tag-pill tag-etapa">${escapeHtml(r.etapa)}</span>` : '',
        `<span class="tag-pill tag-${r.estado_conversacion}">${escapeHtml(r.estado_conversacion)}</span>`,
        r.is_prestado ? `<span class="tag-pill tag-prestado">Prestado</span>` : '',
      ].join('');

      return `
      <div class="inbox-row" data-id="${r.id}">
        <div class="avatar" style="background:${colorFor(r.vendor_id)}">${initials(name)}</div>
        <div class="inbox-row-main">
          <div class="inbox-row-top"><span class="inbox-row-name">${escapeHtml(name)}</span></div>
          <div class="inbox-row-preview">${escapeHtml(preview)}</div>
          <div class="inbox-row-tags">${tags}</div>
        </div>
        <div class="inbox-row-side">
          <span class="inbox-score">★ ${r.score}</span>
          <span class="inbox-agent">${escapeHtml(r.handled_by_name || r.vendor_name)}</span>
        </div>
      </div>`;
    })
    .join('');
}

function subscribeInbox() {
  if (state.inboxChannel) supabase.removeChannel(state.inboxChannel);
  state.inboxChannel = supabase
    .channel(`inbox-${state.inboxVendorLock ?? 'all'}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prospects' }, () => loadInbox())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => loadInbox())
    .subscribe();
}

inboxSearchInput.addEventListener('input', () => {
  state.inboxSearch = inboxSearchInput.value;
  renderInboxList();
});
inboxSortBtn.addEventListener('click', () => {
  state.inboxSortByScore = !state.inboxSortByScore;
  inboxSortBtn.classList.toggle('is-active', state.inboxSortByScore);
  renderInboxList();
});
document.querySelector('.inbox-tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  state.inboxTab = btn.dataset.inboxTab;
  document.querySelectorAll('.inbox-tabs .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  renderInboxList();
});
inboxListEl.addEventListener('click', (ev) => {
  const row = ev.target.closest('.inbox-row');
  if (!row) return;
  const prospect = state.inboxRows.find((r) => r.id === row.dataset.id);
  if (prospect) openDrawer(prospect);
});

// ── Dashboard ────────────────────────────────────────────────────────────────
// No hay tabla de ventas en este CRM: "Etapa" es un campo libre que la Bandeja
// Global ya usa para gestión manual (ver 20260907020000_bandeja_global.sql), así
// que lo reutilizamos como proxy: etapa="venta" = venta cerrada (revenue = suma
// de presupuesto), etapa="por_depositar" = pendiente de depósito.

const ALTO_VALOR_THRESHOLD = 1500000;

const norm = (s) => (s || '').toString().trim().toLowerCase();
const isVenta = (r) => norm(r.etapa) === 'venta';
const isPorDepositar = (r) => norm(r.etapa) === 'por_depositar';

async function loadDashboard() {
  dashPanelEl.innerHTML = '<p class="muted">Cargando dashboard…</p>';
  const { data, error } = await supabase.from('prospect_inbox').select('*');
  if (error) {
    console.error('Error cargando dashboard:', error.message);
    dashPanelEl.innerHTML = '<p class="muted">Error cargando el dashboard.</p>';
    return;
  }
  state.dashboardRows = data ?? [];
  renderDashboardKpis();
  renderDashboardTab();
}

function renderDashboardKpis() {
  const rows = state.dashboardRows;
  const total = rows.length;
  const ventas = rows.filter(isVenta);
  const depositar = rows.filter(isPorDepositar).length;
  const conversion = total ? (ventas.length / total) * 100 : 0;

  dashKpiLeads.textContent = total;
  dashKpiVentas.textContent = ventas.length;
  dashKpiDepositar.textContent = depositar;
  dashKpiConversion.textContent = `${conversion.toFixed(1)}%`;
}

function computeAgentStats(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.handled_by_name || 'IA / sin vendedor';
    if (!map.has(key)) {
      map.set(key, { name: key, leads: 0, frio: 0, tibio: 0, calificado: 0, descartado: 0, depositar: 0, ventas: 0, revenue: 0, scoreSum: 0 });
    }
    const a = map.get(key);
    a.leads++;
    a.scoreSum += r.score ?? 0;
    if (r.label === 'FRIO') a.frio++;
    if (r.label === 'TIBIO') a.tibio++;
    if (r.label === 'CALIFICADO') a.calificado++;
    if (r.label === 'DESCARTADO') a.descartado++;
    if (isPorDepositar(r)) a.depositar++;
    if (isVenta(r)) {
      a.ventas++;
      a.revenue += r.presupuesto || 0;
    }
  }
  return [...map.values()]
    .map((a) => ({
      ...a,
      avgScore: a.leads ? Math.round(a.scoreSum / a.leads) : 0,
      conversion: a.leads ? (a.ventas / a.leads) * 100 : 0,
    }))
    .sort((a, b) => b.ventas - a.ventas || b.avgScore - a.avgScore);
}

function renderProspectMiniTable(list) {
  if (!list.length) {
    return '<div class="table-wrap"><table><tbody><tr class="empty-row"><td>Sin leads para mostrar.</td></tr></tbody></table></div>';
  }
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Nombre</th><th>Teléfono</th><th>Score</th><th>Estado</th><th>Zona</th><th>Presupuesto</th><th>Vendedor</th></tr></thead>
        <tbody>
          ${list
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.nombre || '—')}</td>
              <td>${escapeHtml(r.phone)}</td>
              <td>${r.score ?? 0}</td>
              <td><span class="badge badge-${r.label}">${escapeHtml(r.label)}</span></td>
              <td>${escapeHtml(r.zona || '—')}</td>
              <td>${fmtMoney(r.presupuesto, r.presupuesto_moneda)}</td>
              <td>${escapeHtml(r.handled_by_name || r.vendor_name)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAgentRanking(stats) {
  if (!stats.length) return '<p class="muted">Todavía no hay leads para calcular un ranking.</p>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Asesor</th><th>Leads</th><th>Ventas</th><th>Score prom.</th><th>Conv.</th></tr></thead>
        <tbody>
          ${stats
            .map(
              (a, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${escapeHtml(a.name)}</td>
              <td>${a.leads}</td>
              <td>${a.ventas}</td>
              <td>${a.avgScore}</td>
              <td>${a.conversion.toFixed(1)}%</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function dashPlaceholder(icon, title, text) {
  return `<div class="placeholder-box"><div class="placeholder-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(text)}</p></div>`;
}

function dashHoy(rows) {
  const total = rows.length;
  const ventas = rows.filter(isVenta);
  const depositar = rows.filter(isPorDepositar);
  const conversion = total ? (ventas.length / total) * 100 : 0;
  const stats = computeAgentStats(rows);
  const top = stats[0];

  const priority = rows
    .filter((r) => r.estado_conversacion !== 'cerrado' && r.label !== 'DESCARTADO' && !isVenta(r))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);

  const today = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });

  return `
    <div class="dash-hero">
      <div class="dash-hero-icon">☀️</div>
      <div><h3>Buenos días</h3><p class="muted">${escapeHtml(today)}</p></div>
    </div>
    <div class="dash-cards-row">
      <div class="dash-note dash-note-ok">
        <strong>${conversion >= 15 ? 'Vas por buen camino.' : 'Todavía puedes mejorar.'}</strong>
        <p>${ventas.length} ventas de ${total} leads (${conversion.toFixed(1)}% conversión).</p>
      </div>
      <div class="dash-note dash-note-warn">
        <strong>${top ? `Lidera ${escapeHtml(top.name)}` : 'Sin datos de asesores todavía'}</strong>
        <p>${top ? `${top.ventas} ventas · score promedio ${top.avgScore}` : ''}</p>
      </div>
      <div class="dash-note dash-note-cold">
        <strong>${depositar.length} cliente(s) listos para depositar.</strong>
        <p>Tienes dinero sobre la mesa. Prioriza cerrar estos leads hoy.</p>
      </div>
    </div>
    <h3 class="section-title" style="margin-top:20px;">Prioridad de hoy</h3>
    ${renderProspectMiniTable(priority)}
  `;
}

function dashDueno(rows) {
  const total = rows.length;
  const ventas = rows.filter(isVenta);
  const revenue = ventas.reduce((s, r) => s + (r.presupuesto || 0), 0);
  const depositar = rows.filter(isPorDepositar).length;
  const conversion = total ? (ventas.length / total) * 100 : 0;
  const stats = computeAgentStats(rows);

  const status =
    conversion >= 15
      ? { dot: 'ok', title: 'Estás ganando dinero', text: `Conversión actual ${conversion.toFixed(1)}%.` }
      : conversion > 0
        ? { dot: 'warn', title: 'Vas mejorando', text: `Conversión actual ${conversion.toFixed(1)}%. Todavía hay margen.` }
        : {
            dot: 'off',
            title: 'Sin ventas registradas todavía',
            text: 'Marca la Etapa de un lead como "venta" desde la Bandeja Global cuando cierres uno para verlo aquí.',
          };

  return `
    <div class="dash-status dash-status-${status.dot}">
      <span class="dash-status-dot"></span>
      <div><h3>${escapeHtml(status.title)}</h3><p class="muted">${escapeHtml(status.text)}</p></div>
    </div>
    <div class="dash-cards-row">
      <div class="stat-card"><span class="stat-value">${ventas.length}</span><span class="stat-label">Ventas</span></div>
      <div class="stat-card"><span class="stat-value">${fmtMoney(revenue, 'MXN')}</span><span class="stat-label">Revenue</span></div>
      <div class="stat-card"><span class="stat-value">${depositar}</span><span class="stat-label">Por depositar</span></div>
    </div>
    <h3 class="section-title" style="margin-top:20px;">Ranking de asesores</h3>
    ${renderAgentRanking(stats)}
  `;
}

function dashEmbudo(rows) {
  const counts = {
    'Por depositar': rows.filter(isPorDepositar).length,
    Calificado: rows.filter((r) => r.label === 'CALIFICADO').length,
    Tibio: rows.filter((r) => r.label === 'TIBIO').length,
    Frío: rows.filter((r) => r.label === 'FRIO').length,
    Descartado: rows.filter((r) => r.label === 'DESCARTADO').length,
  };
  const max = Math.max(1, ...Object.values(counts));
  const avgScore = rows.length ? Math.round(rows.reduce((s, r) => s + (r.score ?? 0), 0) / rows.length) : 0;
  const highScore = rows.filter((r) => (r.score ?? 0) >= 80).length;

  return `
    <p class="muted">Score promedio: ${avgScore} · Score 80+: ${highScore} leads</p>
    <div class="dash-bars" style="margin-top:14px;">
      ${Object.entries(counts)
        .map(
          ([label, n]) => `
        <div class="dash-bar-row">
          <span class="dash-bar-label">${escapeHtml(label)}</span>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${(n / max) * 100}%"></div></div>
          <span class="dash-bar-value">${n}</span>
        </div>`
        )
        .join('')}
    </div>
  `;
}

function dashAsesores(rows) {
  const stats = computeAgentStats(rows);
  if (!stats.length) return '<p class="muted">Todavía no hay leads registrados.</p>';
  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Asesor</th><th>Leads</th><th>Frío</th><th>Tibio</th><th>Calificado</th><th>Descartado</th><th>Por depositar</th><th>Ventas</th><th>Conv.</th><th>Revenue</th></tr></thead>
        <tbody>
          ${stats
            .map(
              (a) => `
            <tr>
              <td>${escapeHtml(a.name)}</td>
              <td>${a.leads}</td>
              <td>${a.frio}</td>
              <td>${a.tibio}</td>
              <td>${a.calificado}</td>
              <td>${a.descartado}</td>
              <td>${a.depositar}</td>
              <td>${a.ventas}</td>
              <td>${a.conversion.toFixed(1)}%</td>
              <td>${fmtMoney(a.revenue, 'MXN')}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function dashPerdidos(rows) {
  const perdidos = rows.filter((r) => r.label === 'DESCARTADO');
  const altoValor = perdidos.filter((r) => (r.presupuesto ?? 0) >= ALTO_VALOR_THRESHOLD).length;
  const avgScore = perdidos.length ? Math.round(perdidos.reduce((s, r) => s + (r.score ?? 0), 0) / perdidos.length) : 0;
  const recientes = [...perdidos].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 10);

  return `
    <div class="dash-cards-row">
      <div class="stat-card"><span class="stat-value">${perdidos.length}</span><span class="stat-label">Total perdidos</span></div>
      <div class="stat-card"><span class="stat-value">${altoValor}</span><span class="stat-label">Alto valor (≥ ${fmtMoney(ALTO_VALOR_THRESHOLD, 'MXN')})</span></div>
      <div class="stat-card"><span class="stat-value">${avgScore}</span><span class="stat-label">Score promedio</span></div>
    </div>
    <h3 class="section-title" style="margin-top:20px;">Leads perdidos recientes</h3>
    ${renderProspectMiniTable(recientes)}
  `;
}

function dashSalud(rows) {
  const stats = computeAgentStats(rows);
  if (!stats.length) return '<p class="muted">Todavía no hay leads registrados.</p>';

  const cards = stats
    .map((a) => {
      const calidad = a.leads ? (a.calificado / a.leads) * 100 : 0;
      const health = Math.round(a.conversion * 0.4 + a.avgScore * 0.3 + calidad * 0.3);
      return `
      <div class="health-card">
        <div class="health-card-top">
          <div class="avatar" style="background:${colorFor(a.name)}">${initials(a.name)}</div>
          <div><strong>${escapeHtml(a.name)}</strong><div class="muted">${a.leads} leads</div></div>
          <span class="health-score">${health}</span>
        </div>
        <div class="health-bars">
          <div class="health-bar"><span>Conversión</span><div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.min(100, a.conversion)}%"></div></div><span>${a.conversion.toFixed(0)}</span></div>
          <div class="health-bar"><span>Score</span><div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.min(100, a.avgScore)}%"></div></div><span>${a.avgScore}</span></div>
          <div class="health-bar"><span>Calidad</span><div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.min(100, calidad)}%"></div></div><span>${calidad.toFixed(0)}</span></div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <p class="hint" style="margin-bottom:14px;">Score compuesto simplificado: 40% conversión + 30% score promedio + 30% % de leads calificados. Es una referencia rápida, no una métrica oficial.</p>
    <div class="health-grid">${cards}</div>
  `;
}

const DASH_TABS = {
  hoy: dashHoy,
  dueno: dashDueno,
  embudo: dashEmbudo,
  asesores: dashAsesores,
  perdidos: dashPerdidos,
  salud: dashSalud,
  productos: () =>
    dashPlaceholder(
      '📦',
      'Sin catálogo de productos',
      'Este CRM todavía no tiene un catálogo de productos con ventas asociadas. Cuando exista, aquí verás unidades vendidas y revenue por producto.'
    ),
  anuncios: () =>
    dashPlaceholder(
      '📣',
      'Sin integración con Meta Ads',
      'El rendimiento por anuncio requiere conectar la cuenta de Meta Ads. Todavía no está integrado en este CRM.'
    ),
};

function renderDashboardTab() {
  const builder = DASH_TABS[state.dashTab] ?? dashHoy;
  dashPanelEl.innerHTML = builder(state.dashboardRows);
}

dashTabsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  state.dashTab = btn.dataset.dashTab;
  dashTabsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  renderDashboardTab();
});

// ── Render: Canales (tarjetas) ───────────────────────────────────────────────

function renderVendorCards() {
  if (!state.vendors.length) {
    vendorCardsEl.innerHTML = '<p class="muted">Todavía no tienes canales. Crea uno con “Agregar canal”.</p>';
    return;
  }

  vendorCardsEl.innerHTML = state.vendors
    .map((v) => {
      const connected = v.channel_type === 'meta' ? v.meta_verified : Boolean(v.evolution_instance_id);
      const iaActiva = Boolean(v.ai_key_set);
      const agent = state.agents.find((a) => a.id === v.assigned_agent_id);
      const keywords = v.keywords ?? [];
      const canManage = can('config.manage_channels');
      const canAi = can('config.ai_settings');

      return `
      <div class="vendor-card" data-id="${v.id}">
        <div class="vendor-card-top">
          <div class="vendor-status">
            <span class="status-pill ${connected ? 'is-on' : ''}">${connected ? 'Conectado' : 'Sin conectar'}</span>
            <span class="status-pill ${iaActiva ? 'is-on' : ''}">${iaActiva ? '⚡ IA Activa' : 'IA sin configurar'}</span>
          </div>
          <div class="vendor-card-icons">
            ${canManage ? '<button class="btn-icon js-delete-vendor" type="button" title="Eliminar canal" aria-label="Eliminar canal">🗑</button>' : ''}
          </div>
        </div>

        <div class="vendor-identity">
          <div class="avatar" style="background:${colorFor(v.id)}">${initials(v.name)}</div>
          <div>
            <div class="vendor-name">${escapeHtml(v.name)}</div>
            <div class="vendor-phone">${escapeHtml(v.phone_number) || '—'}</div>
          </div>
        </div>

        <button type="button" class="vendor-assigned ${canManage ? 'js-open-assign' : ''}" ${canManage ? '' : 'disabled'}>
          👤 ${agent ? `Asignado a <strong>${escapeHtml(agent.name)}</strong>` : 'Sin asignar'}
        </button>

        <div>
          <div class="vendor-block-label">📝 Prompt</div>
          <div class="vendor-prompt-preview">${escapeHtml(v.system_prompt) || 'Sin prompt configurado.'}</div>
        </div>

        <div>
          <div class="vendor-block-label">🏷 Palabras clave</div>
          <div class="vendor-keywords">${
            keywords.length ? keywords.map((k) => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('') : 'Sin palabras clave'
          }</div>
        </div>

        <div class="vendor-actions">
          ${canAi ? '<button type="button" class="btn js-open-settings">⚙ Configurar</button>' : ''}
          <button type="button" class="btn" disabled title="Próximamente">📊 Pixel</button>
          <button type="button" class="btn" disabled title="Próximamente">📋 Formularios</button>
          ${canManage ? '<button type="button" class="btn js-open-assign">👤 Asignar</button>' : ''}
          <button type="button" class="btn" disabled title="Próximamente">⬆ Importar</button>
          ${canManage ? '<button type="button" class="btn btn-danger js-delete-vendor">🗑 Eliminar</button>' : ''}
        </div>
      </div>`;
    })
    .join('');
}

vendorCardsEl.addEventListener('click', async (ev) => {
  const card = ev.target.closest('.vendor-card');
  if (!card) return;
  const vendorId = card.dataset.id;

  if (ev.target.closest('.js-open-settings')) {
    openSettings(vendorId);
  } else if (ev.target.closest('.js-open-assign')) {
    openAssign(vendorId);
  } else if (ev.target.closest('.js-delete-vendor')) {
    await deleteVendor(vendorId);
  }
});

async function deleteVendor(vendorId) {
  const v = state.vendors.find((x) => x.id === vendorId);
  if (!v) return;
  if (!confirm(`¿Eliminar el canal “${v.name}”? Se borrarán también sus prospectos y conversaciones.`)) return;

  const { error } = await supabase.from('vendors').delete().eq('id', vendorId);
  if (error) {
    alert(`No se pudo eliminar: ${error.message}`);
    return;
  }
  if (state.vendorId === vendorId) state.vendorId = null;
  await loadVendors();
}

// ── Render: KPIs ─────────────────────────────────────────────────────────────

function renderKpis() {
  const counts = { CALIFICADO: 0, TIBIO: 0, FRIO: 0, DESCARTADO: 0 };
  for (const p of state.prospects) {
    if (counts[p.label] !== undefined) counts[p.label]++;
  }
  document.getElementById('kpi-total').textContent = state.prospects.length;
  document.getElementById('kpi-calificado').textContent = counts.CALIFICADO;
  document.getElementById('kpi-tibio').textContent = counts.TIBIO;
  document.getElementById('kpi-frio').textContent = counts.FRIO;
  document.getElementById('kpi-descartado').textContent = counts.DESCARTADO;
}

// ── Render: tabla de prospectos ──────────────────────────────────────────────

function getFilteredSorted() {
  let rows = state.prospects;
  if (state.filter !== 'TODOS') rows = rows.filter((p) => p.label === state.filter);
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    rows = rows.filter((p) => (p.nombre || '').toLowerCase().includes(q) || (p.phone || '').includes(q));
  }
  const { sortKey, sortDir } = state;
  rows = [...rows].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (av === null || av === undefined) av = sortDir === 'asc' ? Infinity : -Infinity;
    if (bv === null || bv === undefined) bv = sortDir === 'asc' ? Infinity : -Infinity;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

function renderTable() {
  const rows = getFilteredSorted();
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Sin prospectos${state.filter !== 'TODOS' ? ' en este filtro' : ''}.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (p) => `
      <tr data-id="${p.id}">
        <td>${escapeHtml(p.nombre) || '<span style="color:var(--text-dim)">Sin nombre</span>'}</td>
        <td>${escapeHtml(p.phone)}</td>
        <td>${p.score}</td>
        <td><span class="badge badge-${p.label}">${p.label}</span></td>
        <td>${p.prioridad}</td>
        <td>${escapeHtml(p.zona) || '—'}</td>
        <td>${fmtMoney(p.presupuesto, p.presupuesto_moneda)}</td>
        <td>${escapeHtml(p.conversation_step)}</td>
        <td>${fmtDate(p.updated_at)}</td>
      </tr>`
    )
    .join('');
}

// ── Drawer: detalle + conversación ──────────────────────────────────────────

async function openDrawer(prospectOrId) {
  const p = typeof prospectOrId === 'string' ? state.prospects.find((x) => x.id === prospectOrId) : prospectOrId;
  if (!p) return;
  state.activeProspectId = p.id;
  state.activeDrawerProspect = p;

  drawerName.textContent = p.nombre || p.phone;
  prospectFacts.innerHTML = [
    ['Teléfono', p.phone],
    ['Operación', p.tipo_operacion ?? '—'],
    ['Zona', p.zona ?? '—'],
    ['Presupuesto', fmtMoney(p.presupuesto, p.presupuesto_moneda)],
    ['Inmueble', p.tipo_inmueble ?? '—'],
    ['Horizonte', p.horizonte_meses ? `${p.horizonte_meses} meses` : '—'],
    ['¿Tiene fondos?', p.tiene_fondos === null ? '—' : p.tiene_fondos ? 'Sí' : 'No'],
    ['¿Es decisor?', p.es_decisor ? 'Sí' : 'No'],
    ['Score', `${p.score}/100`],
    ['Paso', p.conversation_step],
  ]
    .map(([label, value]) => `<div class="fact-label">${label}</div><div class="fact-value">${escapeHtml(value)}</div>`)
    .join('');

  manageForm.elements['etapa'].value = p.etapa ?? '';
  manageForm.elements['etiquetas'].value = (p.etiquetas ?? []).join(', ');
  manageForm.elements['estado_conversacion'].value = p.estado_conversacion ?? 'activo';
  manageForm.elements['handled_by_agent_id'].value = p.handled_by_agent_id ?? '';
  manageStatus.textContent = '';
  manageStatus.className = 'settings-status';

  messagesThread.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Cargando conversación…</p>';
  drawerOverlay.hidden = false;

  const messages = await loadMessages(p.id);
  renderThread(messages);
  subscribeThread(p.id);
}

async function saveManage(ev) {
  ev.preventDefault();
  const p = state.activeDrawerProspect;
  if (!p) return;
  const fd = new FormData(manageForm);
  const etiquetas = (fd.get('etiquetas') || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  manageStatus.textContent = 'Guardando…';
  manageStatus.className = 'settings-status';

  const { error } = await supabase
    .from('prospects')
    .update({
      etapa: fd.get('etapa')?.toString().trim() || null,
      etiquetas,
      estado_conversacion: fd.get('estado_conversacion'),
      handled_by_agent_id: fd.get('handled_by_agent_id') || null,
    })
    .eq('id', p.id);

  if (error) {
    manageStatus.textContent = `Error: ${error.message}`;
    manageStatus.className = 'settings-status err';
    return;
  }

  manageStatus.textContent = 'Guardado ✓';
  manageStatus.className = 'settings-status ok';
  if (state.inboxRows.length) await loadInbox();
  if (state.prospects.length) await loadProspects();
}

manageForm.addEventListener('submit', saveManage);

function renderThread(messages) {
  if (!messages.length) {
    messagesThread.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Sin mensajes todavía.</p>';
    return;
  }
  messagesThread.innerHTML = messages
    .map((m) => `<div class="bubble bubble-${m.role}">${escapeHtml(m.content)}</div>`)
    .join('');
  messagesThread.scrollTop = messagesThread.scrollHeight;
}

function closeDrawer() {
  drawerOverlay.hidden = true;
  state.activeProspectId = null;
  state.activeDrawerProspect = null;
  if (state.threadChannel) {
    supabase.removeChannel(state.threadChannel);
    state.threadChannel = null;
  }
}

// ── Realtime ─────────────────────────────────────────────────────────────────

function subscribeVendor(vendorId) {
  if (state.channel) supabase.removeChannel(state.channel);
  state.channel = supabase
    .channel(`prospects-${vendorId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'prospects', filter: `vendor_id=eq.${vendorId}` },
      () => loadProspects()
    )
    .subscribe();
}

function subscribeThread(prospectId) {
  if (state.threadChannel) supabase.removeChannel(state.threadChannel);
  state.threadChannel = supabase
    .channel(`messages-${prospectId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `prospect_id=eq.${prospectId}` },
      async () => {
        const messages = await loadMessages(prospectId);
        renderThread(messages);
      }
    )
    .subscribe();
}

// ── Chat de canal (3 paneles: contactos | conversación | info del cliente) ───

async function loadChannel(vendorId) {
  closeChannelThread();
  state.channelVendorId = vendorId;
  state.channelTab = 'chats';
  state.channelSearch = '';
  channelSearchInput.value = '';
  document.querySelectorAll('.channel-list-tabs .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.channelTab === 'chats'));

  channelContactsEl.innerHTML = '<p class="muted" style="padding:16px;">Cargando…</p>';
  await refreshChannelProspects(vendorId);
  subscribeChannelProspects(vendorId);
}

// A diferencia de loadChannel, esto NO reinicia pestaña/búsqueda ni cierra la
// conversación abierta — lo usa el listener de Realtime en cada cambio (etapa,
// ia_enabled, nuevo mensaje que toca updated_at, etc.) para no interrumpir al
// usuario a mitad de una edición.
async function refreshChannelProspects(vendorId) {
  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .eq('vendor_id', vendorId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Error cargando chats del canal:', error.message);
    channelContactsEl.innerHTML = '<p class="muted" style="padding:16px;">Error cargando conversaciones.</p>';
    return;
  }

  state.channelProspects = data ?? [];
  renderChannelContacts();

  if (state.channelActiveProspectId) {
    const p = state.channelProspects.find((x) => x.id === state.channelActiveProspectId);
    if (p) {
      setPerfilChip(p.perfil);
      setEtapaChip(p.etapa);
      setIaToggleUI(p.ia_enabled);
      setEstadoPill(p.estado_conversacion);
      setTempMeter(p.score, p.label);
      state.ciCalif = {
        necesidad: p.calif_necesidad ?? null,
        inversion: p.calif_inversion ?? null,
        urgencia: p.calif_urgencia ?? null,
        autoridad: p.calif_autoridad ?? null,
      };
      setAllCalifUI();
      state.ciCustomValues = { ...(p.custom_field_values ?? {}) };
      renderCustomFields();
    }
  }
}

function getFilteredChannelProspects() {
  let rows = state.channelProspects;
  rows = rows.filter((r) => (state.channelTab === 'chats' ? r.estado_conversacion === 'activo' : r.estado_conversacion !== 'activo'));
  if (state.channelSearch.trim()) {
    const q = state.channelSearch.trim().toLowerCase();
    rows = rows.filter((r) => (r.nombre || '').toLowerCase().includes(q) || (r.phone || '').includes(q));
  }
  return rows;
}

function renderChannelContacts() {
  const rows = getFilteredChannelProspects();
  if (!rows.length) {
    channelContactsEl.innerHTML = '<p class="muted" style="padding:16px;">Sin conversaciones para este filtro.</p>';
    return;
  }
  channelContactsEl.innerHTML = rows
    .map((r) => {
      const name = r.nombre || r.phone;
      const tags = [
        r.etapa ? `<span class="tag-pill tag-etapa">${escapeHtml(r.etapa)}</span>` : '',
        `<span class="tag-pill tag-${r.estado_conversacion}">${escapeHtml(r.estado_conversacion)}</span>`,
      ].join('');
      return `
      <div class="channel-contact-row ${r.id === state.channelActiveProspectId ? 'is-active' : ''}" data-id="${r.id}">
        <div class="avatar" style="background:${colorFor(r.phone)}">${initials(name)}</div>
        <div class="channel-contact-main">
          <div class="channel-contact-top">
            <span class="channel-contact-name">${escapeHtml(name)}</span>
            <span class="channel-contact-date">${fmtDate(r.updated_at)}</span>
          </div>
          <div class="channel-contact-preview">Score ${r.score ?? 0} · ${escapeHtml(r.conversation_step ?? '')}</div>
          <div class="channel-contact-tags">${tags}</div>
        </div>
      </div>`;
    })
    .join('');
}

async function openChannelProspect(prospectId) {
  const p = state.channelProspects.find((x) => x.id === prospectId);
  if (!p) return;
  state.channelActiveProspectId = prospectId;
  renderChannelContacts();

  channelThreadEmptyEl.hidden = true;
  channelThreadEl.hidden = false;
  channelInfoPane.hidden = false;

  const name = p.nombre || p.phone;
  ctAvatar.textContent = initials(name);
  ctAvatar.style.background = colorFor(p.phone);
  ctName.textContent = name;
  ctPhone.textContent = `📞 +${p.phone}`;
  ctPhone.hidden = false;
  setPerfilChip(p.perfil);
  setEtapaChip(p.etapa);
  setIaToggleUI(p.ia_enabled);
  closeCtDropdowns();

  setEstadoPill(p.estado_conversacion);
  setTempMeter(p.score, p.label);
  ciAgent.value = p.handled_by_agent_id ?? '';
  state.ciTags = (p.etiquetas ?? []).slice();
  renderCiTags();
  state.ciCalif = {
    necesidad: p.calif_necesidad ?? null,
    inversion: p.calif_inversion ?? null,
    urgencia: p.calif_urgencia ?? null,
    autoridad: p.calif_autoridad ?? null,
  };
  setAllCalifUI();
  state.ciCustomValues = { ...(p.custom_field_values ?? {}) };
  renderCustomFields();
  ciZona.value = p.zona ?? '';
  ciPresupuesto.value = p.presupuesto ?? '';
  ciNotas.value = p.notas ?? '';
  ciStatus.textContent = '';
  ciStatus.className = 'settings-status';

  channelThreadBodyEl.innerHTML = '<p class="muted">Cargando conversación…</p>';
  const messages = await loadMessages(prospectId);
  renderChannelThread(messages);
  subscribeChannelThread(prospectId);
}

function closeChannelThread() {
  state.channelActiveProspectId = null;
  channelThreadEmptyEl.hidden = false;
  channelThreadEl.hidden = true;
  channelInfoPane.hidden = true;
  if (state.channelThreadRealtime) {
    supabase.removeChannel(state.channelThreadRealtime);
    state.channelThreadRealtime = null;
  }
}

function renderMessageContent(m) {
  const caption = m.content ? `<div class="media-caption">${escapeHtml(m.content)}</div>` : '';
  switch (m.media_type) {
    case 'image':
      return `<img src="${escapeHtml(m.media_url)}" alt="Imagen" />${caption}`;
    case 'video':
      return `<video src="${escapeHtml(m.media_url)}" controls></video>${caption}`;
    case 'audio':
      return `<audio src="${escapeHtml(m.media_url)}" controls></audio>${caption}`;
    case 'document':
      return `<a class="media-doc-link" href="${escapeHtml(m.media_url)}" target="_blank" rel="noopener">📎 ${escapeHtml(m.content || 'Archivo adjunto')}</a>`;
    default:
      return escapeHtml(m.content);
  }
}

function renderChannelThread(messages) {
  if (!messages.length) {
    channelThreadBodyEl.innerHTML = '<p class="muted">Sin mensajes todavía.</p>';
    return;
  }
  channelThreadBodyEl.innerHTML = messages.map((m) => `<div class="bubble bubble-${m.role}">${renderMessageContent(m)}</div>`).join('');
  channelThreadBodyEl.scrollTop = channelThreadBodyEl.scrollHeight;
}

function setIaToggleUI(enabled) {
  ctIaToggle.textContent = enabled ? '🤖 IA On' : '🤖 IA Off';
  ctIaToggle.classList.toggle('is-on', enabled);
  ctIaToggle.classList.toggle('is-off', !enabled);
}

// ── Chips del header: Perfil y Etapa (dropdowns con check de selección) ──────

function getPerfilOptions() {
  const known = new Set(PERFIL_OPTIONS.map((o) => o.value));
  const custom = [...new Set(state.channelProspects.map((p) => p.perfil).filter(Boolean))]
    .filter((v) => !known.has(v))
    .map((v) => ({ value: v, label: v, color: '#8a8f98' }));
  return [...PERFIL_OPTIONS, ...custom];
}

function setPerfilChip(value) {
  const opt = getPerfilOptions().find((o) => o.value === value) ?? PERFIL_OPTIONS[0];
  ctPerfilDot.style.background = opt.color;
  ctPerfilLabel.textContent = opt.label;
}

function renderPerfilPanel(current) {
  const rows = getPerfilOptions()
    .map(
      (o) => `
    <div class="ct-option" data-value="${escapeHtml(o.value)}">
      <span class="ct-dot" style="background:${o.color}"></span>
      <span>${escapeHtml(o.label)}</span>
      ${o.value === current ? '<span class="ct-check">✓</span>' : ''}
    </div>`
    )
    .join('');
  ctPerfilPanel.innerHTML = `${rows}<div class="ct-dropdown-sep"></div><div class="ct-option ct-option-add" data-add-perfil="1">+ Agregar perfil</div>`;
}

function setEtapaChip(value) {
  const opt = ETAPA_OPTIONS.find((o) => o.value === (value ?? '')) ?? ETAPA_OPTIONS[0];
  ctEtapaIcon.textContent = opt.icon;
  ctEtapaLabel.textContent = opt.label;
  ctEtapaTrigger.classList.toggle('ct-chip-tinted', Boolean(value));
  ctEtapaTrigger.style.setProperty('--tint', opt.color);
}

function renderEtapaPanel(current) {
  ctEtapaPanel.innerHTML = ETAPA_OPTIONS.filter((o) => o.value)
    .map(
      (o) => `
    <div class="ct-option" data-value="${o.value}">
      <span>${o.icon}</span>
      <span style="color:${o.color}">${escapeHtml(o.label)}</span>
      ${o.value === (current ?? '') ? '<span class="ct-check">✓</span>' : ''}
    </div>`
    )
    .join('');
}

// ── Panel "Info del cliente": estado, temperatura y etiquetas ────────────────

const ESTADO_PILL_COPY = {
  activo: { label: 'Activo', cls: 'status-activo' },
  inactivo: { label: 'Inactivo', cls: 'status-inactivo' },
  cerrado: { label: 'Cerrado', cls: 'status-cerrado' },
};

function setEstadoPill(estado) {
  const copy = ESTADO_PILL_COPY[estado] ?? ESTADO_PILL_COPY.activo;
  ciEstadoPill.innerHTML = `<span class="ci-status-dot"></span>${copy.label}`;
  ciEstadoPill.className = `ci-status-pill ${copy.cls}`;
}

const TEMP_LABEL_COLORS = { FRIO: 'var(--cold)', TIBIO: 'var(--warn)', CALIFICADO: 'var(--ok)', DESCARTADO: 'var(--off)' };

function setTempMeter(score, label) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  const key = label || 'FRIO';
  const color = TEMP_LABEL_COLORS[key] ?? TEMP_LABEL_COLORS.FRIO;
  ciTempLabel.textContent = key;
  ciTempLabel.style.color = color;
  ciTempScore.textContent = `${s}/100`;
  ciTempFill.style.width = `${s}%`;
  ciTempFill.style.background = color;
}

function renderCiTags() {
  ciTagsList.innerHTML = state.ciTags
    .map(
      (t, i) => `
    <span class="ci-tag">${escapeHtml(t)}<button type="button" class="ci-tag-remove" data-idx="${i}" aria-label="Quitar etiqueta">✕</button></span>`
    )
    .join('');
}

ciTagsList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.ci-tag-remove');
  if (!btn) return;
  state.ciTags.splice(Number(btn.dataset.idx), 1);
  renderCiTags();
});

function showCiTagInput() {
  ciTagsAddBtn.hidden = true;
  ciTagInput.hidden = false;
  ciTagInput.value = '';
  ciTagInput.focus();
}

function commitCiTagInput() {
  const value = ciTagInput.value.trim();
  if (value && !state.ciTags.includes(value)) {
    state.ciTags.push(value);
    renderCiTags();
  }
  ciTagInput.hidden = true;
  ciTagsAddBtn.hidden = false;
}

ciTagsAddBtn.addEventListener('click', showCiTagInput);
ciTagInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    commitCiTagInput();
  } else if (ev.key === 'Escape') {
    ciTagInput.hidden = true;
    ciTagsAddBtn.hidden = false;
  }
});
ciTagInput.addEventListener('blur', commitCiTagInput);

// Rúbrica de calificación (Necesidad/Inversión/Urgencia/Autoridad): evaluación
// manual del asesor, independiente del score/label que calcula la IA.
const CALIF_RUBRIC = {
  necesidad: {
    max: 25,
    options: [
      { points: 25, label: 'Resolverlo ya' },
      { points: 20, label: 'Resolverlo pronto' },
      { points: 12, label: 'Mejorar / optimizar' },
      { points: 6, label: 'Estoy comparando opciones' },
      { points: 2, label: 'Solo info por ahora' },
    ],
  },
  inversion: {
    max: 30,
    options: [
      { points: 30, label: 'Presupuesto listo' },
      { points: 24, label: 'Tengo presupuesto, solo elijo' },
      { points: 14, label: 'Tengo presupuesto, pero ajusto según propuesta' },
      { points: 7, label: 'Depende de otra persona / situación' },
      { points: 2, label: 'Solo cotizo' },
    ],
  },
  urgencia: {
    max: 25,
    options: [
      { points: 25, label: '0–7 días' },
      { points: 20, label: '8–30 días' },
      { points: 12, label: '1–3 meses' },
      { points: 6, label: '3–6 meses' },
      { points: 2, label: 'Sin fecha' },
    ],
  },
  autoridad: {
    max: 20,
    options: [
      { points: 20, label: 'Yo decido' },
      { points: 14, label: 'Decidimos 2' },
      { points: 6, label: 'Yo influyo, decide otra persona' },
      { points: 2, label: 'Solo recopilo info' },
    ],
  },
};

function findCalifLabel(key, points) {
  return CALIF_RUBRIC[key].options.find((o) => o.points === points)?.label ?? 'Sin calificar';
}

function renderCalifOptions(key) {
  const container = document.querySelector(`[data-calif-options="${key}"]`);
  const current = state.ciCalif[key];
  container.innerHTML = CALIF_RUBRIC[key].options
    .map(
      (o) => `
    <div class="ci-calif-option ${o.points === current ? 'is-selected' : ''}" data-points="${o.points}">
      <span>${escapeHtml(o.label)}</span>
      <span class="ci-calif-option-points">+${o.points}</span>
    </div>`
    )
    .join('');
}

function setCalifUI(key) {
  const points = state.ciCalif[key];
  document.querySelector(`[data-calif-label="${key}"]`).textContent = points == null ? 'Sin calificar' : findCalifLabel(key, points);
  document.querySelector(`[data-calif-max="${key}"]`).textContent = `${points ?? 0}/${CALIF_RUBRIC[key].max}`;
  renderCalifOptions(key);
}

function setAllCalifUI() {
  Object.keys(CALIF_RUBRIC).forEach(setCalifUI);
}

document.querySelectorAll('.ci-calif-select').forEach((detailsEl) => {
  const key = detailsEl.dataset.calif;
  detailsEl.addEventListener('toggle', () => {
    if (detailsEl.open) renderCalifOptions(key);
  });
  detailsEl.querySelector('.ci-calif-options').addEventListener('click', (ev) => {
    const opt = ev.target.closest('.ci-calif-option[data-points]');
    if (!opt) return;
    state.ciCalif[key] = Number(opt.dataset.points);
    setCalifUI(key);
    detailsEl.open = false;
  });
});

// Campos personalizados: la DEFINICIÓN (nombre/tipo/opciones) vive en
// state.customFields y es global — la crea "+ Agregar" y aparece en el panel
// de cualquier chat de cualquier canal. El VALOR de cada campo sí es propio
// de cada prospecto (state.ciCustomValues, persistido en
// prospects.custom_field_values junto al resto del formulario).
const CUSTOM_FIELD_TYPES = [
  { value: 'text', icon: 'T', label: 'Texto', desc: 'Campo de texto simple' },
  { value: 'number', icon: '#', label: 'Número', desc: 'Solo valores numéricos' },
  { value: 'date', icon: '📅', label: 'Fecha', desc: 'Selector de fecha' },
  { value: 'select', icon: '☰', label: 'Lista desplegable', desc: 'Selección única de opciones' },
  { value: 'multiselect', icon: '☑', label: 'Selección múltiple', desc: 'Múltiples opciones' },
  { value: 'checkbox', icon: '◻', label: 'Casilla', desc: 'Sí o No' },
  { value: 'textarea', icon: '📝', label: 'Texto largo', desc: 'Área de texto expandida' },
  { value: 'email', icon: '✉️', label: 'Email', desc: 'Dirección de correo' },
  { value: 'phone', icon: '📞', label: 'Teléfono', desc: 'Número telefónico' },
  { value: 'url', icon: '🔗', label: 'URL', desc: 'Enlace web' },
];

function cfType(value) {
  return CUSTOM_FIELD_TYPES.find((t) => t.value === value) ?? CUSTOM_FIELD_TYPES[0];
}

function renderCustomFieldInput(field) {
  const value = state.ciCustomValues[field.id];
  const t = field.field_type;

  if (t === 'select') {
    const opts = (field.options ?? [])
      .map((o) => `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`)
      .join('');
    return `<select data-cf-input="${field.id}"><option value="">Seleccionar…</option>${opts}</select>`;
  }
  if (t === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    const opts = (field.options ?? [])
      .map(
        (o) => `
      <label class="ci-cf-check-row">
        <input type="checkbox" data-cf-input="${field.id}" value="${escapeHtml(o)}" ${selected.includes(o) ? 'checked' : ''} />
        ${escapeHtml(o)}
      </label>`
      )
      .join('');
    return `<div class="ci-cf-checklist">${opts || '<p class="hint">Sin opciones configuradas.</p>'}</div>`;
  }
  if (t === 'checkbox') {
    return `<label class="ci-cf-check-row"><input type="checkbox" data-cf-input="${field.id}" ${value ? 'checked' : ''} /> Sí</label>`;
  }
  if (t === 'textarea') {
    return `<textarea data-cf-input="${field.id}" rows="3">${escapeHtml(value ?? '')}</textarea>`;
  }
  const inputType = { number: 'number', date: 'date', email: 'email', phone: 'tel', url: 'url' }[t] ?? 'text';
  return `<input type="${inputType}" data-cf-input="${field.id}" value="${escapeHtml(value ?? '')}" />`;
}

function renderCustomFields() {
  if (!state.customFields.length) {
    ciCustomFieldsList.innerHTML = '';
    return;
  }
  ciCustomFieldsList.innerHTML = state.customFields
    .map(
      (f) => `
    <div class="ci-cf-field">
      <div class="ci-cf-header">
        <span class="ci-drag">⠿</span>
        <span class="ci-cf-icon">${cfType(f.field_type).icon}</span>
        <span>${escapeHtml(f.name)}${f.required ? ' *' : ''}</span>
      </div>
      ${renderCustomFieldInput(f)}
      ${f.help_text ? `<span class="hint ci-cf-help">${escapeHtml(f.help_text)}</span>` : ''}
    </div>`
    )
    .join('');
}

function readCiCustomValue(fieldId) {
  const field = state.customFields.find((f) => f.id === fieldId);
  if (!field) return;
  if (field.field_type === 'multiselect') {
    state.ciCustomValues[fieldId] = [...ciCustomFieldsList.querySelectorAll(`[data-cf-input="${fieldId}"]:checked`)].map((c) => c.value);
    return;
  }
  const el = ciCustomFieldsList.querySelector(`[data-cf-input="${fieldId}"]`);
  if (!el) return;
  state.ciCustomValues[fieldId] = field.field_type === 'checkbox' ? el.checked : el.value;
}

['input', 'change'].forEach((evt) =>
  ciCustomFieldsList.addEventListener(evt, (ev) => {
    const el = ev.target.closest('[data-cf-input]');
    if (!el) return;
    readCiCustomValue(el.dataset.cfInput);
  })
);

ciCustomFieldAddBtn.addEventListener('click', () => {
  customfieldForm.reset();
  cfOptionsGroup.hidden = true;
  setCfTypeUI('text');
  customfieldStatus.textContent = '';
  customfieldStatus.className = 'settings-status';
  customfieldOverlay.hidden = false;
});
document.getElementById('customfield-modal-close').addEventListener('click', () => (customfieldOverlay.hidden = true));
document.getElementById('customfield-cancel-btn').addEventListener('click', () => (customfieldOverlay.hidden = true));
customfieldOverlay.addEventListener('click', (ev) => {
  if (ev.target === customfieldOverlay) customfieldOverlay.hidden = true;
});

function setCfTypeUI(value) {
  const t = cfType(value);
  cfTypeValue.value = t.value;
  cfTypeTriggerIcon.textContent = t.icon;
  cfTypeTriggerLabel.textContent = t.label;
  cfOptionsGroup.hidden = t.value !== 'select' && t.value !== 'multiselect';
}

function renderCfTypePanel() {
  cfTypePanel.innerHTML = CUSTOM_FIELD_TYPES.map(
    (t) => `
    <div class="ct-option cf-type-option" data-value="${t.value}">
      <span class="cf-type-option-icon">${t.icon}</span>
      <span class="cf-type-option-text"><strong>${escapeHtml(t.label)}</strong><span class="hint">${escapeHtml(t.desc)}</span></span>
      ${t.value === cfTypeValue.value ? '<span class="ct-check">✓</span>' : ''}
    </div>`
  ).join('');
}

cfTypeTrigger.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = cfTypePanel.hidden;
  closeCtDropdowns();
  if (willOpen) renderCfTypePanel();
  cfTypePanel.hidden = !willOpen;
});
cfTypePanel.addEventListener('click', (ev) => {
  const opt = ev.target.closest('.cf-type-option[data-value]');
  if (!opt) return;
  cfTypePanel.hidden = true;
  setCfTypeUI(opt.dataset.value);
});

async function createCustomField(ev) {
  ev.preventDefault();
  const fd = new FormData(customfieldForm);
  const name = fd.get('name')?.toString().trim();
  const fieldType = fd.get('field_type')?.toString() || 'text';
  const needsOptions = fieldType === 'select' || fieldType === 'multiselect';
  const options = needsOptions
    ? fd
        .get('options_raw')
        ?.toString()
        .split('\n')
        .map((o) => o.trim())
        .filter(Boolean)
    : null;

  if (!name) {
    customfieldStatus.textContent = 'El nombre del campo es obligatorio.';
    customfieldStatus.className = 'settings-status err';
    return;
  }
  if (needsOptions && !options?.length) {
    customfieldStatus.textContent = 'Agrega al menos una opción.';
    customfieldStatus.className = 'settings-status err';
    return;
  }

  customfieldStatus.textContent = 'Creando…';
  customfieldStatus.className = 'settings-status';

  const { error } = await supabase.from('custom_fields').insert({
    name,
    field_type: fieldType,
    help_text: fd.get('help_text')?.toString().trim() || null,
    required: fd.get('required') === 'on',
    options,
  });

  if (error) {
    customfieldStatus.textContent = `Error: ${error.message}`;
    customfieldStatus.className = 'settings-status err';
    return;
  }

  customfieldStatus.textContent = 'Campo creado ✓';
  customfieldStatus.className = 'settings-status ok';
  await loadCustomFields();
  customfieldForm.reset();
  setTimeout(() => (customfieldOverlay.hidden = true), 500);
}
customfieldForm.addEventListener('submit', createCustomField);

function closeCtDropdowns(except) {
  document.querySelectorAll('.ct-dropdown-panel').forEach((p) => {
    if (p !== except) p.hidden = true;
  });
}

async function updateActiveProspect(fields) {
  const prospectId = state.channelActiveProspectId;
  if (!prospectId) return;
  const { error } = await supabase.from('prospects').update(fields).eq('id', prospectId);
  if (error) {
    alert(`No se pudo guardar: ${error.message}`);
    return;
  }
  const p = state.channelProspects.find((x) => x.id === prospectId);
  if (p) Object.assign(p, fields);
}

function subscribeChannelProspects(vendorId) {
  if (state.channelProspectsRealtime) supabase.removeChannel(state.channelProspectsRealtime);
  state.channelProspectsRealtime = supabase
    .channel(`channel-prospects-${vendorId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prospects', filter: `vendor_id=eq.${vendorId}` }, () => refreshChannelProspects(vendorId))
    .subscribe();
}

function subscribeChannelThread(prospectId) {
  if (state.channelThreadRealtime) supabase.removeChannel(state.channelThreadRealtime);
  state.channelThreadRealtime = supabase
    .channel(`channel-messages-${prospectId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `prospect_id=eq.${prospectId}` }, async () => {
      const messages = await loadMessages(prospectId);
      renderChannelThread(messages);
    })
    .subscribe();
}

async function callSendMessage(payload) {
  const resp = await fetch(`${FUNCTIONS_URL}/send-message`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  const json = await resp.json();
  if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);
  const messages = await loadMessages(payload.prospect_id);
  renderChannelThread(messages);
}

async function sendChannelMessage(ev) {
  ev.preventDefault();
  const text = channelComposerInput.value.trim();
  const prospectId = state.channelActiveProspectId;
  if (!text || !prospectId) return;

  channelComposerInput.value = '';
  channelComposerInput.disabled = true;

  try {
    await callSendMessage({ prospect_id: prospectId, text });
  } catch (err) {
    alert(`No se pudo enviar el mensaje: ${err.message}`);
    channelComposerInput.value = text;
  } finally {
    channelComposerInput.disabled = false;
    channelComposerInput.focus();
  }
}

// ── Composer: emojis, adjuntar y nota de voz ─────────────────────────────────

const EMOJI_LIST = [
  ['😀', 'sonrisa feliz'], ['😁', 'sonrisa feliz'], ['😂', 'risa lagrimas'], ['🤣', 'risa'], ['😊', 'sonrisa'],
  ['😍', 'enamorado corazon ojos'], ['🥰', 'enamorado'], ['😘', 'beso'], ['😉', 'guino'], ['😎', 'lentes cool'],
  ['🤔', 'pensando'], ['😅', 'nervioso'], ['😢', 'triste llorar'], ['😭', 'llorar fuerte'], ['😡', 'enojado'],
  ['😱', 'sorpresa grito'], ['😴', 'dormir'], ['🙄', 'ojos en blanco'], ['🙂', 'sonrisa leve'], ['😐', 'neutral'],
  ['👍', 'bien pulgar arriba'], ['👎', 'mal pulgar abajo'], ['👏', 'aplauso'], ['🙏', 'gracias por favor rezar'], ['💪', 'fuerza brazo'],
  ['🤝', 'trato mano'], ['👋', 'hola saludo'], ['✌️', 'paz victoria'], ['🤞', 'suerte dedos'], ['👌', 'ok perfecto'],
  ['❤️', 'amor corazon'], ['💙', 'corazon azul'], ['💚', 'corazon verde'], ['💛', 'corazon amarillo'], ['🧡', 'corazon naranja'],
  ['💜', 'corazon morado'], ['🔥', 'fuego genial'], ['⭐', 'estrella'], ['✨', 'brillos'], ['🎉', 'fiesta celebracion'],
  ['🎊', 'confeti'], ['✅', 'listo check'], ['❌', 'no equis'], ['⚠️', 'alerta advertencia'], ['❓', 'pregunta'],
  ['❗', 'exclamacion importante'], ['💯', 'cien puntos'], ['🕐', 'hora reloj'], ['📅', 'calendario fecha'], ['📍', 'ubicacion'],
  ['🏠', 'casa'], ['🏢', 'edificio oficina'], ['🏗️', 'construccion obra'], ['🌆', 'ciudad'], ['🚗', 'auto carro'],
  ['💰', 'dinero plata'], ['💵', 'billete dolar'], ['💳', 'tarjeta pago'], ['📈', 'crece grafico'], ['📉', 'baja grafico'],
  ['📊', 'grafico estadistica'], ['🏦', 'banco'], ['🔑', 'llave'], ['📞', 'telefono llamada'], ['📱', 'celular whatsapp'],
  ['✉️', 'sobre correo mensaje'], ['📧', 'email'], ['📎', 'clip archivo adjunto'], ['📄', 'documento archivo'], ['📝', 'nota escribir'],
  ['📷', 'camara foto'], ['🎥', 'video camara'], ['🎬', 'video pelicula'], ['🎤', 'microfono audio'], ['📦', 'paquete caja'],
  ['🛒', 'carrito compra venta'], ['🛍️', 'bolsas compras'], ['🎁', 'regalo'], ['🏆', 'trofeo premio'], ['🚀', 'cohete rapido'],
  ['⏰', 'alarma despertador'], ['⌛', 'tiempo espera'], ['🌟', 'destacado'], ['💡', 'idea foco'], ['📌', 'pin fijar'],
  ['👀', 'ojos mirar'], ['🙌', 'manos arriba celebrar'], ['🤗', 'abrazo'], ['😇', 'angel bueno'], ['🥳', 'fiesta celebracion cara'],
];

function renderEmojiGrid(query = '') {
  const q = query.trim().toLowerCase();
  const filtered = q ? EMOJI_LIST.filter(([, names]) => names.includes(q)) : EMOJI_LIST;
  composerEmojiGrid.innerHTML =
    filtered.map(([e]) => `<button type="button" data-emoji="${e}">${e}</button>`).join('') ||
    '<p class="muted" style="grid-column:1/-1;padding:8px;">Sin resultados.</p>';
}

composerEmojiBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = composerEmojiPanel.hidden;
  closeCtDropdowns();
  if (willOpen) {
    composerEmojiSearch.value = '';
    renderEmojiGrid();
  }
  composerEmojiPanel.hidden = !willOpen;
});
composerEmojiSearch.addEventListener('input', () => renderEmojiGrid(composerEmojiSearch.value));
composerEmojiGrid.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-emoji]');
  if (!btn) return;
  const start = channelComposerInput.selectionStart ?? channelComposerInput.value.length;
  const end = channelComposerInput.selectionEnd ?? channelComposerInput.value.length;
  const val = channelComposerInput.value;
  channelComposerInput.value = val.slice(0, start) + btn.dataset.emoji + val.slice(end);
  const cursor = start + btn.dataset.emoji.length;
  channelComposerInput.focus();
  channelComposerInput.setSelectionRange(cursor, cursor);
});

function setComposerStatus(text, isError = false) {
  if (!text) {
    composerStatus.hidden = true;
    composerStatus.textContent = '';
    return;
  }
  composerStatus.hidden = false;
  composerStatus.textContent = text;
  composerStatus.className = isError ? 'composer-status err' : 'composer-status';
}

async function uploadAndSendMedia(file, mediaType, caption = '') {
  const prospectId = state.channelActiveProspectId;
  if (!prospectId) return;

  setComposerStatus(`Subiendo ${file.name}…`);
  try {
    const ext = file.name.includes('.') ? file.name.split('.').pop() : mediaType;
    // Prefijo de empresa: la política de subida solo permite la propia.
    const path = `${state.me.organization.id}/${prospectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('chat-media').upload(path, file, { contentType: file.type || undefined });
    if (uploadError) throw new Error(`No se pudo subir el archivo: ${uploadError.message}`);

    const { data: pub } = supabase.storage.from('chat-media').getPublicUrl(path);
    setComposerStatus('Enviando…');
    await callSendMessage({
      prospect_id: prospectId,
      text: caption,
      media_url: pub.publicUrl,
      media_type: mediaType,
      file_name: file.name,
    });
    setComposerStatus('');
  } catch (err) {
    setComposerStatus(err.message, true);
  }
}

composerAttachBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = composerAttachPanel.hidden;
  closeCtDropdowns();
  composerAttachPanel.hidden = !willOpen;
});
composerAttachPanel.addEventListener('click', (ev) => {
  const opt = ev.target.closest('.ct-option[data-attach]');
  if (!opt) return;
  composerAttachPanel.hidden = true;
  const type = opt.dataset.attach;
  composerFileInput.accept = type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : '*/*';
  composerFileInput.dataset.mediaType = type;
  composerFileInput.click();
});
composerFileInput.addEventListener('change', () => {
  const file = composerFileInput.files?.[0];
  const mediaType = composerFileInput.dataset.mediaType;
  composerFileInput.value = '';
  if (!file || !state.channelActiveProspectId) return;
  const caption = channelComposerInput.value.trim();
  channelComposerInput.value = '';
  uploadAndSendMedia(file, mediaType, caption);
});

function pickAudioMimeType() {
  const candidates = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
}

async function toggleAudioRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.stop();
    return;
  }
  if (!state.channelActiveProspectId) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert('Este navegador no soporta grabar audio.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickAudioMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.recordingChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.recordingChunks.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      composerMicBtn.classList.remove('is-recording');
      const blob = new Blob(state.recordingChunks, { type: recorder.mimeType || 'audio/ogg' });
      const ext = (recorder.mimeType || '').includes('webm') ? 'webm' : 'ogg';
      const file = new File([blob], `nota-de-voz.${ext}`, { type: blob.type });
      await uploadAndSendMedia(file, 'audio');
    };
    recorder.start();
    state.mediaRecorder = recorder;
    composerMicBtn.classList.add('is-recording');
  } catch (err) {
    alert(`No se pudo acceder al micrófono: ${err.message}`);
  }
}

composerMicBtn.addEventListener('click', toggleAudioRecording);

async function saveChannelInfo(ev) {
  ev.preventDefault();
  const prospectId = state.channelActiveProspectId;
  if (!prospectId) return;

  ciStatus.textContent = 'Guardando…';
  ciStatus.className = 'settings-status';

  const { error } = await supabase
    .from('prospects')
    .update({
      etiquetas: state.ciTags,
      handled_by_agent_id: ciAgent.value || null,
      zona: ciZona.value.trim() || null,
      presupuesto: ciPresupuesto.value ? Number(ciPresupuesto.value) : null,
      notas: ciNotas.value.trim(),
      calif_necesidad: state.ciCalif.necesidad,
      calif_inversion: state.ciCalif.inversion,
      calif_urgencia: state.ciCalif.urgencia,
      calif_autoridad: state.ciCalif.autoridad,
      custom_field_values: state.ciCustomValues,
    })
    .eq('id', prospectId);

  if (error) {
    ciStatus.textContent = `Error: ${error.message}`;
    ciStatus.className = 'settings-status err';
    return;
  }
  ciStatus.textContent = 'Guardado ✓';
  ciStatus.className = 'settings-status ok';
}

channelSearchInput.addEventListener('input', () => {
  state.channelSearch = channelSearchInput.value;
  renderChannelContacts();
});
document.querySelector('.channel-list-tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  state.channelTab = btn.dataset.channelTab;
  document.querySelectorAll('.channel-list-tabs .chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  renderChannelContacts();
});
channelContactsEl.addEventListener('click', (ev) => {
  const row = ev.target.closest('.channel-contact-row');
  if (!row) return;
  openChannelProspect(row.dataset.id);
});
channelComposer.addEventListener('submit', sendChannelMessage);
channelInfoForm.addEventListener('submit', saveChannelInfo);

ctPerfilTrigger.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = ctPerfilPanel.hidden;
  closeCtDropdowns();
  if (willOpen) {
    const p = state.channelProspects.find((x) => x.id === state.channelActiveProspectId);
    renderPerfilPanel(p?.perfil ?? 'nuevo');
  }
  ctPerfilPanel.hidden = !willOpen;
});
ctPerfilPanel.addEventListener('click', async (ev) => {
  const addBtn = ev.target.closest('[data-add-perfil]');
  if (addBtn) {
    const name = prompt('Nombre del nuevo perfil:');
    const value = name?.trim();
    if (!value) return;
    ctPerfilPanel.hidden = true;
    await updateActiveProspect({ perfil: value });
    setPerfilChip(value);
    return;
  }
  const opt = ev.target.closest('.ct-option[data-value]');
  if (!opt) return;
  ctPerfilPanel.hidden = true;
  await updateActiveProspect({ perfil: opt.dataset.value });
  setPerfilChip(opt.dataset.value);
});

ctEtapaTrigger.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const willOpen = ctEtapaPanel.hidden;
  closeCtDropdowns();
  if (willOpen) {
    const p = state.channelProspects.find((x) => x.id === state.channelActiveProspectId);
    renderEtapaPanel(p?.etapa ?? '');
  }
  ctEtapaPanel.hidden = !willOpen;
});
ctEtapaPanel.addEventListener('click', async (ev) => {
  const opt = ev.target.closest('.ct-option[data-value]');
  if (!opt) return;
  ctEtapaPanel.hidden = true;
  await updateActiveProspect({ etapa: opt.dataset.value });
  setEtapaChip(opt.dataset.value);
});

document.addEventListener('click', (ev) => {
  const path = ev.composedPath ? ev.composedPath() : [];
  const insideCtDropdown = path.some((el) => el.classList?.contains('ct-dropdown'));
  if (!insideCtDropdown) closeCtDropdowns();
});

ctIaToggle.addEventListener('click', async () => {
  const prospectId = state.channelActiveProspectId;
  const p = state.channelProspects.find((x) => x.id === prospectId);
  if (!p) return;
  const next = !p.ia_enabled;
  setIaToggleUI(next);
  const { error } = await supabase.from('prospects').update({ ia_enabled: next }).eq('id', prospectId);
  if (error) {
    setIaToggleUI(p.ia_enabled);
    alert(`No se pudo cambiar el estado de la IA: ${error.message}`);
  }
});

// ── Configuración del canal (IA + palabras clave) ────────────────────────────

function openSettings(vendorId) {
  const v = state.vendors.find((x) => x.id === vendorId);
  if (!v) return;
  state.configVendorId = vendorId;
  settingsTitle.textContent = `Configuración · ${v.name}`;
  settingsForm.elements['ai_provider'].value = v.ai_provider;
  settingsForm.elements['ai_model'].value = v.ai_model ?? '';
  settingsForm.elements['ai_api_key'].value = '';
  settingsForm.elements['keywords'].value = (v.keywords ?? []).join(', ');
  settingsForm.elements['system_prompt'].value = v.system_prompt ?? '';
  settingsStatus.textContent = '';
  settingsStatus.className = 'settings-status';
  settingsOverlay.hidden = false;
}

async function saveSettings(ev) {
  ev.preventDefault();
  const fd = new FormData(settingsForm);
  const vendorId = state.configVendorId;

  // Palabras clave se guardan directo en `vendors` (no las maneja la Edge Function).
  const keywords = (fd.get('keywords') || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const payload = {
    vendor_id: vendorId,
    ai_provider: fd.get('ai_provider'),
    ai_model: fd.get('ai_model') || undefined,
    system_prompt: fd.get('system_prompt') || '',
  };
  const apiKey = fd.get('ai_api_key');
  if (apiKey) payload.ai_api_key = apiKey;
  // update-vendor-ai exige ai_provider + ai_api_key juntos para tocar esos campos;
  // si no se escribió una key nueva, no los mandamos y solo actualizamos el prompt.
  if (!apiKey) {
    delete payload.ai_provider;
    delete payload.ai_model;
  }

  settingsStatus.textContent = 'Guardando…';
  settingsStatus.className = 'settings-status';

  try {
    const resp = await fetch(`${FUNCTIONS_URL}/update-vendor-ai`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);

    const { error: kwError } = await supabase.from('vendors').update({ keywords }).eq('id', vendorId);
    if (kwError) throw new Error(kwError.message);

    settingsStatus.textContent = 'Guardado ✓';
    settingsStatus.className = 'settings-status ok';
    await loadVendors();
    setTimeout(() => (settingsOverlay.hidden = true), 700);
  } catch (err) {
    settingsStatus.textContent = `Error: ${err.message}`;
    settingsStatus.className = 'settings-status err';
  }
}

// ── Agregar canal ────────────────────────────────────────────────────────────

const DEFAULT_AI_MODEL = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
};

function readAiConfig(fd) {
  const ai_provider = fd.get('ai_provider')?.toString().trim() || '';
  const ai_api_key = fd.get('ai_api_key')?.toString().trim() || '';
  if (!ai_provider) return {};
  return { ai_provider, ai_api_key, ai_model: DEFAULT_AI_MODEL[ai_provider] };
}

async function createVendorEvolution(fd, name) {
  const phone_number = fd.get('phone_number')?.toString().trim() || null;
  const evolution_instance_id = fd.get('evolution_instance_id')?.toString().trim();

  if (!evolution_instance_id) {
    throw new Error('El ID de instancia de Evolution API es obligatorio.');
  }

  const { error } = await supabase.from('vendors').insert({
    name,
    phone_number,
    channel_type: 'evolution',
    evolution_instance_id,
    ai_api_key: '',
    ...readAiConfig(fd),
  });

  if (error) throw new Error(friendlyDbError(error.message));
}

// Crea/actualiza el canal Meta en meta-exchange (con `access_token` manual o con
// el `code` de Embedded Signup) y guarda el teléfono del asesor si se indicó.
async function callMetaExchange(fd, name, credentials) {
  const phone_number = fd.get('meta_phone_number')?.toString().trim() || null;

  const resp = await fetch(`${FUNCTIONS_URL}/meta-exchange`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      ...credentials,
      vendor_name: name,
      ...readAiConfig(fd),
    }),
  });
  const json = await resp.json();
  if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);

  if (phone_number) {
    const { error } = await supabase.from('vendors').update({ phone_number }).eq('id', json.vendor_id);
    if (error) throw new Error(error.message);
  }
}

async function createVendorMeta(fd, name) {
  const phone_number_id = fd.get('meta_phone_number_id')?.toString().trim();
  const waba_id = fd.get('meta_waba_id')?.toString().trim();
  const access_token = fd.get('meta_access_token')?.toString().trim();

  if (!phone_number_id || !waba_id || !access_token) {
    throw new Error('Phone Number ID, WABA ID y el access token son obligatorios.');
  }

  await callMetaExchange(fd, name, { access_token, phone_number_id, waba_id });
}

// ── Conectar canal Meta con Facebook (WhatsApp Embedded Signup) ──────────────
// FB.login devuelve un `code` (vale 30 s) y, por separado, un mensaje postMessage
// con el número y la cuenta de WhatsApp elegidos. Se esperan ambos y se envían a
// meta-exchange, que canjea el code por el token en el servidor.

let fbSdkPromise = null;

function loadFacebookSdk() {
  if (fbSdkPromise) return fbSdkPromise;
  fbSdkPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: META_APP_ID, autoLogAppEvents: true, xfbml: false, version: FB_SDK_VERSION });
      resolve(window.FB);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/es_LA/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      fbSdkPromise = null;
      script.remove();
      reject(new Error('No se pudo cargar el SDK de Facebook. Desactiva el bloqueador de anuncios e inténtalo de nuevo.'));
    };
    document.head.appendChild(script);
  });
  return fbSdkPromise;
}

function isFacebookOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  } catch {
    return false;
  }
}

// Resuelve con { code, phone_number_id, waba_id }; rechaza si el usuario cancela o Meta falla.
function runEmbeddedSignup() {
  return new Promise((resolve, reject) => {
    let code = null;
    let session = null;
    let timer = null;
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      fn(value);
    };
    const tryFinish = () => {
      if (code && session) settle(resolve, { code, ...session });
    };

    function onMessage(ev) {
      if (!isFacebookOrigin(ev.origin)) return;
      let msg = ev.data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return; }
      }
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (msg.event === 'CANCEL') {
        return settle(reject, new Error('Cancelaste la conexión antes de terminar.'));
      }
      if (msg.data?.error_message) {
        return settle(reject, new Error(`Meta reportó un error: ${msg.data.error_message}`));
      }
      if (String(msg.event ?? '').startsWith('FINISH')) {
        if (!msg.data?.phone_number_id || !msg.data?.waba_id) {
          return settle(reject, new Error('No elegiste un número de WhatsApp Business. Vuelve a intentarlo y selecciona uno.'));
        }
        session = { phone_number_id: msg.data.phone_number_id, waba_id: msg.data.waba_id };
        tryFinish();
      }
    }
    window.addEventListener('message', onMessage);

    window.FB.login(
      (resp) => {
        if (!resp.authResponse?.code) {
          return settle(reject, new Error('Facebook no autorizó la conexión (cancelaste o negaste el permiso).'));
        }
        code = resp.authResponse.code;
        // El code caduca a los 30 s: si Meta no manda el número, no sirve seguir esperando.
        timer = setTimeout(() => settle(reject, new Error('Meta no devolvió el número elegido a tiempo. Inténtalo de nuevo.')), 20000);
        tryFinish();
      },
      {
        config_id: META_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      }
    );
  });
}

async function connectVendorWithFacebook() {
  const fd = new FormData(vendorForm);
  const name = fd.get('name')?.toString().trim();
  const setStatus = (text, cls = '') => {
    vendorStatus.textContent = text;
    vendorStatus.className = `settings-status ${cls}`.trim();
  };

  if (!name) return setStatus('Escribe primero el nombre del canal.', 'err');
  if (!window.FB) {
    setStatus('Cargando el SDK de Facebook… vuelve a pulsar en un momento.');
    loadFacebookSdk().catch((err) => setStatus(err.message, 'err'));
    return;
  }

  vendorFbConnectBtn.disabled = true;
  setStatus('Esperando la autorización de Facebook…');
  try {
    const session = await runEmbeddedSignup();
    setStatus('Conectando el canal…');
    await callMetaExchange(fd, name, session);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'err');
    return;
  } finally {
    vendorFbConnectBtn.disabled = false;
  }
  await onVendorCreated();
}

async function createVendor(ev) {
  ev.preventDefault();
  const fd = new FormData(vendorForm);
  const name = fd.get('name')?.toString().trim();
  const isMeta = vendorConnectionType.value === 'meta';

  if (!name) {
    vendorStatus.textContent = 'El nombre del canal es obligatorio.';
    vendorStatus.className = 'settings-status err';
    return;
  }

  vendorStatus.textContent = isMeta ? 'Conectando con Meta…' : 'Creando…';
  vendorStatus.className = 'settings-status';

  try {
    if (isMeta) {
      await createVendorMeta(fd, name);
    } else {
      await createVendorEvolution(fd, name);
    }
  } catch (err) {
    vendorStatus.textContent = `Error: ${err.message}`;
    vendorStatus.className = 'settings-status err';
    return;
  }

  await onVendorCreated();
}

async function onVendorCreated() {
  vendorStatus.textContent = 'Canal creado ✓';
  vendorStatus.className = 'settings-status ok';
  await loadVendors();
  vendorForm.reset();
  updateVendorFormConnectionType();
  setTimeout(() => (vendorOverlay.hidden = true), 600);
}

// ── Usuarios de la empresa (vendedores con login por teléfono / admins) ──────
// Toda la administración de usuarios pasa por la Edge Function admin-users
// (crea el usuario de Auth, su perfil y —para vendedores— su fila en agents).

const agentUserType = document.getElementById('agent-user-type');
const agentVendedorFields = document.getElementById('agent-vendedor-fields');
const agentAdminFields = document.getElementById('agent-admin-fields');
const agentRoleSelect = document.getElementById('agent-role-select');
const agentModalOrg = document.getElementById('agent-modal-org');

function syncAgentModalType() {
  const isAdmin = agentUserType.value === 'admin';
  agentVendedorFields.hidden = isAdmin;
  agentAdminFields.hidden = !isAdmin;
}
agentUserType.addEventListener('change', syncAgentModalType);

function openAgentModal(orgId = null) {
  state.agentModalOrgId = orgId;
  agentForm.reset();
  agentUserType.value = 'vendedor';
  syncAgentModalType();

  // Los roles de otra empresa no son visibles (RLS): admin-users asigna el
  // rol "Vendedores" de esa empresa por defecto.
  const foreignOrg = orgId && orgId !== state.me.organization.id;
  agentRoleSelect.innerHTML = foreignOrg
    ? '<option value="">Vendedores (por defecto)</option>'
    : state.roles
        .filter((r) => !r.is_system)
        .map((r) => `<option value="${r.id}" ${r.name === 'Vendedores' ? 'selected' : ''}>${escapeHtml(r.name)}</option>`)
        .join('') || '<option value="">Vendedores (por defecto)</option>';

  const org = foreignOrg ? state.organizations.find((o) => o.id === orgId) : null;
  agentModalOrg.hidden = !org;
  agentModalOrg.textContent = org ? `Empresa: ${org.name}` : '';

  agentStatus.textContent = '';
  agentStatus.className = 'settings-status';
  agentOverlay.hidden = false;
}

async function createAgent(ev) {
  ev.preventDefault();
  const fd = new FormData(agentForm);
  const setErr = (msg) => {
    agentStatus.textContent = msg;
    agentStatus.className = 'settings-status err';
  };

  const userType = fd.get('user_type');
  const fullName = [fd.get('first_name'), fd.get('last_name')]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const password = String(fd.get('password') ?? '');
  if (!fullName) return setErr('El nombre es obligatorio.');
  if (password.length < 6) return setErr('La contraseña debe tener al menos 6 caracteres.');

  const payload = { user_type: userType, full_name: fullName, password };
  if (state.agentModalOrgId) payload.organization_id = state.agentModalOrgId;

  if (userType === 'admin') {
    const email = String(fd.get('admin_email') ?? '').trim().toLowerCase();
    if (!email) return setErr('El correo es obligatorio para un administrador.');
    payload.email = email;
  } else {
    const e164 = normalizePhone(fd.get('dial'), fd.get('phone'));
    if (!e164) return setErr('Número de WhatsApp inválido: elige el país y escribe el número sin el código.');
    payload.phone = e164;
    const email = String(fd.get('email') ?? '').trim().toLowerCase();
    if (email) payload.email = email;
    const roleId = String(fd.get('role_id') ?? '');
    if (roleId) payload.role_id = roleId;
    const expires = String(fd.get('access_expires_at') ?? '').trim();
    if (expires) payload.access_expires_at = expires;
  }

  agentStatus.textContent = 'Creando…';
  agentStatus.className = 'settings-status';

  try {
    await callAdminUsers('create_user', payload);
  } catch (err) {
    return setErr(`Error: ${err.message}`);
  }

  agentStatus.textContent = 'Usuario creado ✓';
  agentStatus.className = 'settings-status ok';
  await Promise.all([loadAgents(), loadProfiles()]);
  renderVendorCards();
  renderConfigVendedores();
  if (state.agentModalOrgId) await loadOrganizations();
  agentForm.reset();
  setTimeout(() => (agentOverlay.hidden = true), 600);
}

// Vendedor sin login (fila de agents sin perfil): se borra directo.
async function deleteAgent(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (!confirm(`¿Eliminar a ${agent.name}?`)) return;

  const { error } = await supabase.from('agents').delete().eq('id', agentId);
  if (error) {
    alert(`No se pudo eliminar: ${error.message}`);
    return;
  }
  await loadAgents();
  renderVendorCards();
  renderConfigVendedores();
}

async function refreshUsersViews() {
  await Promise.all([loadAgents(), loadProfiles()]);
  renderVendorCards();
  renderConfigVendedores();
  if (state.me?.isSuperAdmin && state.section === 'empresas') await loadOrganizations();
}

async function deleteUser(profile) {
  const label = profile.full_name || profile.email;
  if (!confirm(`¿Eliminar el usuario de ${label}? Ya no podrá iniciar sesión.`)) return;
  try {
    await callAdminUsers('delete_user', { user_id: profile.id, delete_agent: true });
  } catch (err) {
    alert(`No se pudo eliminar: ${err.message}`);
    return;
  }
  await refreshUsersViews();
}

async function resetUserPassword(profile) {
  const pwd = prompt(`Nueva contraseña para ${profile.full_name || profile.email} (mínimo 6 caracteres):`);
  if (pwd === null) return;
  if (pwd.length < 6) {
    alert('La contraseña debe tener al menos 6 caracteres.');
    return;
  }
  try {
    await callAdminUsers('reset_password', { user_id: profile.id, new_password: pwd });
    alert('Contraseña actualizada ✓');
  } catch (err) {
    alert(`No se pudo cambiar la contraseña: ${err.message}`);
  }
}

async function toggleUserActive(profile) {
  const next = !profile.is_active;
  if (!next && !confirm(`¿Desactivar a ${profile.full_name || profile.email}? Perderá el acceso de inmediato.`)) return;
  try {
    await callAdminUsers('set_active', { user_id: profile.id, is_active: next });
  } catch (err) {
    alert(`No se pudo cambiar el estado: ${err.message}`);
    return;
  }
  await refreshUsersViews();
}

function userActionButtons(profile) {
  const isSelf = profile.id === state.me.user.id;
  if (isSelf || (profile.is_super_admin && !state.me.isSuperAdmin)) return '';
  return `
    <button type="button" class="btn-icon js-user-reset" data-user-id="${profile.id}" title="Cambiar contraseña" aria-label="Cambiar contraseña">🔑</button>
    <button type="button" class="btn-icon js-user-toggle" data-user-id="${profile.id}" title="${profile.is_active ? 'Desactivar' : 'Activar'}" aria-label="${profile.is_active ? 'Desactivar' : 'Activar'}">${profile.is_active ? '⏸' : '▶️'}</button>
    <button type="button" class="btn-icon js-user-delete" data-user-id="${profile.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
  `;
}

function handleUserActionClick(ev) {
  const btn = ev.target.closest('.js-user-reset, .js-user-toggle, .js-user-delete');
  if (!btn) return false;
  const profile = state.profiles.find((p) => p.id === btn.dataset.userId);
  if (!profile) return true;
  if (btn.classList.contains('js-user-reset')) resetUserPassword(profile);
  else if (btn.classList.contains('js-user-toggle')) toggleUserActive(profile);
  else deleteUser(profile);
  return true;
}

function renderConfigVendedores() {
  const orgId = state.me.organization.id;
  const profiles = state.profiles.filter((p) => p.organization_id === orgId);
  const roleName = (agent) => (agent?.role_id ? state.roles.find((r) => r.id === agent.role_id)?.name : null) || 'Sin rol';

  const rows = profiles.map((p) => {
    const agent = p.agent_id ? state.agents.find((a) => a.id === p.agent_id) : null;
    const isVendedor = p.user_type === 'vendedor';
    const name = p.full_name || agent?.name || p.email;
    const expired = agent?.access_expires_at && agent.access_expires_at < new Date().toISOString().slice(0, 10);
    const access = !p.is_active
      ? '<span class="role-badge role-badge-off">Desactivado</span>'
      : expired
        ? '<span class="role-badge role-badge-off">Vencido</span>'
        : agent?.access_expires_at
          ? `<span class="role-badge role-badge-ok">Hasta ${escapeHtml(agent.access_expires_at)}</span>`
          : '<span class="role-badge role-badge-ok">Activo</span>';
    return `
      <tr data-id="${p.id}">
        <td>
          <div class="config-vendor-cell">
            <span class="account-avatar">${initials(name)}</span>
            <span>${escapeHtml(name)}${p.is_super_admin ? ' <span class="role-badge role-badge-info">Plataforma</span>' : ''}</span>
          </div>
        </td>
        <td>${isVendedor ? `📱 ${escapeHtml(p.phone) || '—'}` : `✉️ ${escapeHtml(p.email)}`}</td>
        <td>${escapeHtml(isVendedor ? agent?.email : p.email) || '—'}</td>
        <td><span class="role-badge ${isVendedor ? '' : 'role-badge-full'}">${isVendedor ? escapeHtml(roleName(agent)) : 'Administrador'}</span></td>
        <td>${access}</td>
        <td>${userActionButtons(p)}</td>
      </tr>
    `;
  });

  // Vendedores creados sin login (antes del SaaS): se pueden vincular creando
  // su usuario, o eliminar.
  for (const a of state.agents) {
    if (profiles.some((p) => p.agent_id === a.id)) continue;
    rows.push(`
      <tr data-id="${a.id}">
        <td>
          <div class="config-vendor-cell">
            <span class="account-avatar">${initials(a.name)}</span>
            <span>${escapeHtml(a.name)}</span>
          </div>
        </td>
        <td><span class="muted">Sin usuario</span></td>
        <td>${escapeHtml(a.email) || '—'}</td>
        <td><span class="role-badge">${escapeHtml(roleName(a))}</span></td>
        <td><span class="muted">—</span></td>
        <td><button type="button" class="btn-icon config-delete-agent-btn" data-id="${a.id}" title="Eliminar" aria-label="Eliminar">🗑</button></td>
      </tr>
    `);
  }

  configVendorsTbody.innerHTML = rows.join('') || `<tr class="empty-row"><td colspan="6">No hay usuarios todavía. Crea el primero con “＋ Nuevo usuario”.</td></tr>`;
}

configVendorsTbody.addEventListener('click', (ev) => {
  if (handleUserActionClick(ev)) return;
  const btn = ev.target.closest('.config-delete-agent-btn');
  if (!btn) return;
  deleteAgent(btn.dataset.id);
});

// ── Empresas (solo super-admin) ──────────────────────────────────────────────

const viewEmpresas = document.getElementById('view-empresas');
const orgsTbody = document.getElementById('orgs-tbody');
const orgOverlay = document.getElementById('org-overlay');
const orgForm = document.getElementById('org-form');
const orgStatus = document.getElementById('org-status');

async function loadOrganizations() {
  try {
    const json = await callAdminUsers('list_organizations');
    state.organizations = json.organizations ?? [];
  } catch (err) {
    orgsTbody.innerHTML = `<tr class="empty-row"><td colspan="6">Error cargando empresas: ${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  renderOrgsTable();
}

function renderOrgsTable() {
  if (!state.organizations.length) {
    orgsTbody.innerHTML = `<tr class="empty-row"><td colspan="6">No hay empresas todavía.</td></tr>`;
    return;
  }
  orgsTbody.innerHTML = state.organizations
    .map((o) => {
      const isMine = o.id === state.me.organization.id;
      const expanded = state.expandedOrgIds.has(o.id);
      const users = state.profiles.filter((p) => p.organization_id === o.id);
      const usersRow = expanded
        ? `<tr class="org-users-row"><td colspan="6"><div class="org-users">${
            users
              .map(
                (p) => `
                  <div class="org-user">
                    <span class="account-avatar">${initials(p.full_name || p.email)}</span>
                    <span><strong>${escapeHtml(p.full_name || p.email)}</strong> <span class="muted">· ${p.user_type === 'vendedor' ? `📱 ${escapeHtml(p.phone) || '—'}` : `✉️ ${escapeHtml(p.email)}`} · ${p.user_type === 'admin' ? 'Administrador' : 'Vendedor'}${p.is_active ? '' : ' · <em>desactivado</em>'}</span></span>
                    <span class="org-user-actions">${userActionButtons(p)}</span>
                  </div>`
              )
              .join('') || '<span class="muted">Sin usuarios.</span>'
          }</div></td></tr>`
        : '';
      return `
        <tr data-id="${o.id}">
          <td><strong>${escapeHtml(o.name)}</strong>${isMine ? ' <span class="role-badge role-badge-info">Tu empresa</span>' : ''}</td>
          <td>${o.channels_count} / ${o.max_channels}</td>
          <td>${o.users_count}</td>
          <td>${(o.admins ?? []).map((a) => escapeHtml(a.email)).join('<br>') || '—'}</td>
          <td>${o.is_active ? '<span class="role-badge role-badge-ok">Activa</span>' : '<span class="role-badge role-badge-off">Desactivada</span>'}</td>
          <td>
            <button type="button" class="btn-icon js-org-limit" data-id="${o.id}" title="Cambiar límite de canales" aria-label="Cambiar límite de canales">🔢</button>
            <button type="button" class="btn-icon js-org-add-user" data-id="${o.id}" title="Nuevo usuario" aria-label="Nuevo usuario">👤➕</button>
            ${isMine ? '' : `<button type="button" class="btn-icon js-org-toggle" data-id="${o.id}" title="${o.is_active ? 'Desactivar' : 'Activar'}" aria-label="${o.is_active ? 'Desactivar' : 'Activar'}">${o.is_active ? '⏸' : '▶️'}</button>`}
            <button type="button" class="btn-icon js-org-expand" data-id="${o.id}" aria-label="Ver usuarios">${expanded ? '▾' : '▸'}</button>
          </td>
        </tr>
        ${usersRow}
      `;
    })
    .join('');
}

orgsTbody.addEventListener('click', async (ev) => {
  if (handleUserActionClick(ev)) return;
  const btn = ev.target.closest('.js-org-limit, .js-org-add-user, .js-org-toggle, .js-org-expand');
  if (!btn) return;
  const org = state.organizations.find((o) => o.id === btn.dataset.id);
  if (!org) return;

  if (btn.classList.contains('js-org-expand')) {
    if (state.expandedOrgIds.has(org.id)) state.expandedOrgIds.delete(org.id);
    else state.expandedOrgIds.add(org.id);
    renderOrgsTable();
    return;
  }
  if (btn.classList.contains('js-org-add-user')) {
    openAgentModal(org.id === state.me.organization.id ? null : org.id);
    return;
  }
  if (btn.classList.contains('js-org-limit')) {
    const raw = prompt(`Canales de WhatsApp permitidos para ${org.name}:`, String(org.max_channels));
    if (raw === null) return;
    const max = Number.parseInt(raw, 10);
    if (!Number.isInteger(max) || max < 0) {
      alert('Escribe un número entero mayor o igual a 0.');
      return;
    }
    try {
      await callAdminUsers('set_organization_limits', { organization_id: org.id, max_channels: max });
    } catch (err) {
      alert(`No se pudo cambiar el límite: ${err.message}`);
      return;
    }
    await loadOrganizations();
    if (org.id === state.me.organization.id) {
      state.me.organization.max_channels = max;
      renderChannelLimit();
    }
    return;
  }
  if (btn.classList.contains('js-org-toggle')) {
    const next = !org.is_active;
    if (!next && !confirm(`¿Desactivar la empresa ${org.name}? Ninguno de sus usuarios podrá entrar.`)) return;
    try {
      await callAdminUsers('set_organization_active', { organization_id: org.id, is_active: next });
    } catch (err) {
      alert(`No se pudo cambiar el estado: ${err.message}`);
      return;
    }
    await loadOrganizations();
  }
});

document.getElementById('create-org-btn').addEventListener('click', () => {
  orgForm.reset();
  orgStatus.textContent = '';
  orgStatus.className = 'settings-status';
  orgOverlay.hidden = false;
});
document.getElementById('org-modal-close').addEventListener('click', () => (orgOverlay.hidden = true));
orgOverlay.addEventListener('click', (ev) => {
  if (ev.target === orgOverlay) orgOverlay.hidden = true;
});

orgForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(orgForm);
  const payload = {
    name: String(fd.get('name') ?? '').trim(),
    max_channels: Number.parseInt(String(fd.get('max_channels') ?? '1'), 10),
    admin: {
      email: String(fd.get('admin_email') ?? '').trim().toLowerCase(),
      password: String(fd.get('admin_password') ?? ''),
      full_name: String(fd.get('admin_full_name') ?? '').trim(),
    },
  };
  orgStatus.textContent = 'Creando…';
  orgStatus.className = 'settings-status';
  try {
    await callAdminUsers('create_organization', payload);
  } catch (err) {
    orgStatus.textContent = `Error: ${err.message}`;
    orgStatus.className = 'settings-status err';
    return;
  }
  orgStatus.textContent = 'Empresa creada ✓';
  orgStatus.className = 'settings-status ok';
  await Promise.all([loadProfiles(), loadOrganizations()]);
  setTimeout(() => (orgOverlay.hidden = true), 600);
});

function setConfigTab(tab) {
  state.configTab = tab;
  configTabsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.configTab === tab));
  Object.entries(configPanels).forEach(([key, el]) => (el.hidden = key !== tab));
}
configTabsEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip[data-config-tab]');
  if (!btn) return;
  setConfigTab(btn.dataset.configTab);
});

// ── Roles y permisos ─────────────────────────────────────────────────────────

async function loadRoles() {
  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .order('is_system', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando roles:', error.message);
    return;
  }
  state.roles = data ?? [];
}

function renderRolesTable() {
  if (!state.roles.length) {
    rolesTbody.innerHTML = `<tr class="empty-row"><td colspan="2">No hay roles todavía.</td></tr>`;
    return;
  }

  rolesTbody.innerHTML = state.roles
    .map((r) => {
      const count = r.permissions.length;
      const expanded = state.expandedRoleIds.has(r.id);
      const badge = r.is_system
        ? `<span class="role-badge role-badge-full">Acceso completo</span>`
        : `<span class="role-badge">Personalizado</span><span class="muted role-perm-count">${count} permiso${count === 1 ? '' : 's'}</span>`;
      const actions = r.is_system
        ? ''
        : `
          <button type="button" class="btn-icon role-edit-btn" data-id="${r.id}" title="Editar" aria-label="Editar">✏️</button>
          <button type="button" class="btn-icon role-delete-btn" data-id="${r.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
        `;
      const chipsRow = expanded
        ? `<tr class="role-chips-row"><td colspan="2"><div class="role-chips">${r.permissions
            .map((key) => (ALL_PERMISSIONS_BY_KEY[key] ? `<span class="role-chip">${escapeHtml(ALL_PERMISSIONS_BY_KEY[key].label)}</span>` : ''))
            .join('') || '<span class="muted">Sin permisos.</span>'}</div></td></tr>`
        : '';
      return `
        <tr data-id="${r.id}">
          <td>
            <div class="role-row-name">
              <span class="role-shield">🛡️</span>
              <strong>${escapeHtml(r.name)}</strong>
              ${badge}
            </div>
          </td>
          <td>
            ${actions}
            <button type="button" class="btn-icon role-toggle-btn" data-id="${r.id}" aria-label="Ver permisos">${expanded ? '▾' : '▸'}</button>
          </td>
        </tr>
        ${chipsRow}
      `;
    })
    .join('');
}

rolesTbody.addEventListener('click', (ev) => {
  const editBtn = ev.target.closest('.role-edit-btn');
  if (editBtn) {
    const role = state.roles.find((r) => r.id === editBtn.dataset.id);
    if (role) openRoleModal('edit', role);
    return;
  }
  const delBtn = ev.target.closest('.role-delete-btn');
  if (delBtn) {
    deleteRole(delBtn.dataset.id);
    return;
  }
  const toggleBtn = ev.target.closest('.role-toggle-btn');
  if (toggleBtn) {
    const id = toggleBtn.dataset.id;
    if (state.expandedRoleIds.has(id)) state.expandedRoleIds.delete(id);
    else state.expandedRoleIds.add(id);
    renderRolesTable();
  }
});

async function deleteRole(roleId) {
  const role = state.roles.find((r) => r.id === roleId);
  if (!role || role.is_system) return;
  if (!confirm(`¿Eliminar el rol "${role.name}"?`)) return;

  const { error } = await supabase.from('roles').delete().eq('id', roleId);
  if (error) {
    alert(`No se pudo eliminar: ${error.message}`);
    return;
  }
  await loadRoles();
  renderRolesTable();
}

function renderTemplatePicker() {
  roleTemplatePicker.innerHTML = Object.entries(ROLE_TEMPLATES)
    .map(
      ([key, t]) => `
        <button type="button" class="role-template-card ${state.roleModalTemplate === key ? 'is-active' : ''}" data-template="${key}">
          <strong>${escapeHtml(t.label)} ${t.warn ? '⚠️' : ''}</strong>
          <span class="muted">${escapeHtml(t.description)}</span>
          <span class="role-template-count">${t.permissions.length} permisos</span>
        </button>
      `
    )
    .join('');
}

function renderPermissionCategories() {
  const selected = state.roleModalPermissions;
  rolePermissionsList.innerHTML = PERMISSION_CATEGORIES.map((cat) => {
    const total = cat.permissions.length;
    const checked = cat.permissions.filter((p) => selected.has(p.key)).length;
    const allChecked = checked === total;
    const noteClass = cat.danger ? 'role-cat-danger' : cat.warn ? 'role-cat-warn' : '';
    const note = cat.danger || cat.warn;
    const isOpen = state.roleModalOpenCats.has(cat.key);
    return `
      <div class="role-category ${noteClass}">
        <button type="button" class="role-category-header" data-cat-toggle="${cat.key}">
          <span class="role-cat-caret">${isOpen ? '▾' : '▸'}</span>
          <span class="role-cat-label">${escapeHtml(cat.label)}</span>
          <span class="role-cat-count">${checked} de ${total}</span>
          <span class="role-cat-toggle-all" data-cat-toggle-all="${cat.key}">${allChecked ? 'Quitar todo' : 'Todo'}</span>
        </button>
        ${note ? `<p class="role-cat-note">${escapeHtml(note)}</p>` : ''}
        <div class="role-cat-body" data-cat-body="${cat.key}" ${isOpen ? '' : 'hidden'}>
          ${cat.permissions
            .map(
              (p) => `
                <label class="role-perm-row">
                  <input type="checkbox" data-perm="${p.key}" ${selected.has(p.key) ? 'checked' : ''} />
                  <span>
                    <strong>${escapeHtml(p.label)}</strong>
                    <span class="muted role-perm-desc">${escapeHtml(p.desc)}</span>
                  </span>
                </label>
              `
            )
            .join('')}
        </div>
      </div>
    `;
  }).join('');

  const total = ALL_PERMISSION_KEYS.length;
  rolePermissionsCount.textContent = selected.size ? `${selected.size} de ${total} seleccionados` : 'Sin permisos seleccionados';
}

function openRoleModal(mode, role = null) {
  state.roleModalMode = mode;
  state.editingRoleId = role?.id ?? null;
  state.roleModalPermissions = new Set(role?.permissions ?? []);
  state.roleModalOpenCats = new Set();
  state.roleModalTemplate = null;

  roleModalTitle.textContent = mode === 'edit' ? 'Editar rol' : 'Nuevo rol';
  roleModalSubtitle.textContent =
    mode === 'edit' ? 'Ajusta el nombre y los permisos de este rol.' : 'Elige un punto de partida y ajusta los permisos si hace falta.';
  roleTemplatePicker.hidden = mode === 'edit';
  roleNameInput.value = role?.name ?? '';
  roleSubmitBtn.textContent = mode === 'edit' ? 'Guardar cambios' : 'Crear rol';
  roleStatus.textContent = '';
  roleStatus.className = 'settings-status';

  if (mode === 'create') renderTemplatePicker();
  renderPermissionCategories();
  roleOverlay.hidden = false;
}

roleTemplatePicker.addEventListener('click', (ev) => {
  const card = ev.target.closest('[data-template]');
  if (!card) return;
  const key = card.dataset.template;
  state.roleModalTemplate = key;
  state.roleModalPermissions = new Set(ROLE_TEMPLATES[key].permissions);
  renderTemplatePicker();
  renderPermissionCategories();
});

rolePermissionsList.addEventListener('click', (ev) => {
  const toggleAll = ev.target.closest('[data-cat-toggle-all]');
  if (toggleAll) {
    const cat = PERMISSION_CATEGORIES.find((c) => c.key === toggleAll.dataset.catToggleAll);
    const allChecked = cat.permissions.every((p) => state.roleModalPermissions.has(p.key));
    cat.permissions.forEach((p) => (allChecked ? state.roleModalPermissions.delete(p.key) : state.roleModalPermissions.add(p.key)));
    renderPermissionCategories();
    return;
  }
  const header = ev.target.closest('.role-category-header');
  if (header) {
    const catKey = header.dataset.catToggle;
    if (state.roleModalOpenCats.has(catKey)) state.roleModalOpenCats.delete(catKey);
    else state.roleModalOpenCats.add(catKey);
    renderPermissionCategories();
  }
});

rolePermissionsList.addEventListener('change', (ev) => {
  const cb = ev.target.closest('input[data-perm]');
  if (!cb) return;
  if (cb.checked) state.roleModalPermissions.add(cb.dataset.perm);
  else state.roleModalPermissions.delete(cb.dataset.perm);
  renderPermissionCategories();
});

async function saveRole(ev) {
  ev.preventDefault();
  const name = roleNameInput.value.trim();
  if (!name) {
    roleStatus.textContent = 'El nombre del rol es obligatorio.';
    roleStatus.className = 'settings-status err';
    return;
  }

  roleStatus.textContent = 'Guardando…';
  roleStatus.className = 'settings-status';

  const payload = { name, permissions: Array.from(state.roleModalPermissions) };
  const { error } = state.editingRoleId
    ? await supabase.from('roles').update(payload).eq('id', state.editingRoleId)
    : await supabase.from('roles').insert(payload);

  if (error) {
    roleStatus.textContent = `Error: ${error.message}`;
    roleStatus.className = 'settings-status err';
    return;
  }

  roleStatus.textContent = state.editingRoleId ? 'Rol actualizado ✓' : 'Rol creado ✓';
  roleStatus.className = 'settings-status ok';
  await loadRoles();
  renderRolesTable();
  setTimeout(() => (roleOverlay.hidden = true), 600);
}

document.getElementById('create-role-btn').addEventListener('click', () => openRoleModal('create'));
document.getElementById('role-modal-close').addEventListener('click', () => (roleOverlay.hidden = true));
roleOverlay.addEventListener('click', (ev) => {
  if (ev.target === roleOverlay) roleOverlay.hidden = true;
});
roleForm.addEventListener('submit', saveRole);

// ── Asignar vendedor a un canal ───────────────────────────────────────────────

function openAssign(vendorId) {
  const v = state.vendors.find((x) => x.id === vendorId);
  if (!v) return;
  state.assignVendorId = vendorId;
  assignSelect.innerHTML =
    '<option value="">Sin asignar</option>' +
    state.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  assignSelect.value = v.assigned_agent_id ?? '';
  assignStatus.textContent = '';
  assignStatus.className = 'settings-status';
  assignOverlay.hidden = false;
}

async function saveAssign(ev) {
  ev.preventDefault();
  const agentId = assignSelect.value || null;
  assignStatus.textContent = 'Guardando…';
  assignStatus.className = 'settings-status';

  const { error } = await supabase
    .from('vendors')
    .update({ assigned_agent_id: agentId })
    .eq('id', state.assignVendorId);

  if (error) {
    assignStatus.textContent = `Error: ${error.message}`;
    assignStatus.className = 'settings-status err';
    return;
  }

  assignStatus.textContent = 'Guardado ✓';
  assignStatus.className = 'settings-status ok';
  await loadVendors();
  setTimeout(() => (assignOverlay.hidden = true), 500);
}

// ── Eventos ──────────────────────────────────────────────────────────────────

vendorSelect.addEventListener('change', async () => {
  state.vendorId = vendorSelect.value;
  if (state.section.startsWith('vendor:')) {
    state.section = `vendor:${state.vendorId}`;
    const v = state.vendors.find((x) => x.id === state.vendorId);
    topbarTitle.textContent = v ? v.name : 'Leads';
    syncSidenavActive();
  }
  await loadProspects();
  subscribeVendor(state.vendorId);
});

filtersEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  filtersEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === btn));
  renderTable();
});

searchInput.addEventListener('input', () => {
  state.search = searchInput.value;
  renderTable();
});

tableHead.addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = 'desc';
  }
  renderTable();
});

tbody.addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;
  openDrawer(tr.dataset.id);
});

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', (ev) => {
  if (ev.target === drawerOverlay) closeDrawer();
});

document.getElementById('settings-close').addEventListener('click', () => (settingsOverlay.hidden = true));
settingsOverlay.addEventListener('click', (ev) => {
  if (ev.target === settingsOverlay) settingsOverlay.hidden = true;
});
settingsForm.addEventListener('submit', saveSettings);

document.getElementById('create-vendor-btn').addEventListener('click', () => {
  vendorForm.reset();
  vendorStatus.textContent = '';
  updateVendorFormConnectionType();
  vendorOverlay.hidden = false;
});
document.getElementById('vendor-modal-close').addEventListener('click', () => (vendorOverlay.hidden = true));
vendorOverlay.addEventListener('click', (ev) => {
  if (ev.target === vendorOverlay) vendorOverlay.hidden = true;
});
vendorForm.addEventListener('submit', createVendor);
vendorConnectionType.addEventListener('change', updateVendorFormConnectionType);
vendorFbConnectBtn.addEventListener('click', connectVendorWithFacebook);

document.getElementById('create-agent-btn').addEventListener('click', () => openAgentModal());
document.getElementById('create-agent-btn-config').addEventListener('click', () => openAgentModal());
document.getElementById('agent-modal-close').addEventListener('click', () => (agentOverlay.hidden = true));
agentOverlay.addEventListener('click', (ev) => {
  if (ev.target === agentOverlay) agentOverlay.hidden = true;
});
agentForm.addEventListener('submit', createAgent);

document.getElementById('assign-modal-close').addEventListener('click', () => (assignOverlay.hidden = true));
assignOverlay.addEventListener('click', (ev) => {
  if (ev.target === assignOverlay) assignOverlay.hidden = true;
});
assignForm.addEventListener('submit', saveAssign);

// ── Estado rápido del vendedor (selector en el topbar) ───────────────────────
// "Quién soy" sale de la sesión (profiles.agent_id). Un admin sin fila de
// vendedor no tiene selector.

const statusPillWrap = document.getElementById('status-pill-wrap');
const statusPillTrigger = document.getElementById('status-pill-trigger');
const statusPillDot = document.getElementById('status-pill-dot');
const statusPillLabel = document.getElementById('status-pill-label');
const statusPillPanel = document.getElementById('status-pill-panel');

function myAgent() {
  const id = state.me?.agent?.id;
  return id ? state.agents.find((a) => a.id === id) || null : null;
}

function renderStatusPill() {
  const agent = myAgent();
  statusPillWrap.hidden = !agent;
  if (!agent) return;
  const meta = AGENT_STATUS_META[agent.status] ?? AGENT_STATUS_META.fuera_de_atencion;
  statusPillDot.style.background = `var(--${meta.color})`;
  statusPillLabel.textContent = meta.label;
}

function renderStatusPanel() {
  const agent = myAgent();
  if (!agent) return;

  statusPillPanel.innerHTML = `
    <div class="status-menu-title">Cambiar estado</div>
    ${MANUAL_STATUS_ORDER.map((s) => {
      const meta = AGENT_STATUS_META[s];
      const isActive = agent.status === s;
      return `
        <button type="button" class="status-menu-option ${isActive ? 'is-active' : ''}" data-set-status="${s}">
          <span class="status-menu-icon-box" style="background:var(--${meta.color}-bg)">${meta.icon}</span>
          <span class="status-menu-text">
            <strong>${escapeHtml(meta.label)}</strong>
            <span class="muted">${escapeHtml(meta.desc)}</span>
          </span>
          ${isActive ? '<span class="status-menu-check">✓</span>' : `<span class="status-menu-swatch" style="background:var(--${meta.color})"></span>`}
        </button>
      `;
    }).join('')}
  `;
}

function openStatusPanel() {
  renderStatusPanel();
  statusPillPanel.hidden = false;
}
function closeStatusPanel() {
  statusPillPanel.hidden = true;
}

statusPillTrigger.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (statusPillPanel.hidden) openStatusPanel();
  else closeStatusPanel();
});

statusPillPanel.addEventListener('click', async (ev) => {
  const setStatus = ev.target.closest('[data-set-status]');
  if (setStatus) {
    const agent = myAgent();
    if (!agent) return;
    closeStatusPanel();
    await setAgentStatus(agent.id, setStatus.dataset.setStatus);
    renderStatusPill();
  }
});

document.addEventListener('click', (ev) => {
  if (!statusPillPanel.hidden && !statusPillWrap.contains(ev.target)) closeStatusPanel();
});

// ── Sesión, permisos y login ─────────────────────────────────────────────────

const shellEl = document.querySelector('.shell');
const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const loginModesEl = document.getElementById('login-modes');
const loginEmpresaFields = document.getElementById('login-empresa-fields');
const loginVendedorFields = document.getElementById('login-vendedor-fields');
const blockedScreen = document.getElementById('blocked-screen');
let loginMode = 'empresa';

function can(perm) {
  const me = state.me;
  if (!me) return false;
  return me.isAdmin || me.permissions.has(perm);
}

// Oculta todo lo marcado con data-perm / data-perm-any que el usuario no
// tenga. Los admins pasan todo.
function applyPermissionGating() {
  document.querySelectorAll('[data-perm]').forEach((el) => {
    el.hidden = !can(el.dataset.perm);
  });
  document.querySelectorAll('[data-perm-any]').forEach((el) => {
    el.hidden = !el.dataset.permAny.split(/\s+/).some(can);
  });
  document.getElementById('nav-empresas').hidden = !state.me?.isSuperAdmin;
  const canalesSection = document.getElementById('sidenav-canales-section');
  canalesSection.hidden = !canalesSection.querySelector('.sidenav-item:not([hidden])');
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY };
}

async function callAdminUsers(action, payload = {}) {
  const resp = await fetch(`${FUNCTIONS_URL}/admin-users`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action, ...payload }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

function showScreen(which) {
  loginScreen.hidden = which !== 'login';
  blockedScreen.hidden = which !== 'blocked';
  shellEl.hidden = which !== 'app';
}

function showBlocked(title, text) {
  document.getElementById('blocked-title').textContent = title;
  document.getElementById('blocked-text').textContent = text;
  showScreen('blocked');
}

function setLoginStatus(text, isError = false) {
  loginStatus.textContent = text;
  loginStatus.className = `settings-status${isError ? ' err' : ''}`;
}

function setLoginMode(mode) {
  loginMode = mode;
  loginModesEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.loginMode === mode));
  loginEmpresaFields.hidden = mode !== 'empresa';
  loginVendedorFields.hidden = mode !== 'vendedor';
  setLoginStatus('');
}

loginModesEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.chip[data-login-mode]');
  if (btn) setLoginMode(btn.dataset.loginMode);
});

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(loginForm);
  const password = String(fd.get('password') ?? '');
  let email;
  if (loginMode === 'empresa') {
    email = String(fd.get('email') ?? '').trim().toLowerCase();
    if (!email) return setLoginStatus('Escribe tu correo.', true);
  } else {
    const e164 = normalizePhone(fd.get('dial'), fd.get('phone'));
    if (!e164) return setLoginStatus('Número inválido: elige tu país y escribe el número sin el código.', true);
    email = vendorLoginEmail(e164);
  }
  if (!password) return setLoginStatus('Escribe tu contraseña.', true);

  setLoginStatus('Ingresando…');
  state.loginModeAttempt = loginMode;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    state.loginModeAttempt = null;
    const msg = /invalid login credentials/i.test(error?.message ?? '')
      ? loginMode === 'empresa'
        ? 'Correo o contraseña incorrectos.'
        : 'Número o contraseña incorrectos.'
      : `No se pudo iniciar sesión: ${error?.message ?? 'error desconocido'}`;
    return setLoginStatus(msg, true);
  }
  await bootstrapSession(data.session);
});

// Carga el perfil de la sesión y arranca la app (o muestra por qué no puede).
async function bootstrapSession(session) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*, organization:organizations(id, name, is_active, max_channels), agent:agents(*, role:roles(id, name, permissions))')
    .eq('id', session.user.id)
    .maybeSingle();

  if (error) {
    showBlocked('No se pudo cargar tu perfil', error.message);
    return;
  }
  if (!profile) {
    showBlocked('Sin acceso', 'Tu usuario existe pero no está vinculado a ninguna empresa. Contacta al administrador de la plataforma.');
    return;
  }
  if (!profile.is_active || !profile.organization?.is_active) {
    showBlocked('Acceso deshabilitado', profile.is_active ? 'Tu empresa está desactivada.' : 'Tu usuario fue desactivado. Contacta al administrador de tu empresa.');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (profile.user_type === 'vendedor' && profile.agent?.access_expires_at && profile.agent.access_expires_at < today) {
    showBlocked('Acceso vencido', `Tu acceso venció el ${profile.agent.access_expires_at}. Pide a tu empresa que lo renueve.`);
    return;
  }

  // La pestaña de login debe coincidir con el tipo de cuenta.
  const attempt = state.loginModeAttempt;
  state.loginModeAttempt = null;
  if (attempt && (attempt === 'empresa') !== (profile.user_type === 'admin')) {
    await supabase.auth.signOut();
    showScreen('login');
    setLoginStatus(
      profile.user_type === 'admin'
        ? 'Esta cuenta es de empresa: ingresa por la pestaña “Empresa” con tu correo.'
        : 'Esta cuenta es de vendedor: ingresa por la pestaña “Vendedor” con tu número.',
      true
    );
    return;
  }

  const isAdmin = profile.user_type === 'admin' || profile.is_super_admin;
  state.me = {
    user: session.user,
    profile,
    organization: profile.organization,
    agent: profile.agent,
    isAdmin,
    isSuperAdmin: Boolean(profile.is_super_admin),
    permissions: new Set(isAdmin ? ALL_PERMISSION_KEYS : (profile.agent?.role?.permissions ?? [])),
  };

  applyPermissionGating();
  renderAccountChip();
  showScreen('app');
  await startApp();
}

function renderAccountChip() {
  const me = state.me;
  const name = me?.profile?.full_name || me?.agent?.name || me?.user?.email || '—';
  const sub = !me
    ? '—'
    : me.profile.user_type === 'vendedor'
      ? `${me.organization?.name ?? ''} · ${me.profile.phone ?? ''}`
      : `${me.organization?.name ?? ''} · ${me.user.email ?? ''}`;
  document.getElementById('account-name').textContent = name;
  document.getElementById('account-email').textContent = sub;
  document.getElementById('account-avatar').textContent = initials(name);
}

document.getElementById('open-account-settings-btn').addEventListener('click', () => {
  setSection('configuracion');
});

async function signOutAndReload() {
  await supabase.auth.signOut();
  location.reload();
}

document.getElementById('logout-btn').addEventListener('click', () => {
  if (!confirm('¿Cerrar sesión?')) return;
  signOutAndReload();
});
document.getElementById('blocked-logout-btn').addEventListener('click', signOutAndReload);

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!drawerOverlay.hidden) closeDrawer();
  if (!settingsOverlay.hidden) settingsOverlay.hidden = true;
  if (!vendorOverlay.hidden) vendorOverlay.hidden = true;
  if (!agentOverlay.hidden) agentOverlay.hidden = true;
  if (!assignOverlay.hidden) assignOverlay.hidden = true;
  if (!roleOverlay.hidden) roleOverlay.hidden = true;
  if (!orgOverlay.hidden) orgOverlay.hidden = true;
  if (!statusPillPanel.hidden) closeStatusPanel();
  if (!customfieldOverlay.hidden) customfieldOverlay.hidden = true;
  if (!productOverlay.hidden) closeProductModal();
  if (!autofillOverlay.hidden) closeAutofillModal();
  if (!catalogOverlay.hidden) closeCatalogModal();
  if (!catalogAnalyzeOverlay.hidden) closeCatalogAnalyzeModal();
  if (!automationTemplateOverlay.hidden) closeAutomationTemplatePicker();
  if (!automationEditorOverlay.hidden) closeAutomationEditor();
  if (!automationAudienceOverlay.hidden) closeAudienceStep();
  if (!availAssignOverlay.hidden) availAssignOverlay.hidden = true;
});

// ── Init ─────────────────────────────────────────────────────────────────────

async function startApp() {
  await Promise.all([loadAgents(), loadVendors(), loadCustomFields(), loadRoles()]);
  setSection(defaultSection());
  if (state.vendorId) {
    await loadProspects();
    subscribeVendor(state.vendorId);
  } else {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${
      state.me.isAdmin ? 'No hay canales configurados todavía.' : 'Todavía no tienes un canal asignado. Pide a tu empresa que te asigne uno.'
    }</td></tr>`;
  }
}

(async function init() {
  fillDialSelects();
  const { data } = await supabase.auth.getSession();
  if (data.session) await bootstrapSession(data.session);
  else showScreen('login');
})();
