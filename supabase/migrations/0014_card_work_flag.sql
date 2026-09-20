-- ============================================================
-- Work is a tick-box, not a label
--
-- 0012 took "work spend" to mean "filed under the work label", because that is
-- how the rows had been typed: every work spend was labelled with the
-- employer's name, whoever was actually paid. It did its job — it pooled work
-- spend into one number — at the cost of the merchant. The biggest slice of the
-- merchant chart became a single opaque block, and nothing could say that the
-- block was mostly one travel portal and one software subscription.
--
-- A label answers "who did I pay". Work answers "why". They are different
-- questions, so they get different columns: `is_work` on the row and on the
-- rule, and the label goes back to being the merchant. The cc_work_label
-- setting is no longer read.
--
-- A learned rule is work only when the label nearly always was (at least three
-- rows, four in five of them work). A marketplace or a cab company that is merely often work defaults
-- to personal, and you tick the box on the exception.
--
-- This file adds the columns and carries the flag over from the old label.
-- Choosing new labels for those rows needs to know what each one really was,
-- which is data, not schema.
--
-- Run order: after 0013_card_reconcile.sql. Safe to re-run.
-- ============================================================

alter table public.cc_transactions   add column if not exists is_work boolean not null default false;
alter table public.cc_merchant_rules add column if not exists is_work boolean not null default false;

