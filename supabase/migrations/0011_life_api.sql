-- ============================================================
-- One life, three islands — the functions that join them
--
-- By 0010 this project held three stores that never met:
--
--   finance   net_worth_entries, cc_transactions, cc_redemptions, user_settings
--             — typed into the browser, read straight off the tables, and
--             invisible to Hermes;
--   ledger    events and everything around them — email, Hermes, manual;
--   health    Apple Health samples from the phone.
--
-- The cost of that showed up in the data. Weight lived in two places that
-- disagreed (ten recent readings told to Hermes; one in Apple Health, three
-- weeks old and several kilos out — and the Health page showed the old one). Walks the Watch had already recorded were being retold by hand, to the
-- minute, while thirty-four other Watch workouts never reached the ledger.
-- Calories eaten and calories burned were each known for nearly every day and
-- no function had ever put them side by side.
--
-- This file does three things about it:
--
--   1. Finance gets read functions, so Hermes can answer "what am I worth",
--      "how many points do I have" and "what is my target" — and so the browser
--      has something better than raw tables to move to.
--   2. life_days() is the one object that describes a day: money, food, body,
--      energy balance, activity. The dashboard, the summary job and Hermes all
--      read it, so they cannot disagree about what happened on Tuesday.
--   3. Each fact gets one home.
--        Weight    is written to the ledger (that is where you tell it) and
--                  read everywhere as the union of both stores, newest wins.
--        Workouts  belong to the Watch. A ledger activity that matches a Watch
--                  workout is the same event told twice, and is folded into it
--                  at read time; one that does not match is something the Watch
--                  missed, and stands on its own.
--
-- Nothing here writes, and nothing here changes a grant on an existing object.
--
-- Run order: after 0010_health_api.sql. Additive; safe to re-run — but
-- 0012_card_points.sql replaces finance_card_points() with a fuller version, so
-- if this file is ever re-run on its own, run 0012 again after it.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. Finance
--
-- SECURITY INVOKER, like the ledger functions: RLS on the tables enforces
-- ownership for a signed-in caller, and the service role — which bypasses RLS —
-- must name the user and pass ledger_can_act_as().
-- ────────────────────────────────────────────────────────────

-- The arithmetic is src/networth-math.js, restated. Change one, change both.
create or replace function public.finance_net_worth(p_limit integer default 12, p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with snap as (
    select n.date,
           coalesce(n.stocks,0) + coalesce(n.mutual_funds,0) + coalesce(n.cash,0)
             + coalesce(n.epf,0) + coalesce(n.gold,0) + coalesce(n.fds,0)   as assets,
           coalesce(n.credit_cards,0)                                        as liabilities,
           coalesce(n.stocks,0) + coalesce(n.mutual_funds,0) + coalesce(n.cash,0) as liquid,
           coalesce(n.cash,0) + coalesce(n.fds,0)                            as cash_like,
           jsonb_build_object('stocks', n.stocks, 'mutual_funds', n.mutual_funds, 'cash', n.cash,
                              'epf', n.epf, 'gold', n.gold, 'fds', n.fds)   as breakdown
      from public.net_worth_entries n
     where n.user_id = v_user
  ),
  ranked as (
    select s.*, s.assets - s.liabilities as net, row_number() over (order by s.date desc) as rn,
           count(*) over () as total
      from snap s
  )
  select jsonb_build_object(
    'currency', 'INR',
    'snapshots', coalesce(max(r.total), 0),
    'latest', (select jsonb_build_object('date', l.date, 'net_worth', round(l.net), 'assets', round(l.assets),
                        'liabilities', round(l.liabilities), 'liquid', round(l.liquid),
                        'cash_like', round(l.cash_like), 'breakdown', l.breakdown)
                 from ranked l where l.rn = 1),
    'previous', (select jsonb_build_object('date', p.date, 'net_worth', round(p.net)) from ranked p where p.rn = 2),
    'change', (select round(l.net - p.net) from ranked l, ranked p where l.rn = 1 and p.rn = 2),
    'change_pct', (select round(((l.net - p.net) / nullif(abs(p.net), 0) * 100)::numeric, 1)
                     from ranked l, ranked p where l.rn = 1 and p.rn = 2),
    'history', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'net_worth', round(h.net)) order by h.date)
                           from ranked h where h.rn <= greatest(p_limit, 1)), '[]'::jsonb)
  ) into v_out
  from ranked r;

  return v_out;
end;
$$;

