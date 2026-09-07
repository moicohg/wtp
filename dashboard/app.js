import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Config ───────────────────────────────────────────────────────────────────
// La anon/publishable key es segura de exponer en el cliente: solo permite
// SELECT (ver políticas RLS en supabase/migrations). Las escrituras pasan por
// las Edge Functions, que usan la service_role key en el servidor.

const SUPABASE_URL = 'https://znalzptpffnbnzuckiid.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_OyjpoUWipe8vJL5GNgQjWw_WVtmGGFE';
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Estado ───────────────────────────────────────────────────────────────────

const state = {
  vendors: [],
  vendorId: null,
  prospects: [],
  filter: 'TODOS',
  search: '',
  sortKey: 'score',
  sortDir: 'desc',
  activeProspectId: null,
  channel: null,
  threadChannel: null,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

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
const settingsForm = document.getElementById('settings-form');
const settingsStatus = document.getElementById('settings-status');

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
    vendorSelect.value = state.vendorId;
  }
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

// ── Render: tabla ────────────────────────────────────────────────────────────

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

async function openDrawer(prospectId) {
  const p = state.prospects.find((x) => x.id === prospectId);
  if (!p) return;
  state.activeProspectId = prospectId;

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

  messagesThread.innerHTML = '<p style="color:var(--text-dim);font-size:13px;">Cargando conversación…</p>';
  drawerOverlay.hidden = false;

  const messages = await loadMessages(prospectId);
  renderThread(messages);
  subscribeThread(prospectId);
}

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

// ── Configuración del vendor ─────────────────────────────────────────────────

function openSettings() {
  const v = state.vendors.find((x) => x.id === state.vendorId);
  if (!v) return;
  settingsForm.elements['ai_provider'].value = v.ai_provider;
  settingsForm.elements['ai_model'].value = v.ai_model ?? '';
  settingsForm.elements['ai_api_key'].value = '';
  settingsForm.elements['system_prompt'].value = v.system_prompt ?? '';
  settingsStatus.textContent = '';
  settingsStatus.className = 'settings-status';
  settingsOverlay.hidden = false;
}

async function saveSettings(ev) {
  ev.preventDefault();
  const fd = new FormData(settingsForm);
  const payload = {
    vendor_id: state.vendorId,
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
    settingsStatus.textContent = 'Guardado ✓';
    settingsStatus.className = 'settings-status ok';
    await loadVendors();
    setTimeout(() => (settingsOverlay.hidden = true), 700);
  } catch (err) {
    settingsStatus.textContent = `Error: ${err.message}`;
    settingsStatus.className = 'settings-status err';
  }
}

// ── Eventos ──────────────────────────────────────────────────────────────────

vendorSelect.addEventListener('change', async () => {
  state.vendorId = vendorSelect.value;
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

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => (settingsOverlay.hidden = true));
settingsOverlay.addEventListener('click', (ev) => {
  if (ev.target === settingsOverlay) settingsOverlay.hidden = true;
});
settingsForm.addEventListener('submit', saveSettings);

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!drawerOverlay.hidden) closeDrawer();
  if (!settingsOverlay.hidden) settingsOverlay.hidden = true;
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  await loadVendors();
  if (state.vendorId) {
    await loadProspects();
    subscribeVendor(state.vendorId);
  } else {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No hay vendors configurados todavía.</td></tr>`;
  }
})();