-- Carry the old meaning over, once: a row under the work label was work.
update public.cc_transactions c
   set is_work = true
  from public.user_settings s
 where s.user_id = c.user_id and s.key = 'cc_work_label'
   and c.merchant = (s.value #>> '{}') and not c.is_work;

update public.cc_merchant_rules r
   set is_work = true
  from public.user_settings s
 where s.user_id = r.user_id and s.key = 'cc_work_label'
   and r.label = (s.value #>> '{}') and not r.is_work;

-- The read view gains the flag (appended last: a view's columns cannot be reordered).
create or replace view public.cc_points
with (security_invoker = true) as
select c.id, c.user_id, c.event_id, c.basis,
       c.merchant, c.raw_merchant, c.multiplier, c.points,
       coalesce((e.occurred_at at time zone public.ledger_setting_text(c.user_id, 'ledger_timezone', 'Asia/Kolkata'))::date, c.date) as date,
       coalesce(case when (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'amount')::numeric end, c.amount) as amount,
       -- The event's note when there is an event; the typed one only as a
       -- fallback, for a row with no event or whose event has gone.
       coalesce(nullif(btrim(e.description), ''), nullif(btrim(c.description), '')) as description,
       case when e.id is not null then 'event' else 'typed' end as source,
       case when e.id is not null and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
             and abs((e.data ->> 'amount')::numeric - c.amount) >= 1 then c.amount end as amount_typed,
       c.is_work
  from public.cc_transactions c
  left join public.events e on e.id = c.event_id;


create or replace function public.cc_learn_rules(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with taught as (
    select public.ledger_normalize_name(c.raw_merchant) as merchant_key, c.raw_merchant, c.merchant as label, c.multiplier, c.is_work
      from public.cc_transactions c
     where c.user_id = v_user and c.event_id is not null and c.basis in ('manual', 'confirmed')
       and nullif(btrim(c.raw_merchant), '') is not null
       and lower(btrim(c.merchant)) <> 'unknown merchant'
  ),
  per_key as (
    select t.merchant_key, count(*) as uses, count(distinct t.label) > 1 as ambiguous,
           mode() within group (order by t.label)        as label,
           mode() within group (order by t.multiplier)   as multiplier,
           mode() within group (order by t.raw_merchant) as ledger_merchant
      from taught t
     where t.merchant_key is not null and t.merchant_key <> ''
     group by t.merchant_key
  )
  -- Is this label work? Judged on every row filed under it, not only the rows
  -- that happen to be linked to an alert — a subscription billed abroad may have
  -- a dozen typed rows and two alerts. Work only when it nearly always was: at
  -- least three rows, four in five of them work. A merchant that is merely often
  -- work (a cab company, a marketplace) defaults to personal, because a missed
  -- tick is cheaper than a personal spend quietly filed as reimbursable.
  , label_stats as (
    select c.merchant as label, count(*) as n, count(*) filter (where c.is_work) as w
      from public.cc_transactions c
     where c.user_id = v_user and c.basis in ('manual', 'confirmed')
     group by c.merchant
  )
  insert into public.cc_merchant_rules as r (user_id, merchant_key, ledger_merchant, label, multiplier, ambiguous, source, uses, is_work)
  select v_user, k.merchant_key, k.ledger_merchant, k.label, k.multiplier, k.ambiguous, 'learned', k.uses,
         coalesce(ls.n >= 3 and ls.w::numeric / ls.n >= 0.8, false)
    from per_key k
    left join label_stats ls on ls.label = k.label
  on conflict (user_id, merchant_key) do update
     set ledger_merchant = excluded.ledger_merchant, label = excluded.label, multiplier = excluded.multiplier,
         ambiguous = excluded.ambiguous, uses = excluded.uses, is_work = excluded.is_work, updated_at = now()
   where r.source = 'learned';

  get diagnostics v_n = row_count;
  return jsonb_build_object('rules_written', v_n,
    'rules_total', (select count(*) from public.cc_merchant_rules r where r.user_id = v_user));
end;
$$;


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

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant, is_work)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, 2), null, ce.event_id, 'assumed', ce.merchant, coalesce(r.is_work, false)
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


create or replace function public.cc_create_from_event(p_event_id uuid, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_row  public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant, is_work)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, 2), null, ce.event_id, 'assumed', ce.merchant, coalesce(r.is_work, false)
    from public.cc_card_events(v_user) ce
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.event_id = p_event_id
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
  returning * into v_row;

  if v_row.id is null then
    raise exception 'that event is not an unlinked spend on the points card' using errcode = 'P0002';
  end if;
  return to_jsonb(v_row);
end;
$$;


drop function if exists public.cc_confirm(uuid, text, integer, numeric, boolean, text, uuid);
create or replace function public.cc_confirm(
  p_id uuid, p_label text default null, p_multiplier integer default null,
  p_points numeric default null, p_remember boolean default false,
  p_description text default null, p_is_work boolean default null, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_row  public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  update public.cc_transactions c
     set merchant    = coalesce(nullif(btrim(p_label), ''), c.merchant),
         multiplier  = coalesce(p_multiplier, c.multiplier),
         points      = coalesce(p_points, c.points),
         is_work     = coalesce(p_is_work, c.is_work),
         description = case when p_description is null then c.description else nullif(btrim(p_description), '') end,
         basis       = case when c.basis = 'assumed' then 'confirmed' else c.basis end
   where c.id = p_id and c.user_id = v_user
  returning c.* into v_row;

  if v_row.id is null then
    raise exception 'no such row' using errcode = 'P0002';
  end if;

  if p_description is not null and v_row.event_id is not null then
    update public.events e
       set description = nullif(btrim(p_description), '')
     where e.id = v_row.event_id and e.user_id = v_user;
  end if;

  if p_remember and nullif(btrim(v_row.raw_merchant), '') is not null then
    insert into public.cc_merchant_rules as r (user_id, merchant_key, ledger_merchant, label, multiplier, ambiguous, source, uses, is_work)
    values (v_user, public.ledger_normalize_name(v_row.raw_merchant), v_row.raw_merchant, v_row.merchant, v_row.multiplier, false, 'manual', 1, v_row.is_work)
    on conflict (user_id, merchant_key) do update
       set label = excluded.label, multiplier = excluded.multiplier, is_work = excluded.is_work, ambiguous = false, source = 'manual', updated_at = now();
  end if;

  return to_jsonb(v_row);
end;
$$;


create or replace function public.finance_card_points(p_from date default null, p_to date default null, p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with tx as (
    select c.date, c.merchant, c.amount, c.basis, c.is_work,
           coalesce(c.points, c.amount * c.multiplier / 100.0) as pts
      from public.cc_points c
     where c.user_id = v_user
  ),
  rd as (
    select r.date, r.partner, r.points_redeemed, r.value_amount, r.currency
      from public.cc_redemptions r
     where r.user_id = v_user
  ),
  in_range as (
    select * from tx t
     where (p_from is null or t.date >= p_from) and (p_to is null or t.date <= p_to)
  )
  select jsonb_build_object(
    -- The balance is lifetime by definition; the range only scopes the rest.
    'balance', round((select coalesce(sum(pts), 0) from tx) - (select coalesce(sum(points_redeemed), 0) from rd)),
    -- Points on rows nobody has looked at yet. Part of the balance, but a guess.
    'assumed', jsonb_build_object(
      'rows',   (select count(*) from tx where basis = 'assumed'),
      'points', round((select coalesce(sum(pts), 0) from tx where basis = 'assumed'))),
    'lifetime', jsonb_build_object(
      'accrued',  round((select coalesce(sum(pts), 0) from tx)),
      'redeemed', round((select coalesce(sum(points_redeemed), 0) from rd)),
      'spend',    round((select coalesce(sum(amount), 0) from tx)),
      'first_transaction', (select min(date) from tx),
      'last_transaction',  (select max(date) from tx)),
    'range', jsonb_build_object(
      'from', p_from, 'to', p_to,
      'spend',        round((select coalesce(sum(amount), 0) from in_range)),
      'work_spend',   round((select coalesce(sum(amount), 0) from in_range where is_work)),
      'points',       round((select coalesce(sum(pts), 0) from in_range)),
      'transactions', (select count(*) from in_range),
      'points_per_100', (select round((sum(pts) / nullif(sum(amount), 0) * 100)::numeric, 2) from in_range)),
    'by_month', coalesce((select jsonb_agg(to_jsonb(m) order by m.month)
                            from (select to_char(date_trunc('month', date), 'YYYY-MM') as month,
                                         round(sum(amount)) as spend, round(sum(pts)) as points, count(*) as transactions
                                    from in_range group by 1) m), '[]'::jsonb),
    'top_merchants', coalesce((select jsonb_agg(to_jsonb(t))
                                 from (select merchant, round(sum(amount)) as spend, round(sum(pts)) as points
                                         from in_range group by merchant order by sum(pts) desc limit 8) t), '[]'::jsonb),
    'redemptions', coalesce((select jsonb_agg(to_jsonb(r) order by r.date desc) from rd r), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;


create or replace function public.cc_work_spend(p_user_id uuid, p_from date, p_to date)
returns table (day date, amount numeric)
language sql stable
set search_path = public, pg_temp as $$
  select c.date, sum(c.amount)
    from public.cc_points c
   where c.user_id = p_user_id
     and c.event_id is not null
     and c.is_work
     and c.date between p_from and p_to
   group by c.date;
$$;

do $$
begin
  execute 'revoke all on function public.cc_confirm(uuid, text, integer, numeric, boolean, text, boolean, uuid) from public, anon';
  execute 'grant execute on function public.cc_confirm(uuid, text, integer, numeric, boolean, text, boolean, uuid) to authenticated, service_role';
end;
$$;
