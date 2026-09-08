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

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Estado ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_INFO = {
  productos: ['📦', 'Productos', 'Catálogo de productos/propiedades para vincular a las conversaciones. Todavía no está construido.'],
  'catalogo-ia': ['🧠', 'Catálogo IA', 'Biblioteca de prompts y respuestas reutilizables para los bots. Todavía no está construida.'],
  automatizacion: ['🔁', 'Automatización', 'Reglas y flujos automáticos (difusiones, recordatorios, etc). Todavía no está construida.'],
  disponibilidad: ['🗓', 'Disponibilidad', 'Calendario de horarios/citas de los asesores. Todavía no está construida.'],
};

const state = {
  section: 'canales-lista',
  vendors: [],
  agents: [],
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

function renderSidenavVendors() {
  sidenavVendorsEl.innerHTML = state.vendors
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

async function setSection(section) {
  state.section = section;
  syncSidenavActive();

  const isCanales = section === 'canales-lista';
  const isLeads = section === 'leads';
  const isInbox = section === 'bandeja-global';
  const isChannel = section.startsWith('vendor:');
  const isDashboard = section === 'dashboard';
  const isPlaceholder = !isCanales && !isLeads && !isInbox && !isChannel && !isDashboard;

  viewDashboard.hidden = !isDashboard;
  viewCanales.hidden = !isCanales;
  viewLeads.hidden = !isLeads;
  viewInbox.hidden = !isInbox;
  viewChannel.hidden = !isChannel;
  viewPlaceholder.hidden = !isPlaceholder;
  document.querySelector('[data-section-group="canales"]').hidden = !isCanales;
  document.querySelector('[data-section-group="leads"]').hidden = !isLeads;

  if (isDashboard) {
    topbarTitle.textContent = 'Dashboard';
    await loadDashboard();
  } else if (isCanales) {
    topbarTitle.textContent = 'Canales';
  } else if (isLeads) {
    topbarTitle.textContent = 'Leads';
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

async function loadVendors() {
  const { data, error } = await supabase.from('vendors').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Error cargando vendors:', error.message);
    return;
  }
  state.vendors = data ?? [];

  vendorSelect.innerHTML = state.vendors
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)} · ${v.channel_type}</option>`)
    .join('');
  if (state.vendors.length && !state.vendorId) {
    state.vendorId = state.vendors[0].id;
  }
  if (state.vendorId) vendorSelect.value = state.vendorId;

  renderCanalesFilter();

  renderVendorCards();
  renderSidenavVendors();
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
      const iaActiva = Boolean(v.ai_api_key);
      const agent = state.agents.find((a) => a.id === v.assigned_agent_id);
      const keywords = v.keywords ?? [];

      return `
      <div class="vendor-card" data-id="${v.id}">
        <div class="vendor-card-top">
          <div class="vendor-status">
            <span class="status-pill ${connected ? 'is-on' : ''}">${connected ? 'Conectado' : 'Sin conectar'}</span>
            <span class="status-pill ${iaActiva ? 'is-on' : ''}">${iaActiva ? '⚡ IA Activa' : 'IA sin configurar'}</span>
          </div>
          <div class="vendor-card-icons">
            <button class="btn-icon js-delete-vendor" type="button" title="Eliminar canal" aria-label="Eliminar canal">🗑</button>
          </div>
        </div>

        <div class="vendor-identity">
          <div class="avatar" style="background:${colorFor(v.id)}">${initials(v.name)}</div>
          <div>
            <div class="vendor-name">${escapeHtml(v.name)}</div>
            <div class="vendor-phone">${escapeHtml(v.phone_number) || '—'}</div>
          </div>
        </div>

        <button type="button" class="vendor-assigned js-open-assign">
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
          <button type="button" class="btn js-open-settings">⚙ Configurar</button>
          <button type="button" class="btn" disabled title="Próximamente">📊 Pixel</button>
          <button type="button" class="btn" disabled title="Próximamente">📋 Formularios</button>
          <button type="button" class="btn js-open-assign">👤 Asignar</button>
          <button type="button" class="btn" disabled title="Próximamente">⬆ Importar</button>
          <button type="button" class="btn btn-danger js-delete-vendor">🗑 Eliminar</button>
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
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
    const path = `${prospectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
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

async function createVendorEvolution(fd, name, system_prompt) {
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
    system_prompt,
    ai_api_key: '',
  });

  if (error) throw new Error(error.message);
}

async function createVendorMeta(fd, name, system_prompt) {
  const phone_number = fd.get('meta_phone_number')?.toString().trim() || null;
  const phone_number_id = fd.get('meta_phone_number_id')?.toString().trim();
  const waba_id = fd.get('meta_waba_id')?.toString().trim();
  const access_token = fd.get('meta_access_token')?.toString().trim();

  if (!phone_number_id || !waba_id || !access_token) {
    throw new Error('Phone Number ID, WABA ID y el access token son obligatorios.');
  }

  const resp = await fetch(`${FUNCTIONS_URL}/meta-exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      access_token,
      phone_number_id,
      waba_id,
      vendor_name: name,
      system_prompt: system_prompt || undefined,
    }),
  });
  const json = await resp.json();
  if (!resp.ok || json.error) throw new Error(json.error || `HTTP ${resp.status}`);

  if (phone_number) {
    const { error } = await supabase.from('vendors').update({ phone_number }).eq('id', json.vendor_id);
    if (error) throw new Error(error.message);
  }
}

