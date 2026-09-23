-- ============================================================
-- Health — the read API
--
-- 0009 lets the phone write. This file lets everything else read: the browser
-- dashboard, and Hermes through the ledger MCP server. Same functions for both,
-- the way 0004 does it for the ledger.
--
-- The thing to understand about this data is its grain. HealthKit does not
-- store "steps on Tuesday"; it stores a row every time the pedometer flushes —
-- a few dozen steps over a minute or two — once from the phone and again from
-- the Watch. Three months is ~120,000 rows, and not one of them is a number a
-- person wants. Nobody reads `health.metrics`. They read these functions,
-- which turn samples into days:
--
--   health_overview   one object per day: steps, energy, sleep, heart, weight
--   health_series     one type across days (any of the ~190 HealthKit types)
--   health_intraday   one type across the hours of one day
--   health_sleep      one object per night, with stages
--   health_workouts   the workouts themselves (already one row per event)
--
-- Two kinds of type, and they roll up differently:
--
--   cumulative  steps, energy, distance, water, dietary_*. A day is a SUM —
--               of one source. Summing phone + Watch double counts, so the
--               source with the largest total for that day wins (see 0009).
--   discrete    heart rate, HRV, weight, SpO2. A day is MIN / AVG / MAX and
--               the latest reading. Overlap between sources is harmless here.
--
-- Security: the `health` schema stays unexposed and ungranted. These functions
-- are SECURITY DEFINER and live in `public`, so each one checks the caller
-- itself. Note what it does NOT use: `ledger_can_act_as()` tests
-- `current_user`, and inside a SECURITY DEFINER function current_user is the
-- function's owner — that check would pass for everybody. Identity here comes
-- from the verified JWT instead, which SECURITY DEFINER does not change.
--
-- Every range function reads the base tables through the
-- (user_id, type, start_at) index with a padded instant range, then buckets by
-- local day. The 0009 views compute the day first and so scan everything; they
-- are for ad hoc questions in the SQL editor, not for callers.
--
-- Run order: after 0009_health.sql. Additive; safe to re-run.
-- ============================================================

-- Superseded since (the current definition lives in the later file):
--   health.daily_discrete   → 0011_life_api.sql   (weight is the union of both stores)
--   health_workouts         → dropped by 0018_cleanup.sql; life_activity() (0011)
--                             is what the browser and Hermes read
-- Re-running this file on its own would put the old body back and recreate
-- health_workouts; run 0011 and 0018 again after it.


