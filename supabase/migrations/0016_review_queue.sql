-- ============================================================
-- A review queue that only asks real questions
--
-- An event is `inferred`, and sits in the review queue, when its confidence is
-- under the confirmed threshold (0.90). The queue grew past four hundred, and
-- every item in it sat between 0.80 and 0.88 — not a spread of doubt, but two
-- fixed numbers:
--
--   0.80–0.85  a deterministic rule read a structured email and one detail was
--              absent. A card alert with no merchant name is the bulk of it: the
--              bank said ₹370 left the card, which is a fact. Nothing was
--              guessed. The merchant is missing, not doubtful, and no amount of
--              reviewing will make the bank's email say more than it said.
--   0.88       the language model read a free-form email. Its confidence is
--              capped there on purpose (ledger/extract/llm.js), so that what a
--              model read is seen by a person before it is asserted.
--
-- So one queue was holding two unlike things, and the first kind — three
-- quarters of it — buried the second. "Did this happen?" is a fair question
-- about something a model interpreted. It is not a question about a bank alert.
--
-- ledger_auto_confirm() is the policy, in one place. An inferred event is
-- confirmed when any of these holds:
--
--   corroborated_by_user     a points row you typed or confirmed describes it
--   corroborated_by_sources  two or more independent sources agree it happened
--   read_by_rule             every source was read by a deterministic rule
--
-- Confidence is left exactly as it was: it still says how complete the detail
-- is. Only the status changes, and each change is written to the audit log with
-- its reason, so it can be found and undone. Events the model read alone stay
-- in the queue, which is what the cap is for.
--
-- Runs after every ingest. Idempotent.
--
-- Run order: after 0012_card_points.sql. Safe to re-run.
-- ============================================================

create or replace function public.ledger_auto_confirm(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user   uuid := coalesce(p_user_id, auth.uid());
  r        record;
  v_counts jsonb := '{}'::jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  for r in
    select e.id, e.status,
           case
             when exists (select 1 from public.cc_transactions c
                           where c.event_id = e.id and c.basis in ('manual', 'confirmed'))
               then 'corroborated_by_user'
             when (select count(*) from public.event_sources s where s.event_id = e.id) >= 2
               then 'corroborated_by_sources'
             when exists (select 1 from public.event_sources s where s.event_id = e.id)
              and not exists (select 1 from public.event_sources s
                               where s.event_id = e.id and coalesce(s.extracted_by, '') not like 'rules:%')
               then 'read_by_rule'
           end as reason
      from public.events e
     where e.user_id = v_user and e.status = 'inferred'
  loop
    continue when r.reason is null;
    update public.events set status = 'confirmed' where id = r.id;
    perform public.ledger_log(v_user, 'event_auto_confirmed', 'events', r.id,
      jsonb_build_object('status', r.status), jsonb_build_object('status', 'confirmed', 'reason', r.reason));
    v_counts := v_counts || jsonb_build_object(r.reason, coalesce((v_counts ->> r.reason)::int, 0) + 1);
  end loop;

  return jsonb_build_object(
    'confirmed', v_counts,
    'still_in_queue', (select count(*) from public.events e where e.user_id = v_user and e.status in ('inferred', 'needs_review')));
end;
$$;

-- Undo one run's worth, or all of them: put back every event this function
-- confirmed since `p_since`, unless something has changed its status since.
create or replace function public.ledger_undo_auto_confirm(p_since timestamptz, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  update public.events e set status = 'inferred'
   where e.user_id = v_user and e.status = 'confirmed'
     and e.id in (select l.record_id from public.ledger_audit_log l
                   where l.user_id = v_user and l.action = 'event_auto_confirmed' and l.at >= p_since);
  get diagnostics v_n = row_count;
  return jsonb_build_object('restored', v_n);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.ledger_auto_confirm(uuid)',
    'public.ledger_undo_auto_confirm(timestamptz, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