-- Points are `points` when the statement gave them, else amount × multiplier /
-- 100 — the same rule as calcPoints() in src/views/points.js.
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
    select c.date, c.merchant, c.amount,
           coalesce(c.points, c.amount * c.multiplier / 100.0) as pts
      from public.cc_transactions c
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
    'lifetime', jsonb_build_object(
      'accrued',  round((select coalesce(sum(pts), 0) from tx)),
      'redeemed', round((select coalesce(sum(points_redeemed), 0) from rd)),
      'spend',    round((select coalesce(sum(amount), 0) from tx)),
      'first_transaction', (select min(date) from tx),
      'last_transaction',  (select max(date) from tx)),
    'range', jsonb_build_object(
      'from', p_from, 'to', p_to,
      'spend',        round((select coalesce(sum(amount), 0) from in_range)),
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

-- Only what the user has actually saved. The defaults live in the app's
-- settings catalogue (src/settings-schema.js); the caller merges them, and can
-- then say which numbers are the user's and which are the app's guess.
create or replace function public.finance_settings(p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  return coalesce((select jsonb_object_agg(s.key, s.value) from public.user_settings s where s.user_id = v_user), '{}'::jsonb);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- 3a. Weight: one answer
--
-- health.daily_discrete is the single place every daily reading passes
-- through — health_overview and health_series both call it — so teaching it
-- about the ledger's weight readings fixes the Health page, Hermes and
-- life_days at once. The ledger stays the place weight is written: that is
-- where you say it. "Latest" is by time across both stores, so whichever you
-- did last wins, wherever you did it.
-- ────────────────────────────────────────────────────────────
create or replace function health.ledger_weights(p_user_id uuid, p_from date, p_to date)
returns table (start_at timestamptz, day date, kg double precision)
language sql stable
set search_path = ''
as $$
  select e.occurred_at,
         (e.occurred_at at time zone public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata'))::date,
         w.value * case when lower(coalesce(e.data ->> 'unit', 'kg')) in ('lb', 'lbs') then 0.45359237 else 1 end
    from public.events e
   -- Two shapes exist: {metric:'weight', value} from log_measurement, and an
   -- older {weight} written before that tool fixed the shape.
   cross join lateral (
     select case
       when e.data ->> 'metric' = 'weight' and (e.data ->> 'value') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'value')::double precision
       when (e.data ->> 'weight') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'weight')::double precision
     end as value) w
   where e.user_id = p_user_id
     and e.type = 'health' and e.subtype = 'measurement'
     and e.status <> 'dismissed'
     and w.value is not null
     and e.occurred_at >= p_from::timestamp - interval '14 hours'
     and e.occurred_at <  (p_to + 1)::timestamp + interval '14 hours';
$$;

create or replace function health.daily_discrete(p_user_id uuid, p_from date, p_to date, p_types text[])
returns table (day date, type text, unit text, n bigint,
               min_value double precision, avg_value double precision,
               max_value double precision, latest_value double precision)
language sql stable
set search_path = ''
as $$
  with rows as (
    select m.type, m.unit, m.value, m.start_at,
           (m.start_at at time zone m.timezone)::date as day
      from health.metrics m
     where m.user_id = p_user_id
       and m.type = any (p_types)
       and m.metadata ->> 'aggregation' is null
       and m.start_at >= p_from::timestamp - interval '14 hours'
       and m.start_at <  (p_to + 1)::timestamp + interval '14 hours'
    union all
    select 'body_mass', 'kg', w.kg, w.start_at, w.day
      from health.ledger_weights(p_user_id, p_from, p_to) w
     where 'body_mass' = any (p_types)
  )
  select r.day, r.type, max(r.unit), count(*), min(r.value), avg(r.value), max(r.value),
         (array_agg(r.value order by r.start_at desc))[1]
    from rows r
   where r.day between p_from and p_to
   group by r.day, r.type;
$$;


-- ────────────────────────────────────────────────────────────
-- 3b. Activity: the Watch's record, plus what the Watch missed
--
-- A ledger activity is "the same workout told twice" when it falls on the same
-- local day as a Watch workout and agrees with it on duration (within 3 min)
-- or distance (within 200 m). The five hand-told walks in the ledger match
-- their Watch twins to the minute and the metre, so this is not a loose test.
-- An activity with neither a duration nor a distance cannot match anything and
-- always stands — "failed cycling attempt" is a fact the Watch never had.
--
-- Nothing is deleted or rewritten: the twin is simply reported once, as the
-- Watch saw it, carrying the ledger event's id and whatever you said about it.
-- ────────────────────────────────────────────────────────────
create or replace function health.activity_feed(p_user_id uuid, p_from date, p_to date)
returns table (day date, start_at timestamptz, activity text, minutes int, distance_km numeric,
               active_kcal int, source text, ledger_event_id uuid, note text)
language sql stable
set search_path = ''
as $$
  with tz as (select public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata') as name),
  watch as (
    select w.id, (w.start_at at time zone w.timezone)::date as day, w.start_at, w.activity_type,
           w.duration_seconds / 60.0 as minutes, w.distance_meters / 1000.0 as km,
           coalesce(w.active_energy_kcal, w.total_energy_kcal) as kcal
      from health.workouts w
     where w.user_id = p_user_id
       and w.start_at >= p_from::timestamp - interval '14 hours'
       and w.start_at <  (p_to + 1)::timestamp + interval '14 hours'
  ),
  told as (
    select e.id, (e.occurred_at at time zone tz.name)::date as day, e.occurred_at, e.title,
           coalesce(e.data ->> 'activity', e.subtype, 'activity') as activity,
           case when (e.data ->> 'duration_min') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'duration_min')::numeric end as minutes,
           case when (e.data ->> 'distance_km')  ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'distance_km')::numeric end as km
      from public.events e, tz
     where e.user_id = p_user_id
       and e.type = 'activity' and e.status <> 'dismissed'
       and e.occurred_at >= p_from::timestamp - interval '14 hours'
       and e.occurred_at <  (p_to + 1)::timestamp + interval '14 hours'
  ),
  -- Each told activity pairs with at most one Watch workout: the closest.
  pairs as (
    select distinct on (t.id) t.id as told_id, w.id as watch_id
      from told t
      join watch w on w.day = t.day
       and ( (t.minutes is not null and abs(t.minutes - w.minutes) <= 3)
          or (t.km is not null and w.km is not null and abs(t.km - w.km) <= 0.2) )
     order by t.id, abs(coalesce(t.minutes, w.minutes) - w.minutes), abs(coalesce(t.km, w.km) - coalesce(w.km, 0))
  )
  select w.day, w.start_at, w.activity_type, round(w.minutes)::int, round(w.km::numeric, 2), round(w.kcal)::int,
         'watch', p.told_id, (select t.title from told t where t.id = p.told_id)
    from watch w
    left join lateral (select pr.told_id from pairs pr where pr.watch_id = w.id limit 1) p on true
   where w.day between p_from and p_to
  union all
  select t.day, t.occurred_at, t.activity, round(t.minutes)::int, round(t.km, 2), null::int,
         'ledger', t.id, t.title
    from told t
   where t.day between p_from and p_to
     and not exists (select 1 from pairs pr where pr.told_id = t.id);
