-- ============================================================
-- Health — a private landing place for Apple Health samples
--
-- An iPhone app (a self-built HealthSync) reads HealthKit on the phone and
-- POSTs batches to the `healthsync` Edge Function. That function does exactly
-- one thing with the database: it calls `public.health_ingest(...)` below.
-- Everything else in this file is unreachable from the REST API.
--
-- Four rules, each one a specific failure of the upstream backend this
-- replaces:
--
--   1. Nothing here touches `public` grants. The upstream migrations revoke
--      every privilege on schema public from `anon` and `authenticated`, which
--      would take the FinanceHub web app down. This file creates its own
--      schema, grants only inside it, and adds a single function to `public`.
--   2. No open provisioning. There is no endpoint that mints a token. A token
--      is minted once, by hand, in the SQL editor (see the bottom of this
--      file), and only its SHA-256 is stored.
--   3. A sample is identified by its HealthKit UUID alone. Upstream keys rows
--      on (workspace, device, id), and the device id is regenerated on every
--      reinstall — so a reinstall duplicated the whole history. Here the key is
--      (user_id, id). Re-sending is always an update, never a second row.
--   4. One batch is one transaction. Upstream writes in chunks of 100 with no
--      transaction, so a mid-batch failure left deletions applied and a batch
--      row claiming rows that never landed. `health_ingest` is a single
--      plpgsql call: all of it commits, or none of it does.
--
-- A deletion also leaves a tombstone. The phone retries failed batches out of
-- order, so "add X" can arrive after "delete X"; without the tombstone X would
-- come back for good.
--
-- Raw samples are kept exactly as sent. Daily totals and sleep are computed by
-- the two views at the bottom, which is where double counting is dealt with.
--
-- Run order: after 0008_food_merge.sql.
-- ============================================================

-- Superseded since: the two ad hoc views at the end of this file,
-- health.daily_totals and health.sleep_nights, were dropped by 0018_cleanup.sql;
-- health.daily_cumulative() and health.nights() in 0010 are their replacements.
-- A re-run of this file recreates them, harmlessly.


create schema if not exists health;

-- Supabase grants nothing on a new schema to the API roles, but say so
-- explicitly: this schema is service-role only, and is NOT in the list of
-- schemas PostgREST exposes. Leave it that way.
revoke all on schema health from public, anon, authenticated;
grant usage on schema health to service_role;

alter default privileges in schema health revoke all on tables    from public, anon, authenticated;
alter default privileges in schema health revoke all on functions from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- ingest_tokens — who may write
--
-- The phone holds the token; this table holds its SHA-256. The token is 244
-- bits of randomness, so a plain hash is enough — there is nothing to brute
-- force and no second secret to rotate.
-- ────────────────────────────────────────────────────────────
create table if not exists health.ingest_tokens (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users (id) on delete cascade,
  token_hash    text        not null unique,
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);


-- ────────────────────────────────────────────────────────────
-- sync_batches — one row per POST, for provenance
--
-- `timezone` is the phone's zone when it synced. The views use it to decide
-- which local day a sample belongs to.
-- ────────────────────────────────────────────────────────────
create table if not exists health.sync_batches (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  export_id         uuid        not null,
  device_id         text        not null,
  app_version       text,
  generated_at      timestamptz not null,
  received_at       timestamptz not null default now(),
  timezone          text        not null,
  source            text,
  schema_version    int,
  range_start       timestamptz,
  range_end         timestamptz,
  metrics_count     int         not null default 0,
  workouts_count    int         not null default 0,
  deletions_count   int         not null default 0,
  primary key (user_id, export_id)
);


-- ────────────────────────────────────────────────────────────
-- metrics — every quantity, category and sleep sample, as sent
-- ────────────────────────────────────────────────────────────
create table if not exists health.metrics (
  user_id           uuid             not null references auth.users (id) on delete cascade,
  id                text             not null,
  type              text             not null,
  value             double precision not null,
  unit              text             not null,
  start_at          timestamptz      not null,
  end_at            timestamptz      not null,
  source_name       text             not null,
  source_bundle_id  text,
  metadata          jsonb            not null default '{}'::jsonb,
  device_id         text             not null,
  export_id         uuid             not null,
  timezone          text             not null,
  received_at       timestamptz      not null default now(),
  primary key (user_id, id),
  check (end_at >= start_at)
);

create index if not exists metrics_user_type_start
  on health.metrics (user_id, type, start_at desc);