async function createVendor(ev) {
  ev.preventDefault();
  const fd = new FormData(vendorForm);
  const name = fd.get('name')?.toString().trim();
  const system_prompt = fd.get('system_prompt')?.toString().trim() || null;
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
      await createVendorMeta(fd, name, system_prompt);
    } else {
      await createVendorEvolution(fd, name, system_prompt);
    }
  } catch (err) {
    vendorStatus.textContent = `Error: ${err.message}`;
    vendorStatus.className = 'settings-status err';
    return;
  }

  vendorStatus.textContent = 'Canal creado ✓';
  vendorStatus.className = 'settings-status ok';
  await loadVendors();
  vendorForm.reset();
  updateVendorFormConnectionType();
  setTimeout(() => (vendorOverlay.hidden = true), 600);
}

// ── Crear vendedor (agente) ──────────────────────────────────────────────────

async function createAgent(ev) {
  ev.preventDefault();
  const fd = new FormData(agentForm);
  const name = fd.get('name')?.toString().trim();
  if (!name) {
    agentStatus.textContent = 'El nombre es obligatorio.';
    agentStatus.className = 'settings-status err';
    return;
  }

  agentStatus.textContent = 'Creando…';
  agentStatus.className = 'settings-status';

  const { error } = await supabase.from('agents').insert({
    name,
    email: fd.get('email')?.toString().trim() || null,
    phone: fd.get('phone')?.toString().trim() || null,
  });

  if (error) {
    agentStatus.textContent = `Error: ${error.message}`;
    agentStatus.className = 'settings-status err';
    return;
  }

  agentStatus.textContent = 'Vendedor creado ✓';
  agentStatus.className = 'settings-status ok';
  await loadAgents();
  renderVendorCards();
  agentForm.reset();
  setTimeout(() => (agentOverlay.hidden = true), 600);
}

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

document.getElementById('create-agent-btn').addEventListener('click', () => {
  agentForm.reset();
  agentStatus.textContent = '';
  agentOverlay.hidden = false;
});
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

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!drawerOverlay.hidden) closeDrawer();
  if (!settingsOverlay.hidden) settingsOverlay.hidden = true;
  if (!vendorOverlay.hidden) vendorOverlay.hidden = true;
  if (!agentOverlay.hidden) agentOverlay.hidden = true;
  if (!assignOverlay.hidden) assignOverlay.hidden = true;
  if (!customfieldOverlay.hidden) customfieldOverlay.hidden = true;
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  await Promise.all([loadAgents(), loadVendors(), loadCustomFields()]);
  setSection('canales-lista');
  if (state.vendorId) {
    await loadProspects();
    subscribeVendor(state.vendorId);
  } else {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No hay vendors configurados todavía.</td></tr>`;
  }
})();
