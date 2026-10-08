import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Motor de cadencias: lo llama pg_cron cada 5 minutos con el secreto compartido (cron_secret en
// Vault). Envía por WhatsApp el paso que le toca a cada lead inscrito en una cadencia "activa".
// Qué paso toca y cuándo lo decide due_automation_steps() (migración 20260930300000); aquí se
// aplican las salidas, se envía y se avanza. Reglas completas en el README ("Cadencias").

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL');
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY');
const GRAPH_VERSION = 'v20.0';

// Un paso que no pudo salir en tanto tiempo se omite (canal caído, ventana de 24 h de Meta…).
const MAX_LATE_MS = 12 * 3600_000;

interface DueStep {
  enrollment_id: string;
  prospect_id: string;
  vendor_id: string;
  step_index: number;
  step: { title?: string; message?: string } | null;
  scheduled_at: string;
  ignore_exit: boolean;
  etapa: string | null;
  label: string | null;
  estado: string;
  nombre: string | null;
  phone: string;
}

interface Vendor {
  id: string;
  channel_type: 'evolution' | 'meta';
  evolution_instance_id: string | null;
  meta_phone_number_id: string | null;
  meta_access_token: string | null;
}

const vendors = new Map<string, Vendor | null>();
async function vendorOf(id: string): Promise<Vendor | null> {
  if (!vendors.has(id)) {
    const { data } = await supabase
      .from('vendors')
      .select('id, channel_type, evolution_instance_id, meta_phone_number_id, meta_access_token')
      .eq('id', id)
      .maybeSingle();
    vendors.set(id, (data as Vendor) ?? null);
  }
  return vendors.get(id)!;
}

// {{nombre}} = primer nombre del lead. Sin nombre se quita y se ordena la puntuación que queda suelta.
function renderMessage(template: string, nombre: string | null): string {
  const first = (nombre ?? '').trim().split(/\s+/)[0] ?? '';
  return template
    .replace(/\{\{\s*nombre\s*\}\}/gi, first)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^[,.\s]+/, '')
    .trim();
}

async function sendText(v: Vendor, phone: string, text: string): Promise<void> {
  if (v.channel_type === 'evolution') {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_URL / EVOLUTION_API_KEY no configurados');
    if (!v.evolution_instance_id) throw new Error('El canal no tiene instancia de Evolution');
    const resp = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(v.evolution_instance_id)}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ number: phone, text }),
    });
    if (!resp.ok) throw new Error(`Evolution API respondió ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return;
  }
  if (!v.meta_phone_number_id || !v.meta_access_token) throw new Error('El canal no tiene credenciales de Meta');
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${v.meta_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${v.meta_access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } }),
  });
  // Meta solo deja texto libre dentro de las 24 h posteriores a un mensaje del cliente.
  if (!resp.ok) throw new Error(`Meta Graph API respondió ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

async function endEnrollment(id: string, status: 'completada' | 'cancelada', reason: string | null) {
  await supabase
    .from('automation_enrollments')
    .update({ status, ended_at: new Date().toISOString(), exit_reason: reason })
    .eq('id', id)
    .eq('status', 'activa');
}

// Motivo de salida del lead, o null si sigue en la cadencia.
function exitReason(d: DueStep): string | null {
  if (d.etapa === 'perdido' || d.label === 'DESCARTADO') return 'perdido';
  if (d.estado !== 'activo') return 'chat_inactivo';
  if (!d.ignore_exit && (d.etapa === 'por_depositar' || d.etapa === 'venta')) return 'conversion';
  return null;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { data, error } = await supabase.rpc('due_automation_steps');
  if (error) {
    console.error('[automation-runner] no se pudo consultar:', error.message);
    return new Response('error', { status: 500 });
  }

  const result = { sent: 0, skipped: 0, exited: 0, completed: 0, failed: 0 };
  for (const d of (data ?? []) as DueStep[]) {
    try {
      if (!d.step) {
        await endEnrollment(d.enrollment_id, 'completada', null);
        result.completed++;
        continue;
      }
      const reason = exitReason(d);
      if (reason) {
        await endEnrollment(d.enrollment_id, 'cancelada', reason);
        result.exited++;
        continue;
      }

      const text = renderMessage(d.step.message ?? '', d.nombre);
      const tooLate = Date.now() - new Date(d.scheduled_at).getTime() > MAX_LATE_MS;

      // Se reclama el paso (avanza el contador) antes de enviar: si dos corridas se cruzan, solo una lo toma.
      const { data: claimed } = await supabase
        .from('automation_enrollments')
        .update({ current_step: d.step_index + 1, last_error: tooLate ? 'Omitido: pasaron más de 12 h de su hora' : null })
        .eq('id', d.enrollment_id)
        .eq('status', 'activa')
        .eq('current_step', d.step_index)
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      if (tooLate || !text) {
        result.skipped++;
        continue;
      }

      const vendor = await vendorOf(d.vendor_id);
      try {
        if (!vendor) throw new Error('Canal no encontrado');
        await sendText(vendor, d.phone, text);
      } catch (e) {
        // No salió: se devuelve el paso para reintentar en la próxima corrida (hasta que pase de las 12 h).
        await supabase
          .from('automation_enrollments')
          .update({ current_step: d.step_index, last_error: String(e instanceof Error ? e.message : e).slice(0, 300) })
          .eq('id', d.enrollment_id)
          .eq('current_step', d.step_index + 1);
        console.warn('[automation-runner] no se pudo enviar el paso', d.step_index, 'de', d.enrollment_id, e);
        result.failed++;
        continue;
      }

      // El mensaje queda en el chat, marcado como automático (no cuenta como respuesta humana).
      await supabase.from('messages').insert({ prospect_id: d.prospect_id, role: 'assistant', content: text, by_automation: true });
      await supabase.from('automation_enrollments').update({ last_sent_at: new Date().toISOString() }).eq('id', d.enrollment_id);
      result.sent++;
    } catch (e) {
      console.error('[automation-runner] error con la inscripción', d.enrollment_id, e);
      result.failed++;
    }
  }

  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
});
