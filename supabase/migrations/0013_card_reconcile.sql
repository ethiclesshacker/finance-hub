-- ============================================================
-- Reconciliation you can finish
--
-- 0012's cc_reconcile() listed every typed row with no card alert and every
-- alert with no row. Two things made that a poor tool. Most of the first list
-- needed nothing: a row whose alert never arrived is fine as it is, and showing
-- fifty-one rows to find the seventeen worth a look buries them. And neither
-- list could ever be emptied — there was no way to say "I have looked at this,
-- it is fine", so the same rows came back every visit.
--
-- So a decision is now something the database remembers:
--
--   cc_transactions.no_alert   "this row has no card alert, and that is fine"
--   cc_ignored_events          "this alert needs no row" — it earned nothing, or
--                              it is already inside a row that pools several
--                              spends ("Cabs: various"), which is the one case
--                              a one-row-one-event link cannot express
--
-- cc_reconcile() returns only what still needs a decision, split by what kind
-- of decision it is:
--
--   to_match            typed rows with at least one plausible alert, each with
--                       up to five candidates, best first — the suggestion can
--                       be wrong, and the right one is usually next to it
--   no_alert_found      typed rows with no plausible alert; nothing to do but
--                       acknowledge, which can be done for all of them at once
--   events_without_row  alerts with no row, minus the ignored ones
--
-- Both decisions can be undone (pass false).
--
-- Run order: after 0012_card_points.sql. Safe to re-run.
-- ============================================================

alter table public.cc_transactions
  add column if not exists no_alert boolean not null default false;

create table if not exists public.cc_ignored_events (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  event_id   uuid        not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

alter table public.cc_ignored_events enable row level security;
drop policy if exists cc_ignored_events_owner on public.cc_ignored_events;
create policy cc_ignored_events_owner on public.cc_ignored_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.cc_ignored_events to authenticated;
grant all on public.cc_ignored_events to service_role;


create or replace function public.cc_mark_no_alert(p_ids uuid[], p_value boolean default true, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  update public.cc_transactions c set no_alert = p_value
   where c.user_id = v_user and c.id = any (p_ids) and c.event_id is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end;
$$;

create or replace function public.cc_ignore_events(p_event_ids uuid[], p_ignore boolean default true, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  if p_ignore then
    insert into public.cc_ignored_events (user_id, event_id)
    select v_user, ce.event_id from public.cc_card_events(v_user) ce where ce.event_id = any (p_event_ids)
    on conflict do nothing;
  else
    delete from public.cc_ignored_events i where i.user_id = v_user and i.event_id = any (p_event_ids);
  end if;
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end;
$$;


create or replace function public.cc_reconcile(p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with free_events as (
    select ce.*, r.label as rule_label
      from public.cc_card_events(v_user) ce
      left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
     where not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
       and not exists (select 1 from public.cc_ignored_events i where i.user_id = v_user and i.event_id = ce.event_id)
  ),
  free_rows as (
    select c.* from public.cc_transactions c
     where c.user_id = v_user and c.event_id is null and not c.no_alert
  ),
  -- Same test as 0012: within a few days, and within half the amount when a
  -- rule files the alert under the row's label, or a quarter when it does not.
  candidates as (
    select fr.id as row_id, fe.event_id, fe.day, fe.amount, fe.merchant,
           case when fe.rule_label = fr.merchant then 'same label' else 'close amount' end as why,
           row_number() over (partition by fr.id order by
             (fe.rule_label = fr.merchant) desc nulls last,
             abs(fe.amount - fr.amount) / nullif(fr.amount, 0),
             abs(fe.day - fr.date)) as rank
      from free_rows fr
      join free_events fe on abs(fe.day - fr.date) <= 4
       and abs(fe.amount - fr.amount) / nullif(fr.amount, 0) <= case when fe.rule_label = fr.merchant then 0.5 else 0.25 end
  ),
  per_row as (
    select c.row_id, jsonb_agg(jsonb_build_object('event_id', c.event_id, 'date', c.day, 'amount', c.amount,
                                                   'merchant', c.merchant, 'why', c.why) order by c.rank) as list
      from candidates c where c.rank <= 5 group by c.row_id
  )
  select jsonb_build_object(
    'to_match', coalesce((
      select jsonb_agg(jsonb_build_object('id', fr.id, 'date', fr.date, 'label', fr.merchant, 'amount', fr.amount,
                                          'multiplier', fr.multiplier, 'candidates', p.list) order by fr.date desc)
        from free_rows fr join per_row p on p.row_id = fr.id), '[]'::jsonb),
    'no_alert_found', coalesce((
      select jsonb_agg(jsonb_build_object('id', fr.id, 'date', fr.date, 'label', fr.merchant, 'amount', fr.amount) order by fr.date desc)
        from free_rows fr where not exists (select 1 from per_row p where p.row_id = fr.id)), '[]'::jsonb),
    'events_without_row', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'event_id', fe.event_id, 'date', fe.day, 'merchant', fe.merchant, 'title', fe.title, 'amount', fe.amount,
               'would_be_label', coalesce(fe.rule_label, fe.merchant))) order by fe.day desc)
        from free_events fe), '[]'::jsonb),
    'settled', jsonb_build_object(
      'rows_marked_fine', (select count(*) from public.cc_transactions c where c.user_id = v_user and c.event_id is null and c.no_alert),
      'alerts_ignored',   (select count(*) from public.cc_ignored_events i where i.user_id = v_user))
  ) into v_out;

  return v_out;
