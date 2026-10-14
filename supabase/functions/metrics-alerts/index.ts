import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Resumen de métricas por WhatsApp para evaluar al equipo. Lo llama pg_cron cada día a las 08:05
// (hora de Lima) con el secreto compartido (cron_secret en Vault). Por empresa con
// metric_targets.alert_enabled:
//   - resumen diario: el día anterior (alert_daily);
//   - resumen semanal: la semana lunes-domingo anterior, solo los lunes (alert_weekly).
// Se avisa a los números de alerta de la empresa (availability_settings.alert_phones) y, si
// notify_agents está activo, a cada asesor que quedó bajo la meta. Un asesor "bajo" es el que no llega
// a la meta de alguna etapa con datos suficientes (metric_targets.min_sample). La regla de evaluación
// es la misma que usa el panel (MX_STAGES / mxEvaluate en dashboard/app.js). Si todo está en meta no
// se envía nada. last_daily_sent / last_weekly_sent evitan repetir el aviso si el cron corre dos veces.

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL')!;
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY')!;

type Totals = { leads: number; responde: number; agendo: number; asistio: number; separo: number; ventas: number };
type Row = Totals & { day: string; agent_id: string | null };
type Targets = Record<string, number | boolean | string | null> & { organization_id: string; min_sample: number };

const STAGES: { key: keyof Totals; base: keyof Totals; target: string; label: string; unit: string }[] = [
  { key: 'responde', base: 'leads', target: 'respuesta_min', label: 'Respuesta', unit: 'respuestas' },
  { key: 'agendo', base: 'responde', target: 'agenda_min', label: 'Agenda', unit: 'agendas' },
  { key: 'asistio', base: 'agendo', target: 'asistencia_min', label: 'Asistencia', unit: 'asistencias' },
  { key: 'separo', base: 'asistio', target: 'separacion_min', label: 'Separación', unit: 'separaciones' },
  { key: 'ventas', base: 'separo', target: 'venta_min', label: 'Venta', unit: 'ventas' },
];

const digits = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '');
const empty = (): Totals => ({ leads: 0, responde: 0, agendo: 0, asistio: 0, separo: 0, ventas: 0 });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-PE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

function sum(rows: Row[]): Totals {
  const t = empty();
  for (const r of rows) for (const k of Object.keys(t) as (keyof Totals)[]) t[k] += r[k] ?? 0;
  return t;
}

// Etapas "bajas" del asesor: por debajo del 80 % de la meta (igual que el estado "Bajo" del panel).
function lowStages(t: Totals, tg: Targets) {
  const out: { label: string; pct: number; target: number; need: number; unit: string }[] = [];
  for (const s of STAGES) {
    const base = t[s.base];
    if (!base || base < tg.min_sample) continue;
    const target = Number(tg[s.target]);
    const p = (t[s.key] / base) * 100;
    if (p >= target * 0.8) continue; // en meta o cerca
    out.push({ label: s.label, pct: p, target, need: Math.max(0, Math.ceil((target / 100) * base) - t[s.key]), unit: s.unit });
  }
  return out;
}

const sendersByOrg = new Map<string, { id: string; instance: string }[]>();

async function sendersFor(orgId: string) {
  if (!sendersByOrg.has(orgId)) {
    const { data } = await supabase
      .from('vendors')
      .select('id, evolution_instance_id')
      .eq('organization_id', orgId)
      .eq('channel_type', 'evolution')
      .eq('evolution_connected', true);
    sendersByOrg.set(
      orgId,
      (data ?? []).filter((v) => v.evolution_instance_id).map((v) => ({ id: v.id, instance: v.evolution_instance_id as string }))
    );
  }
  return sendersByOrg.get(orgId)!;
}