-- ────────────────────────────────────────────────────────────
-- Who is asking
-- ────────────────────────────────────────────────────────────
create or replace function health.can_read(p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and (
       auth.uid() = p_user_id
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    -- The SQL editor and migrations: no JWT at all, connected as an admin.
    -- session_user, unlike current_user, is not changed by SECURITY DEFINER.
    or session_user in ('postgres', 'supabase_admin')
  );
$$;

-- Resolves the default (the signed-in user) and refuses everyone else.
create or replace function health.reader(p_user_id uuid)
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
begin
  if not health.can_read(v_user) then
    raise exception 'not authorised to read health data' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

create or replace function health.check_range(p_from date, p_to date, p_max_days int default 400)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid date range' using errcode = '22023';
  end if;
  if p_to - p_from > p_max_days then
    raise exception 'date range longer than % days', p_max_days using errcode = '22023';
  end if;
end;
$$;

create or replace function health.is_cumulative(p_type text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_type like 'dietary\_%' or p_type in (
    'step_count', 'active_energy', 'basal_energy', 'flights_climbed',
    'distance_walking_running', 'distance_cycling', 'distance_swimming',
    'distance_wheelchair', 'distance_downhill_snow_sports',
    'apple_exercise_time', 'apple_stand_time', 'apple_move_time',
    'push_count', 'swimming_stroke_count', 'water', 'time_in_daylight',
    'number_of_alcoholic_beverages', 'number_of_times_fallen', 'inhaler_usage',
    'insulin_delivery'
  );
$$;


-- ────────────────────────────────────────────────────────────
-- Internal rollups. Not callable through the API: schema `health` is not
-- exposed, and EXECUTE is revoked from the API roles by 0009's defaults.
-- ────────────────────────────────────────────────────────────

-- Cumulative types → one value per (day, type). Same three tiers as the
-- daily_totals view: a full-day HealthKit aggregate, else the best single
-- source, else a partial aggregate.
-- `basis` is for people (the Watch's own name); `source_key` is the stable
-- identity the total was computed from, which health_intraday filters by.
drop function if exists health.daily_cumulative(uuid, date, date, text[]);
create function health.daily_cumulative(p_user_id uuid, p_from date, p_to date, p_types text[])
returns table (day date, type text, unit text, value double precision, basis text, source_key text)
language sql stable
set search_path = ''
as $$
  with rows as (
    select m.type, m.unit, m.value, m.metadata, m.start_at, m.end_at,
           coalesce(m.source_bundle_id, m.source_name) as source, m.source_name,
           (m.start_at at time zone m.timezone)::date as day
      from health.metrics m
     where m.user_id = p_user_id
       and m.type = any (p_types)
       and m.start_at >= p_from::timestamp - interval '14 hours'
       and m.start_at <  (p_to + 1)::timestamp + interval '14 hours'
  ),
  candidates as (
    select r.day, r.type, r.unit, r.value, 'healthkit_aggregate' as basis, null::text as source_key, 1 as tier
      from rows r
     where r.metadata ->> 'aggregation' = 'daily_sum' and r.end_at - r.start_at >= interval '23 hours'
    union all
    select r.day, r.type, r.unit, sum(r.value), max(r.source_name), r.source, 2
      from rows r
     where r.metadata ->> 'aggregation' is null
     group by r.day, r.type, r.unit, r.source
    union all
    select r.day, r.type, r.unit, r.value, 'healthkit_aggregate_partial', null::text, 3
      from rows r
     where r.metadata ->> 'aggregation' = 'daily_sum' and r.end_at - r.start_at < interval '23 hours'
  )
  select distinct on (c.day, c.type) c.day, c.type, c.unit, c.value, c.basis, c.source_key
    from candidates c
   where c.day between p_from and p_to
   order by c.day, c.type, c.tier, c.value desc;
$$;

-- Discrete types → min / avg / max / latest per (day, type).
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
  )
  select r.day, r.type, max(r.unit), count(*), min(r.value), avg(r.value), max(r.value),
         (array_agg(r.value order by r.start_at desc))[1]
    from rows r
   where r.day between p_from and p_to
   group by r.day, r.type;
$$;

-- Sleep → one row per night. Overlaps merged before measuring; a night belongs
-- to the morning it ends on (18:00 onward counts toward the next date). Stage
-- minutes come from each stage's own merged intervals.
--
-- The `_local` columns are wall-clock strings in the zone the phone was in.
-- Instants alone invite a reader (a model especially) to take 03:52Z for the
-- middle of the night when it was 09:22 in Kolkata.
drop function if exists health.nights(uuid, date, date);
create function health.nights(p_user_id uuid, p_from date, p_to date)
returns table (night date, fell_asleep_at timestamptz, woke_at timestamptz,
               fell_asleep_local text, woke_local text,
               hours_asleep numeric, core_min int, deep_min int, rem_min int,
               unspecified_min int, awake_min int, in_bed_min int)
language sql stable
set search_path = ''
as $$
  with rows as (
    select m.metadata ->> 'sleep_stage' as stage, m.start_at, m.end_at, m.timezone,
           ((m.start_at at time zone m.timezone) + interval '6 hours')::date as night
      from health.metrics m
     where m.user_id = p_user_id
       and m.type = 'sleep_analysis'
       and m.start_at >= p_from::timestamp - interval '2 days'
       and m.start_at <  (p_to + 1)::timestamp + interval '1 day'
  ),
  -- Merge twice: once per stage (for the breakdown), once across every asleep
  -- stage (for the total, where core from one source may overlap rem from another).
  tagged as (
    select r.night, r.stage as grp, r.start_at, r.end_at from rows r
    union all
    select r.night, 'asleep_total', r.start_at, r.end_at from rows r where r.stage like 'asleep%'
  ),
  marked as (
    select t.*, case when t.start_at <= max(t.end_at) over (
                       partition by t.night, t.grp order by t.start_at, t.end_at
                       rows between unbounded preceding and 1 preceding)
                     then 0 else 1 end as starts_island
      from tagged t
  ),
  islands as (
    select k.*, sum(k.starts_island) over (partition by k.night, k.grp order by k.start_at, k.end_at) as island
      from marked k
  ),
  merged as (
    select i.night, i.grp, min(i.start_at) as start_at, max(i.end_at) as end_at
      from islands i group by i.night, i.grp, i.island
  ),
  per_group as (
    select g.night, g.grp, min(g.start_at) as first_at, max(g.end_at) as last_at,
           extract(epoch from sum(g.end_at - g.start_at)) as seconds
      from merged g group by g.night, g.grp
  )
  select p.night,
         max(p.first_at) filter (where p.grp = 'asleep_total'),
         max(p.last_at)  filter (where p.grp = 'asleep_total'),
         to_char(max(p.first_at) filter (where p.grp = 'asleep_total') at time zone z.timezone, 'HH24:MI'),
         to_char(max(p.last_at)  filter (where p.grp = 'asleep_total') at time zone z.timezone, 'HH24:MI'),
         round((max(p.seconds) filter (where p.grp = 'asleep_total') / 3600)::numeric, 2),
         coalesce(round(max(p.seconds) filter (where p.grp = 'asleep_core') / 60), 0)::int,
         coalesce(round(max(p.seconds) filter (where p.grp = 'asleep_deep') / 60), 0)::int,
         coalesce(round(max(p.seconds) filter (where p.grp = 'asleep_rem') / 60), 0)::int,
         coalesce(round(max(p.seconds) filter (where p.grp = 'asleep_unspecified') / 60), 0)::int,
         coalesce(round(max(p.seconds) filter (where p.grp = 'awake') / 60), 0)::int,
         coalesce(round(max(p.seconds) filter (where p.grp = 'in_bed') / 60), 0)::int
    from per_group p
    join (select r.night, max(r.timezone) as timezone from rows r group by r.night) z on z.night = p.night
   where p.night between p_from and p_to
   group by p.night, z.timezone
  having max(p.seconds) filter (where p.grp = 'asleep_total') is not null;
$$;


-- ────────────────────────────────────────────────────────────
-- public.health_overview — the one most callers want
--
-- One object per calendar day in the range, including days with nothing, so a
-- gap reads as a gap and not as a missing row.
-- ────────────────────────────────────────────────────────────
create or replace function public.health_overview(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  perform health.check_range(p_from, p_to);

  with days as (
    select generate_series(p_from::timestamp, p_to::timestamp, interval '1 day')::date as day
  ),
  cum as (
    select * from health.daily_cumulative(v_user, p_from, p_to, array[
      'step_count', 'active_energy', 'basal_energy', 'distance_walking_running',
      'flights_climbed', 'apple_exercise_time', 'dietary_energy', 'dietary_protein',
      'dietary_carbs', 'dietary_fat', 'water'])
  ),
  disc as (
    select * from health.daily_discrete(v_user, p_from, p_to, array[
      'heart_rate', 'resting_heart_rate', 'hrv_sdnn', 'body_mass', 'body_fat_percentage'])
  ),
  nights as (
    select * from health.nights(v_user, p_from, p_to)
  ),
  wk as (
    select (w.start_at at time zone w.timezone)::date as day, count(*) as n,
           round(sum(w.duration_seconds) / 60)::int as minutes,
           round(sum(coalesce(w.active_energy_kcal, w.total_energy_kcal, 0)))::int as kcal,
           jsonb_agg(distinct w.activity_type) as types
      from health.workouts w
     where w.user_id = v_user
       and w.start_at >= p_from::timestamp - interval '14 hours'
       and w.start_at <  (p_to + 1)::timestamp + interval '14 hours'
     group by 1
  ),
  -- Pivot each rollup to one row per day, then join. Looking each field up
  -- with its own subquery rescans the rollup once per day per field, which
  -- made a 90-day overview take four seconds instead of half of one.
  cum_day as (
    select c.day,
           max(c.value) filter (where c.type = 'step_count')          as steps,
           max(c.value) filter (where c.type = 'active_energy')       as active_kcal,
           max(c.value) filter (where c.type = 'basal_energy')        as basal_kcal,
           max(c.value / case when c.unit = 'm' then 1000 else 1 end)
                        filter (where c.type = 'distance_walking_running') as distance_km,
           max(c.value) filter (where c.type = 'flights_climbed')     as flights,
           max(c.value) filter (where c.type = 'apple_exercise_time') as exercise_min,
           max(c.value) filter (where c.type = 'dietary_energy')      as eaten_kcal,
           max(c.value) filter (where c.type = 'dietary_protein')     as protein_g,
           max(c.value) filter (where c.type = 'dietary_carbs')       as carbs_g,
           max(c.value) filter (where c.type = 'dietary_fat')         as fat_g,
           max(c.value) filter (where c.type = 'water')               as water
      from cum c group by c.day
  ),
  disc_day as (
    select x.day,
           max(x.latest_value) filter (where x.type = 'resting_heart_rate')  as resting_hr,
           max(x.min_value)    filter (where x.type = 'heart_rate')          as hr_min,
           max(x.avg_value)    filter (where x.type = 'heart_rate')          as hr_avg,
           max(x.max_value)    filter (where x.type = 'heart_rate')          as hr_max,
           max(x.avg_value)    filter (where x.type = 'hrv_sdnn')            as hrv_ms,
           max(x.latest_value) filter (where x.type = 'body_mass')           as weight_kg,
           max(x.latest_value) filter (where x.type = 'body_fat_percentage') as body_fat
      from disc x group by x.day
  )
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'day',            d.day,
    'steps',          round(c.steps)::int,
    'active_kcal',    round(c.active_kcal)::int,
    'basal_kcal',     round(c.basal_kcal)::int,
    'distance_km',    round(c.distance_km::numeric, 2),
    'flights',        round(c.flights)::int,
    'exercise_min',   round(c.exercise_min)::int,
    'eaten_kcal',     round(c.eaten_kcal)::int,
    'protein_g',      round(c.protein_g)::int,
    'carbs_g',        round(c.carbs_g)::int,
    'fat_g',          round(c.fat_g)::int,
    'resting_hr',     round(x.resting_hr)::int,
    'hr_min',         round(x.hr_min)::int,
    'hr_avg',         round(x.hr_avg)::int,
    'hr_max',         round(x.hr_max)::int,
    'hrv_ms',         round(x.hrv_ms)::int,
    'weight_kg',      round(x.weight_kg::numeric, 1),
    'sleep_hours',    n.hours_asleep,
    'fell_asleep',    n.fell_asleep_local,
    'woke',           n.woke_local,
    'workouts',       k.n,
    'workout_min',    k.minutes,
    'workout_types',  k.types
  )) order by d.day)
  into v_out
  from days d
  left join cum_day  c on c.day = d.day
  left join disc_day x on x.day = d.day
  left join nights   n on n.night = d.day
  left join wk       k on k.day = d.day;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- public.health_series — any one type, per day