end;
$$;

-- An ignored alert must never be turned into a row by the sync either.
create or replace function public.cc_sync_from_events(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user    uuid := coalesce(p_user_id, auth.uid());
  v_from    date;
  v_created int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  select (s.value #>> '{}')::date into v_from
    from public.user_settings s where s.user_id = v_user and s.key = 'cc_auto_from';

  if v_from is null then
    select coalesce(max(c.date) + 1, current_date) into v_from
      from public.cc_transactions c where c.user_id = v_user and c.basis = 'manual';
    insert into public.user_settings (user_id, key, value)
    values (v_user, 'cc_auto_from', to_jsonb(v_from::text))
    on conflict (user_id, key) do nothing;
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, 2), null, ce.event_id, 'assumed', ce.merchant
    from public.cc_card_events(v_user) ce
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.day >= v_from
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
     and not exists (select 1 from public.cc_ignored_events i where i.user_id = v_user and i.event_id = ce.event_id);

  get diagnostics v_created = row_count;
  return jsonb_build_object('created', v_created, 'auto_from', v_from,
    'assumed_waiting', (select count(*) from public.cc_transactions c where c.user_id = v_user and c.basis = 'assumed'));
end;
$$;

-- ────────────────────────────────────────────────────────────
-- A link follows a merge
--
-- The ledger folds duplicate events together, and deletes the one it absorbed.
-- cc_transactions.event_id is ON DELETE SET NULL, so a points row pointing at
-- the absorbed event would quietly lose its link — and because a merge copies
-- the card account onto the surviving event, the sync would then see "a spend
-- on the card with no row" and make a second one. ledger_merge_events() writes
-- an 'events_merged' audit entry before it deletes, naming both; this trigger
-- reads that entry and moves the link to the survivor.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_follow_merge()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  v_absorbed uuid := nullif(new.before -> 'absorbed' ->> 'id', '')::uuid;
begin
  if v_absorbed is not null and new.record_id is not null then
    update public.cc_transactions c
       set event_id = new.record_id
     where c.event_id = v_absorbed
       and not exists (select 1 from public.cc_transactions x where x.event_id = new.record_id);
  end if;
  return new;
end;
$$;

drop trigger if exists cc_follow_merge on public.ledger_audit_log;
create trigger cc_follow_merge
  after insert on public.ledger_audit_log
  for each row when (new.action = 'events_merged')
  execute function public.cc_follow_merge();


do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.cc_mark_no_alert(uuid[], boolean, uuid)',
    'public.cc_ignore_events(uuid[], boolean, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
