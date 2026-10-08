import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Avisa por WhatsApp cuando un lead CALIFICADO lleva más de alert_minutes esperando a una persona
// (las respuestas del bot no cuentan). Lo llama pg_cron cada minuto con el secreto compartido
// (cron_secret en Vault). La regla vive en la función SQL leads_waiting_for_reply():
//   1. a alert_minutes avisa al asesor responsable del lead;
//   2. a 2 × alert_minutes (o de inmediato si el asesor no tiene teléfono) escala a los números
//      configurados por la empresa.
// Cada aviso se marca en prospects (alerted_*_for = desde cuándo espera): no se repite hasta que
// una persona responda y el lead vuelva a esperar.

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL')!;
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY')!;

interface WaitingLead {
  prospect_id: string;
  organization_id: string;
  vendor_id: string;
  vendor_name: string;
  lead_name: string;
  lead_phone: string;
  waiting_since: string;
  waiting_minutes: number;
  agent_name: string | null;
  agent_phone: string | null;
  alert_phones: string[];
  need_agent: boolean;
  need_owner: boolean;
}

const digits = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '');

// Canales QR conectados por empresa, para enviar desde ellos. Se cachea durante la corrida.
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
      (data ?? []).filter(v => v.evolution_instance_id).map(v => ({ id: v.id, instance: v.evolution_instance_id as string }))
    );
  }
  return sendersByOrg.get(orgId)!;
}

// Se prueba primero con el canal del lead y luego con los demás hasta que uno envíe.
// Meta no sirve: solo permite texto libre dentro de las 24 h de un mensaje del cliente.
async function sendAlert(lead: WaitingLead, phone: string, text: string): Promise<boolean> {
  const senders = [...(await sendersFor(lead.organization_id))].sort(
    (a, b) => Number(b.id === lead.vendor_id) - Number(a.id === lead.vendor_id)
  );
  for (const s of senders) {
    try {
      const resp = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(s.instance)}`, {
        method: 'POST',
        headers: { apikey: EVOLUTION_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ number: phone, text }),
      });
      if (resp.ok) return true;
      console.warn('[lead-alerts] el canal', s.instance, 'no pudo enviar:', resp.status, (await resp.text()).slice(0, 160));
    } catch (e) {
      console.warn('[lead-alerts] error enviando por', s.instance, e);
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { data, error } = await supabase.rpc('leads_waiting_for_reply');
  if (error) {
    console.error('[lead-alerts] no se pudo consultar:', error.message);
    return new Response('error', { status: 500 });
  }

  let toAgent = 0;
  let toOwner = 0;
  for (const lead of (data ?? []) as WaitingLead[]) {
    const detail = `${lead.lead_name} (${lead.lead_phone}) en el canal ${lead.vendor_name}`;

    if (lead.need_agent) {
      const phone = digits(lead.agent_phone);
      // Sin teléfono no hay a quién avisar: se marca igual para no reintentar cada minuto.
      const sent = phone
        ? await sendAlert(
            lead,
            phone,
            `⚠️ *Lead sin responder*\n\n${detail} lleva ${lead.waiting_minutes} min esperando una respuesta.\n\nEntra al CRM y atiéndelo.`
          )
        : true;
      if (sent) {
        await supabase.from('prospects').update({ alerted_agent_for: lead.waiting_since }).eq('id', lead.prospect_id);
        if (phone) toAgent++;
      }
    }

    if (lead.need_owner) {
      const who = lead.agent_name ? `${lead.agent_name} no ha respondido` : 'Nadie ha respondido';
      const text = `🚨 *Lead sin atender*\n\n${detail} lleva ${lead.waiting_minutes} min esperando. ${who}.`;
      let anySent = false;
      for (const p of lead.alert_phones) {
        if (await sendAlert(lead, digits(p), text)) anySent = true;
      }
      if (anySent) {
        await supabase.from('prospects').update({ alerted_owner_for: lead.waiting_since }).eq('id', lead.prospect_id);
        toOwner++;
      }
    }
  }

  return new Response(JSON.stringify({ toAgent, toOwner }), { headers: { 'content-type': 'application/json' } });
});