-- ────────────────────────────────────────────────────────────
create or replace function public.health_series(p_type text, p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  perform health.check_range(p_from, p_to);

  if health.is_cumulative(p_type) then
    select jsonb_agg(jsonb_build_object(
             'day', c.day, 'value', round(c.value::numeric, 2), 'unit', c.unit, 'basis', c.basis) order by c.day)
      into v_out
      from health.daily_cumulative(v_user, p_from, p_to, array[p_type]) c;
  else
    select jsonb_agg(jsonb_build_object(
             'day', x.day, 'unit', x.unit, 'readings', x.n,
             'min', round(x.min_value::numeric, 2), 'avg', round(x.avg_value::numeric, 2),
             'max', round(x.max_value::numeric, 2), 'latest', round(x.latest_value::numeric, 2)) order by x.day)
      into v_out
      from health.daily_discrete(v_user, p_from, p_to, array[p_type]) x;
  end if;

  return jsonb_build_object(
    'type', p_type,
    'kind', case when health.is_cumulative(p_type) then 'cumulative' else 'discrete' end,
    'days', coalesce(v_out, '[]'::jsonb));
end;
$$;


-- ────────────────────────────────────────────────────────────
-- public.health_intraday — one type across one day, in buckets
-- ────────────────────────────────────────────────────────────
create or replace function public.health_intraday(
  p_type text, p_day date, p_bucket_minutes int default 60, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user   uuid := health.reader(p_user_id);
  v_bucket int  := greatest(5, least(coalesce(p_bucket_minutes, 60), 360));
  v_source text;
  v_basis  text;
  v_out    jsonb;
begin
  -- For a cumulative type, stay with the source the daily total used, so the
  -- buckets add up to the number health_overview reports.
  if health.is_cumulative(p_type) then
    select c.source_key, c.basis into v_source, v_basis
      from health.daily_cumulative(v_user, p_day, p_day, array[p_type]) c;
  end if;

  with rows as (
    select m.value, m.unit, (m.start_at at time zone m.timezone) as local_start
      from health.metrics m
     where m.user_id = v_user
       and m.type = p_type
       and m.metadata ->> 'aggregation' is null
       and m.start_at >= p_day::timestamp - interval '14 hours'
       and m.start_at <  (p_day + 1)::timestamp + interval '14 hours'
       and (v_source is null or coalesce(m.source_bundle_id, m.source_name) = v_source)
  ),
  bucketed as (
    select to_char(date_bin(make_interval(mins => v_bucket), r.local_start, p_day::timestamp), 'HH24:MI') as at,
           max(r.unit) as unit, count(*) as n, sum(r.value) as total,
           min(r.value) as lo, avg(r.value) as mean, max(r.value) as hi
      from rows r
     where r.local_start::date = p_day
     group by 1
  )
  select jsonb_agg(
           case when health.is_cumulative(p_type)
                then jsonb_build_object('at', b.at, 'value', round(b.total::numeric, 2))
                else jsonb_build_object('at', b.at, 'readings', b.n, 'min', round(b.lo::numeric, 2),
                                        'avg', round(b.mean::numeric, 2), 'max', round(b.hi::numeric, 2))
           end order by b.at)
    into v_out
    from bucketed b;

  return jsonb_build_object('type', p_type, 'day', p_day, 'bucket_minutes', v_bucket,
                            'source', v_basis, 'buckets', coalesce(v_out, '[]'::jsonb));
end;
$$;


-- ────────────────────────────────────────────────────────────
-- public.health_sleep / public.health_workouts
-- ────────────────────────────────────────────────────────────
create or replace function public.health_sleep(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  perform health.check_range(p_from, p_to);
  select jsonb_agg(to_jsonb(n) order by n.night) into v_out from health.nights(v_user, p_from, p_to) n;
  return coalesce(v_out, '[]'::jsonb);
end;
$$;

create or replace function public.health_workouts(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  perform health.check_range(p_from, p_to);
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'day', (w.start_at at time zone w.timezone)::date,
           'activity', w.activity_type,
           'start_at', w.start_at,
           'minutes', round(w.duration_seconds / 60)::int,
           'active_kcal', round(w.active_energy_kcal)::int,
           'distance_km', round((w.distance_meters / 1000)::numeric, 2),
           'source', w.source_name)) order by w.start_at)
    into v_out
    from health.workouts w
   where w.user_id = v_user
     and w.start_at >= p_from::timestamp - interval '14 hours'
     and w.start_at <  (p_to + 1)::timestamp + interval '14 hours'
     and (w.start_at at time zone w.timezone)::date between p_from and p_to;
  return coalesce(v_out, '[]'::jsonb);
end;
$$;

-- What has actually been synced — so a caller can tell "no steps" from
-- "steps were never switched on".
create or replace function public.health_catalog(p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := health.reader(p_user_id);
  v_out  jsonb;
begin
  select jsonb_build_object(
    'last_sync_at', (select max(b.received_at) from health.sync_batches b where b.user_id = v_user),
    'types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'type', t.type, 'unit', t.unit, 'rows', t.n, 'first_day', t.first_day, 'last_day', t.last_day,
               'kind', case when health.is_cumulative(t.type) then 'cumulative' else 'discrete' end) order by t.n desc)
        from (select m.type, max(m.unit) as unit, count(*) as n,
                     min(m.start_at)::date as first_day, max(m.start_at)::date as last_day
                from health.metrics m where m.user_id = v_user group by m.type) t), '[]'::jsonb),
    'workouts', (select count(*) from health.workouts w where w.user_id = v_user))
  into v_out;
  return v_out;
end;
$$;


-- The signed-in browser and the service role; nobody else. Supabase's default
-- privileges would otherwise hand EXECUTE to `anon` as well.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.health_overview(date, date, uuid)',
    'public.health_series(text, date, date, uuid)',
    'public.health_intraday(text, date, int, uuid)',
    'public.health_sleep(date, date, uuid)',
    'public.health_workouts(date, date, uuid)',
    'public.health_catalog(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