-- ────────────────────────────────────────────────────────────
-- workouts
-- ────────────────────────────────────────────────────────────
create table if not exists health.workouts (
  user_id             uuid             not null references auth.users (id) on delete cascade,
  id                  text             not null,
  activity_type       text             not null,
  start_at            timestamptz      not null,
  end_at              timestamptz      not null,
  duration_seconds    double precision not null,
  total_energy_kcal   double precision,
  active_energy_kcal  double precision,
  distance_meters     double precision,
  source_name         text             not null,
  source_bundle_id    text,
  metadata            jsonb            not null default '{}'::jsonb,
  device_id           text             not null,
  export_id           uuid             not null,
  timezone            text             not null,
  received_at         timestamptz      not null default now(),
  primary key (user_id, id),
  check (end_at >= start_at)
);

create index if not exists workouts_user_start
  on health.workouts (user_id, start_at desc);


-- ────────────────────────────────────────────────────────────
-- tombstones — ids HealthKit has deleted
--
-- Checked on every upsert, so a late retry of an older batch cannot resurrect
-- a sample that was deleted after it.
-- ────────────────────────────────────────────────────────────
create table if not exists health.tombstones (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  id          text        not null,
  kind        text        not null check (kind in ('metric', 'workout')),
  deleted_at  timestamptz not null default now(),
  primary key (user_id, id)
);


-- RLS on, no policies: even if someone later exposes this schema or grants on
-- it by mistake, the API roles still see nothing. The service role bypasses RLS.
alter table health.ingest_tokens enable row level security;
alter table health.sync_batches  enable row level security;
alter table health.metrics       enable row level security;
alter table health.workouts      enable row level security;
alter table health.tombstones    enable row level security;

grant select, insert, update, delete on all tables in schema health to service_role;