// Se prueba con cada canal QR conectado hasta que uno envíe. Meta no sirve: solo permite texto libre
// dentro de las 24 h de un mensaje del cliente.
async function send(orgId: string, phone: string, text: string): Promise<boolean> {
  for (const s of await sendersFor(orgId)) {
    try {
      const resp = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(s.instance)}`, {
        method: 'POST',
        headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ number: phone, text }),
      });
      if (resp.ok) return true;
      console.warn('[metrics-alerts] el canal', s.instance, 'no pudo enviar:', resp.status, (await resp.text()).slice(0, 160));
    } catch (e) {
      console.warn('[metrics-alerts] error enviando por', s.instance, e);
    }
  }
  return false;
}

async function summarize(org: Targets, from: string, to: string, title: string): Promise<boolean> {
  const orgId = org.organization_id;
  const { data, error } = await supabase.rpc('metrics_daily', { p_org: orgId, p_from: from, p_to: to });
  if (error) {
    console.error('[metrics-alerts] no se pudo calcular', orgId, error.message);
    return false;
  }
  const rows = (data ?? []) as Row[];
  if (!rows.length) return true; // sin actividad: nada que evaluar

  const byAgent = new Map<string | null, Row[]>();
  for (const r of rows) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);

  const { data: agents } = await supabase.from('agents').select('id, name, phone').eq('organization_id', orgId);
  const agentById = new Map((agents ?? []).map((a) => [a.id as string, a]));

  const team = sum(rows);
  const lines: string[] = [];
  const perAgent: { phone: string; text: string }[] = [];
  for (const [id, list] of byAgent) {
    const low = lowStages(sum(list), org);
    if (!low.length) continue;
    const name = id ? agentById.get(id)?.name ?? 'Asesor' : 'Sin asignar';
    const detail = low.map((l) => `${l.label} ${pct(l.pct)} (meta ${pct(l.target)}, faltan ${l.need} ${l.unit})`).join('\n   • ');
    lines.push(`⚠️ *${name}*\n   • ${detail}`);
    const phone = id ? digits(agentById.get(id)?.phone) : '';
    if (org.notify_agents && phone) {
      perAgent.push({ phone, text: `📊 *${title}*\n\nTu embudo quedó bajo la meta:\n   • ${detail}\n\nRevisa tus leads en el CRM.` });
    }
  }
  if (!lines.length) return true; // todo en meta: no se molesta a nadie

  const head = `📊 *${title}*\n\nEquipo: ${team.leads} leads · ${team.responde} respuestas · ${team.agendo} agendas · ${team.asistio} visitas · ${team.separo} separaciones · ${team.ventas} ventas`;
  const text = `${head}\n\n${lines.join('\n\n')}`;

  const { data: settings } = await supabase.from('availability_settings').select('alert_phones').eq('organization_id', orgId).maybeSingle();
  let sent = false;
  for (const p of settings?.alert_phones ?? []) {
    if (await send(orgId, digits(p), text)) sent = true;
  }
  for (const a of perAgent) await send(orgId, a.phone, a.text);
  return sent || !(settings?.alert_phones ?? []).length;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const yesterday = addDays(today, -1);
  const isMonday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1;

  const { data: targets, error } = await supabase
    .from('metric_targets')
    .select('*, organization:organizations!inner(is_active, plan_expires_at, enabled_sections)')
    .eq('alert_enabled', true);
  if (error) {
    console.error('[metrics-alerts] no se pudo consultar:', error.message);
    return new Response('error', { status: 500 });
  }

  let daily = 0;
  let weekly = 0;
  for (const raw of (targets ?? []) as (Targets & { organization: { is_active: boolean; plan_expires_at: string | null; enabled_sections: string[] | null } })[]) {
    const { organization: org, ...tg } = raw;
    const expired = org.plan_expires_at && org.plan_expires_at < today;
    const hasModule = !org.enabled_sections || org.enabled_sections.includes('metricas');
    if (!org.is_active || expired || !hasModule) continue;

    if (tg.alert_daily && tg.last_daily_sent !== today) {
      if (await summarize(tg, yesterday, yesterday, `Métricas de ayer · ${fmtDay(yesterday)}`)) {
        await supabase.from('metric_targets').update({ last_daily_sent: today }).eq('organization_id', tg.organization_id);
        daily++;
      }
    }
    if (isMonday && tg.alert_weekly && tg.last_weekly_sent !== today) {
      const from = addDays(today, -7);
      const to = addDays(today, -1);
      if (await summarize(tg, from, to, `Métricas de la semana · ${fmtDay(from)} al ${fmtDay(to)}`)) {
        await supabase.from('metric_targets').update({ last_weekly_sent: today }).eq('organization_id', tg.organization_id);
        weekly++;
      }
    }
  }

  return new Response(JSON.stringify({ daily, weekly }), { headers: { 'content-type': 'application/json' } });
});
