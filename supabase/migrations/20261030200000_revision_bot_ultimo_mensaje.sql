-- bot_activity: agrega last_user_at (último mensaje de un cliente en el canal, sin límite de período)
-- para distinguir "nadie escribió" de "los mensajes ya no están llegando al CRM".
create or replace function public.bot_activity(p_hours integer default 6)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with win as (
    select now() - make_interval(hours => least(greatest(p_hours, 1), 72)) as since
  ),
  msgs as (
    select m.prospect_id, m.role, m.by_ai, m.by_automation, m.created_at
    from public.messages m, win
    where m.created_at >= win.since
  ),
  last_msg as (
    select distinct on (prospect_id) prospect_id, role, created_at
    from msgs
    order by prospect_id, created_at desc
  ),
  per_prospect as (
    select p.id as prospect_id, p.vendor_id, p.nombre, p.phone, p.ia_enabled as prospect_ia,
           exists (select 1 from msgs x where x.prospect_id = p.id and x.role = 'user') as wrote,
           l.role = 'user' and l.created_at < now() - interval '2 minutes' as unanswered,
           l.created_at as last_at
    from public.prospects p
    join last_msg l on l.prospect_id = p.id
  )
  select coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'vendor_id', v.id,
      'name', v.name,
      'channel_type', v.channel_type,
      'ia_on', v.ai_key_set and v.ia_enabled,
      'ai_error_kind', v.ai_error_kind,
      'clients_written', count(*) filter (where pp.wrote),
      'ai_replies', coalesce((select count(*) from msgs m join public.prospects p2 on p2.id = m.prospect_id where p2.vendor_id = v.id and m.by_ai), 0),
      'human_replies', coalesce((select count(*) from msgs m join public.prospects p2 on p2.id = m.prospect_id where p2.vendor_id = v.id and m.role = 'assistant' and not m.by_ai and not m.by_automation), 0),
      'last_ai_reply_at', (select max(m.created_at) from public.messages m join public.prospects p2 on p2.id = m.prospect_id where p2.vendor_id = v.id and m.by_ai),
      'last_user_at', (select max(m.created_at) from public.messages m join public.prospects p2 on p2.id = m.prospect_id where p2.vendor_id = v.id and m.role = 'user'),
      'unanswered', coalesce(jsonb_agg(jsonb_build_object(
          'prospect_id', pp.prospect_id, 'name', pp.nombre, 'phone', pp.phone,
          'since', pp.last_at, 'ia_on', v.ai_key_set and v.ia_enabled and pp.prospect_ia
        ) order by pp.last_at) filter (where pp.unanswered), '[]'::jsonb)
    ) as row
    from public.vendors v
    left join per_prospect pp on pp.vendor_id = v.id
    group by v.id
  ) t;
$$;