-- ────────────────────────────────────────────────────────────
-- public.health_ingest — the only door
--
-- Lives in `public` so the Edge Function can reach it through PostgREST's
-- default schema without exposing `health`. It is SECURITY DEFINER, and execute
-- is revoked from everyone except the service role, so the anon key in the
-- browser bundle cannot call it.
--
-- The Edge Function validates shape and size before calling; this function
-- trusts types but not identity. It returns jsonb rather than raising on a bad
-- token so the caller can answer 401 without parsing an error string.
-- ────────────────────────────────────────────────────────────
create or replace function public.health_ingest(
  p_token_hash  text,
  p_device_id   text,
  p_app_version text,
  p_payload     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id     uuid;
  v_export_id   uuid        := (p_payload ->> 'export_id')::uuid;
  v_timezone    text        := coalesce(nullif(p_payload ->> 'timezone', ''), 'UTC');
  v_metrics     jsonb       := coalesce(p_payload -> 'metrics',   '[]'::jsonb);
  v_workouts    jsonb       := coalesce(p_payload -> 'workouts',  '[]'::jsonb);
  v_deletions   jsonb       := coalesce(p_payload -> 'deletions', '[]'::jsonb);
  v_received    int;
  v_duplicates  int;
  v_deleted     int := 0;
  v_n           int;
begin
  update health.ingest_tokens t
     set last_used_at = now()
   where t.token_hash = p_token_hash
     and t.revoked_at is null
  returning t.user_id into v_user_id;

  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  -- An unknown zone name would make every view that uses it throw. Fall back
  -- rather than store a value that poisons reads.
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone) then
    v_timezone := 'UTC';
  end if;

  v_received := jsonb_array_length(v_metrics) + jsonb_array_length(v_workouts);

  insert into health.sync_batches as b (
    user_id, export_id, device_id, app_version, generated_at, timezone, source,
    schema_version, range_start, range_end, metrics_count, workouts_count, deletions_count
  ) values (
    v_user_id, v_export_id, p_device_id, p_app_version,
    (p_payload ->> 'generated_at')::timestamptz, v_timezone, p_payload ->> 'source',
    (p_payload ->> 'schema_version')::int,
    (p_payload #>> '{date_range,start}')::timestamptz,
    (p_payload #>> '{date_range,end}')::timestamptz,
    jsonb_array_length(v_metrics), jsonb_array_length(v_workouts), jsonb_array_length(v_deletions)
  )
  on conflict (user_id, export_id) do update
    set received_at = now(), app_version = excluded.app_version;

  -- Deletions first, and remembered.
  insert into health.tombstones (user_id, id, kind)
  select v_user_id, d.id, d.kind
    from jsonb_to_recordset(v_deletions) as d(id text, kind text)
   where d.id is not null and d.kind in ('metric', 'workout')
  on conflict (user_id, id) do nothing;

  delete from health.metrics m
   using jsonb_to_recordset(v_deletions) as d(id text, kind text)
   where m.user_id = v_user_id and m.id = d.id and d.kind = 'metric';
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from health.workouts w
   using jsonb_to_recordset(v_deletions) as d(id text, kind text)
   where w.user_id = v_user_id and w.id = d.id and d.kind = 'workout';
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  -- Already-known ids, counted before the upsert changes the answer.
  select
    (select count(*) from health.metrics m
      where m.user_id = v_user_id
        and m.id in (select x.id from jsonb_to_recordset(v_metrics) as x(id text)))
    +
    (select count(*) from health.workouts w
      where w.user_id = v_user_id
        and w.id in (select x.id from jsonb_to_recordset(v_workouts) as x(id text)))
  into v_duplicates;

  -- `distinct on` because one statement may not upsert the same key twice.
  --
  -- The WHERE on the conflict branch is for backfilled daily aggregates. Those
  -- share one id per day, and a backfill that stops at 09:00 sends a partial
  -- day. Letting a shorter span overwrite a longer one silently undercounts
  -- the day, so the wider window wins. Raw samples have a fixed span, so for
  -- them the condition is always true and a re-send is a plain update.
  insert into health.metrics as m (
    user_id, id, type, value, unit, start_at, end_at, source_name,
    source_bundle_id, metadata, device_id, export_id, timezone
  )
  select distinct on (x.id)
    v_user_id, x.id, x.type, x.value, x.unit, x.start_at, x.end_at, x.source_name,
    x.source_bundle_id, coalesce(x.metadata, '{}'::jsonb), p_device_id, v_export_id, v_timezone
  from jsonb_to_recordset(v_metrics) as x(
    id text, type text, value double precision, unit text,
    start_at timestamptz, end_at timestamptz, source_name text,
    source_bundle_id text, metadata jsonb
  )
  where not exists (
    select 1 from health.tombstones t where t.user_id = v_user_id and t.id = x.id
  )
  order by x.id, (x.end_at - x.start_at) desc
  on conflict (user_id, id) do update set
    type = excluded.type, value = excluded.value, unit = excluded.unit,
    start_at = excluded.start_at, end_at = excluded.end_at,
    source_name = excluded.source_name, source_bundle_id = excluded.source_bundle_id,
    metadata = excluded.metadata, device_id = excluded.device_id,
    export_id = excluded.export_id, timezone = excluded.timezone, received_at = now()
  where (excluded.end_at - excluded.start_at) >= (m.end_at - m.start_at);

  insert into health.workouts as w (
    user_id, id, activity_type, start_at, end_at, duration_seconds,
    total_energy_kcal, active_energy_kcal, distance_meters, source_name,
    source_bundle_id, metadata, device_id, export_id, timezone
  )
  select distinct on (x.id)
    v_user_id, x.id, x.activity_type, x.start_at, x.end_at, x.duration_seconds,
    x.total_energy_kcal, x.active_energy_kcal, x.distance_meters, x.source_name,
    x.source_bundle_id, coalesce(x.metadata, '{}'::jsonb), p_device_id, v_export_id, v_timezone
  from jsonb_to_recordset(v_workouts) as x(
    id text, activity_type text, start_at timestamptz, end_at timestamptz,
    duration_seconds double precision, total_energy_kcal double precision,
    active_energy_kcal double precision, distance_meters double precision,
    source_name text, source_bundle_id text, metadata jsonb
  )
  where not exists (
    select 1 from health.tombstones t where t.user_id = v_user_id and t.id = x.id
  )
  order by x.id
  on conflict (user_id, id) do update set
    activity_type = excluded.activity_type, start_at = excluded.start_at,
    end_at = excluded.end_at, duration_seconds = excluded.duration_seconds,
    total_energy_kcal = excluded.total_energy_kcal,
    active_energy_kcal = excluded.active_energy_kcal,
    distance_meters = excluded.distance_meters, source_name = excluded.source_name,
    source_bundle_id = excluded.source_bundle_id, metadata = excluded.metadata,
    device_id = excluded.device_id, export_id = excluded.export_id,
    timezone = excluded.timezone, received_at = now();

  return jsonb_build_object(
    'ok', true,
    'received', v_received,
    'duplicates', v_duplicates,
    'deleted', v_deleted,
    'export_id', v_export_id
  );
end;
$$;

-- Supabase's default privileges hand EXECUTE on new public functions to the
-- API roles. Take it back: only the service role may call this.
revoke all on function public.health_ingest(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.health_ingest(text, text, text, jsonb) to service_role;


-- ────────────────────────────────────────────────────────────
-- health.mint_ingest_token — run by hand, once per phone
--
--   select health.mint_ingest_token('iPhone');
--
-- Returns the token exactly once; only its hash is kept. With one user in the
-- project the owner is resolved automatically, the same convention the ledger
-- jobs use. With several, pass the user id.
-- ────────────────────────────────────────────────────────────
create or replace function health.mint_ingest_token(p_label text default null, p_user_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := p_user_id;
  v_token   text;
begin
  if v_user_id is null then
    if (select count(*) from auth.users) <> 1 then
      raise exception 'Several users exist; pass p_user_id explicitly.';
    end if;
    select u.id into v_user_id from auth.users u;
  end if;

  v_token := 'fh_health_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  insert into health.ingest_tokens (user_id, token_hash, label)
  values (v_user_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_label);

  return v_token;
end;
$$;

revoke all on function health.mint_ingest_token(text, uuid) from public, anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- health.daily_totals — cumulative types, one number per local day
--
-- HealthKit stores the iPhone's steps and the Watch's steps as separate
-- samples covering the same minutes. Summing them double counts; upstream's
-- summary view did exactly that. HealthKit's own answer needs its per-user
-- source priority list, which is not exported, so this view uses the standard
-- approximation: total each source separately and keep the largest. It can
-- undercount a day where you carried only the phone for part of it and only
-- the Watch for the rest. It can never double count.
--
-- A backfilled daily aggregate, when present, IS HealthKit's deduplicated
-- answer — but only if it covers the whole day. Partial ones are ignored in
-- favour of the raw samples.
-- ────────────────────────────────────────────────────────────
create or replace view health.daily_totals
with (security_invoker = true) as
with cumulative as (
  select m.*, (m.start_at at time zone m.timezone)::date as day
    from health.metrics m
   where m.type in (
     'step_count', 'active_energy', 'basal_energy', 'distance_walking_running',
     'distance_cycling', 'flights_climbed', 'apple_exercise_time', 'apple_stand_time',
     'dietary_energy', 'dietary_protein', 'dietary_carbs', 'dietary_fat', 'water'
   )
),
daily_aggregate as (
  select user_id, type, unit, day, value,
         (end_at - start_at >= interval '23 hours') as full_day
    from cumulative
   where metadata ->> 'aggregation' = 'daily_sum'
),
per_source as (
  select user_id, type, unit, day,
         coalesce(source_bundle_id, source_name) as source,
         sum(value) as value
    from cumulative
   where metadata ->> 'aggregation' is null
   group by 1, 2, 3, 4, 5
),
candidates as (
  select user_id, type, unit, day, value, 'healthkit_aggregate' as basis, 1 as tier
    from daily_aggregate where full_day
  union all
  select user_id, type, unit, day, value, source, 2
    from per_source
  union all
  -- Better than nothing for old days that only ever arrived as a partial backfill.
  select user_id, type, unit, day, value, 'healthkit_aggregate_partial', 3
    from daily_aggregate where not full_day
)
select distinct on (user_id, type, day)
       user_id, type, unit, day, value, basis
  from candidates
 order by user_id, type, day, tier, value desc;


-- ────────────────────────────────────────────────────────────
-- health.sleep_nights — time actually asleep, per night
--
-- Three corrections to a naive sum: `in_bed` and `awake` are not sleep;
-- overlapping stages from two sources are merged before measuring, not added;
-- and a night belongs to the morning it ends on (anything from 18:00 onward
-- counts toward the next date), so one night is never split at midnight.
-- ────────────────────────────────────────────────────────────
create or replace view health.sleep_nights
with (security_invoker = true) as
with asleep as (
  select user_id, start_at, end_at,
         ((start_at at time zone timezone) + interval '6 hours')::date as night
    from health.metrics
   where type = 'sleep_analysis'
     and metadata ->> 'sleep_stage' like 'asleep%'
),
marked as (
  select *,
         case when start_at <= max(end_at) over (
                partition by user_id, night order by start_at, end_at
                rows between unbounded preceding and 1 preceding)
              then 0 else 1 end as starts_island
    from asleep
),
islands as (
  select *, sum(starts_island) over (partition by user_id, night order by start_at, end_at) as island
    from marked
),
merged as (
  select user_id, night, island, min(start_at) as start_at, max(end_at) as end_at
    from islands
   group by 1, 2, 3
)
select user_id, night,
       min(start_at)                                             as fell_asleep_at,
       max(end_at)                                               as woke_at,
       round((extract(epoch from sum(end_at - start_at)) / 3600)::numeric, 2) as hours_asleep
  from merged
 group by 1, 2;

grant select on health.daily_totals, health.sleep_nights to service_role;


-- ============================================================
-- After running this file, mint the phone's token (shown once — copy it):
--
--   select health.mint_ingest_token('iPhone');
--
-- To cut a phone off:
--
--   update health.ingest_tokens set revoked_at = now() where label = 'iPhone';
-- ============================================================