$$;

create or replace function public.life_activity(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  perform health.check_range(p_from, p_to);
  select jsonb_agg(jsonb_strip_nulls(to_jsonb(a)) order by a.start_at) into v_out
    from health.activity_feed(v_user, p_from, p_to) a;
  return coalesce(v_out, '[]'::jsonb);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- 2. public.life_days — what happened, per day, across all three stores
--
-- SECURITY DEFINER because part of it lives in `health`; the caller is checked
-- once, by health.reader(), and every read below is filtered to that user
-- explicitly rather than left to RLS.
--
-- The money rule is src/ledger/summary.js isInflow(), restated: a transfer is
-- not spending, except money paid out to a person; a credit is an inflow; a
-- self-transfer is neither.
--
-- Energy balance is only as good as its weaker half. Burned comes from a
-- sensor worn all day. Eaten comes from receipts and what you told Hermes, so
-- it is a floor — and the day says so: `meals_unpriced` counts what could not
-- be priced, and `complete` is false for today and for any day with a gap.
--
-- "No unpriced meals" is not the same as "every meal logged". The first week
-- of real data had a day with a single small snack on record, which passed
-- that test and reported a 2,600 kcal deficit nobody ran. So a day whose food
-- comes to under 60% of the calorie target is also treated as partial, and
-- flagged `eaten_looks_partial`: an adult does not live on 1,100 kcal by
-- accident, but forgets to log lunch all the time.
-- ────────────────────────────────────────────────────────────
-- Work spend per day. Here it knows nothing and returns nothing; 0012 replaces
-- it once points rows are linked to events and can say which spends were work.
-- Declared here so life_days() has one shape whichever migrations have run.
do $$
begin
  if to_regprocedure('public.cc_work_spend(uuid, date, date)') is null then
    create function public.cc_work_spend(p_user_id uuid, p_from date, p_to date)
    returns table (day date, amount numeric) language sql stable
    set search_path = public, pg_temp as 'select null::date, null::numeric where false';
    revoke all on function public.cc_work_spend(uuid, date, date) from public, anon;
  end if;
end;
$$;

create or replace function public.life_days(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user   uuid := health.reader(p_user_id);
  v_tz     text;
  v_target numeric;
  v_today  date;
  v_out    jsonb;
begin
  perform health.check_range(p_from, p_to, 120);
  v_tz     := public.ledger_setting_text(v_user, 'ledger_timezone', 'Asia/Kolkata');
  v_target := public.ledger_setting(v_user, 'food_kcal_target', 1800);
  v_today  := (now() at time zone v_tz)::date;

  with days as (
    select generate_series(p_from::timestamp, p_to::timestamp, interval '1 day')::date as day
  ),
  ev as (
    select (e.occurred_at at time zone v_tz)::date as day, e.type, e.subtype,
           case when (e.data ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e.data ->> 'amount')::numeric end as amount,
           e.data ->> 'direction' as direction
      from public.events e
     where e.user_id = v_user and e.status <> 'dismissed'
       and e.occurred_at >= (p_from::timestamp at time zone v_tz)
       and e.occurred_at <  ((p_to + 1)::timestamp at time zone v_tz)
  ),
  money as (
    select ev.day, count(*) as events,
           sum(ev.amount) filter (where ev.amount is not null and (
                 (ev.type = 'transfer' and ev.subtype = 'payment' and ev.direction = 'debit')
              or (ev.type <> 'transfer' and ev.direction is distinct from 'credit'))) as spend,
           sum(ev.amount) filter (where ev.amount is not null and ev.type <> 'transfer' and ev.direction = 'credit') as inflow
      from ev group by ev.day
  ),
  work as (
    select w.day, w.amount from public.cc_work_spend(v_user, p_from, p_to) w
  ),
  meals as (
    select (m.occurred_at at time zone v_tz)::date as day, m.kcal, m.protein_g
      from jsonb_to_recordset(public.food_event_nutrition(
             (p_from::timestamp at time zone v_tz), ((p_to + 1)::timestamp at time zone v_tz), 5000, v_user))
           as m(occurred_at timestamptz, kcal numeric, protein_g numeric)
  ),
  food as (
    select m.day, round(sum(m.kcal))::int as eaten_kcal, round(sum(m.protein_g))::int as protein_g,
           count(m.kcal)::int as meals, (count(*) - count(m.kcal))::int as meals_unpriced
      from meals m where m.day between p_from and p_to group by m.day
  ),
  body as (
    select (b ->> 'day')::date as day, b - 'day' - 'workouts' - 'workout_min' - 'workout_types'
             - 'eaten_kcal' - 'protein_g' - 'carbs_g' - 'fat_g' as fields,
           (b ->> 'active_kcal')::numeric + (b ->> 'basal_kcal')::numeric as burned
      from jsonb_array_elements(public.health_overview(p_from, p_to, v_user)) b
  ),
  act as (
    select a.day, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'activity', a.activity, 'minutes', a.minutes, 'distance_km', a.distance_km,
             'active_kcal', a.active_kcal, 'source', a.source, 'note', a.note)) order by a.start_at) as items
      from health.activity_feed(v_user, p_from, p_to) a group by a.day
  )
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'day', d.day,
    'is_today', case when d.day = v_today then true end,
    'events', mo.events,
    -- `spend` is everything. When some of it was work (a points row under the
    -- work label), it is also given split, so a week of reimbursable flights
    -- does not read as a week of personal excess.
    'money', case when mo.spend is not null or mo.inflow is not null then jsonb_strip_nulls(jsonb_build_object(
               'spend', round(mo.spend), 'inflow', round(mo.inflow),
               'work_spend', round(wk.amount),
               'personal_spend', case when wk.amount is not null then round(greatest(mo.spend - wk.amount, 0)) end)) end,
    'food', case when f.day is not null then jsonb_build_object(
               'eaten_kcal', f.eaten_kcal, 'protein_g', f.protein_g, 'meals', f.meals, 'meals_unpriced', f.meals_unpriced) end,
    'body', case when b.fields <> '{}'::jsonb then b.fields end,
    'energy', case when f.eaten_kcal is not null or b.burned is not null then jsonb_strip_nulls(jsonb_build_object(
               'eaten_kcal', f.eaten_kcal,
               'burned_kcal', round(b.burned)::int,
               'balance_kcal', round(f.eaten_kcal - b.burned)::int,
               'target_kcal', round(v_target)::int,
               'eaten_vs_target', f.eaten_kcal - round(v_target)::int,
               'eaten_looks_partial', case when f.eaten_kcal < 0.6 * v_target then true end,
               'complete', (d.day <> v_today and coalesce(f.meals_unpriced, 0) = 0
                            and f.eaten_kcal is not null and b.burned is not null
                            and f.eaten_kcal >= 0.6 * v_target))) end,
    'activity', a.items
  )) order by d.day)
  into v_out
  from days d
  left join money mo on mo.day = d.day
  left join work  wk on wk.day = d.day
  left join food  f  on f.day  = d.day
  left join body  b  on b.day  = d.day
  left join act   a  on a.day  = d.day;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;


do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.finance_net_worth(integer, uuid)',
    'public.finance_card_points(date, date, uuid)',
    'public.finance_settings(uuid)',
    'public.life_activity(date, date, uuid)',
    'public.life_days(date, date, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
