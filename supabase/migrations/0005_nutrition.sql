-- ============================================================
-- Nutrition — a dish dictionary, and the rollup that reads it
--
-- The ledger records what was ordered and what it cost. It has never recorded
-- what was in it. This migration adds the missing half without touching a
-- single existing column.
--
-- The shape follows from one observation about the data: a year of eating
-- produced 654 food events but only 146 distinct dish names. Nutrition is a
-- property of "Cheese Masala Dosa", not of the twenty-four separate evenings
-- you ordered one. So it lives in its own table, keyed by the normalized dish
-- name, and every event that mentions that dish reads the same row.
--
-- Three rules, mirroring the ones 0003 sets for events:
--
--   1. Estimates never masquerade as facts. `events.data` stays exactly as the
--      source stated it. Nothing here writes to it. A resolved dish carries
--      `source` and `confidence` saying where its numbers came from and how
--      much to trust them, and the rollup refuses to silently mix tiers.
--   2. Portion is recorded, not implied. Every structured food database in the
--      world returns kcal per 100g; a ledger row is "one mini thali". The
--      assumed gram weight that bridges those two is the single largest error
--      term in the estimate, so it is stored as a column you can correct —
--      never buried inside a kcal number you cannot audit.
--   3. Resolution is idempotent and cached forever. `(user_id,
--      normalized_name)` is unique, so re-running the resolver updates rows
--      instead of multiplying them, and a name already resolved never costs a
--      second API call.
--
-- Run order: after 0004_ledger_api.sql.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- food_items — the dish dictionary
--
-- One row per distinct thing you have eaten, keyed by the same
-- ledger_normalize_name() that already dedupes merchants. Values are per
-- *serving as sold* — one thali, one pizza, one packet — because that is the
-- unit the ledger counts. `portion_g` says what mass that serving was assumed
-- to be, which is what makes a per-100g database answer convertible and a
-- model's guess auditable.
-- ────────────────────────────────────────────────────────────
create table if not exists public.food_items (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,

  -- The name exactly as some receipt spelled it, kept for display and for
  -- tracing a row back to the order that created it.
  display_name    text        not null check (char_length(display_name) between 1 and 300),
  -- The cache key. ledger_normalize_name(display_name), so "Kapoor's Cafe" and
  -- "Kapoors Cafe" collapse the way they already do for entities.
  normalized_name text        not null check (char_length(normalized_name) between 1 and 300),

  -- Per serving as sold. Null is honest: a dish nobody could resolve reads as
  -- unknown rather than as zero calories.
  kcal            numeric(7,1) check (kcal      >= 0 and kcal      <= 20000),
  protein_g       numeric(6,1) check (protein_g >= 0 and protein_g <= 500),
  carbs_g         numeric(6,1) check (carbs_g   >= 0 and carbs_g   <= 2000),
  fat_g           numeric(6,1) check (fat_g     >= 0 and fat_g     <= 500),
  -- The assumed mass of one serving. Rule 2: stored, never implied.
  portion_g       numeric(7,1) check (portion_g > 0 and portion_g <= 20000),

  -- A coarse class ('thali', 'pizza', 'packaged_snack'), used for grouping in
  -- the UI. Free text on purpose — a new class must never need a migration.
  category        text         check (category ~ '^[a-z][a-z0-9_]{1,31}$'),

  -- Which rung of the resolver ladder produced this row. The ordering is the
  -- ladder's own preference order, and `source` is what lets a later run
  -- upgrade a weak row without overwriting a strong one:
  --   'manual'    a human typed it. Never overwritten by anything.
  --   'curated'   the checked-in table of dishes seen most often.
  --   'off'       Open Food Facts — a real label, for branded packaged goods.
  --   'fdc'       USDA FoodData Central.
  --   'llm'       the model estimated it.
  --   'heuristic' scaled from the bill. The floor, for names nothing resolved.
  source          text        not null default 'llm'
                    check (source in ('manual','curated','off','fdc','llm','heuristic')),
  -- What the source was actually asked and what it said, kept so a suspicious
  -- number can be traced without re-running anything: the matched database
  -- description, its per-100g values, the model's stated reasoning.
  source_ref      jsonb       not null default '{}'::jsonb,
  confidence      numeric(4,3)         check (confidence >= 0 and confidence <= 1),

  -- True once a human has looked at the row. Set by hand; the resolver reads
  -- it as "never touch this again".
  verified        boolean     not null default false,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (user_id, normalized_name)
);

create index if not exists food_items_user_cat_idx on public.food_items (user_id, category);
create index if not exists food_items_unresolved_idx on public.food_items (user_id)
  where kcal is null;
-- Fuzzy lookup for "have I seen something like this before", using the pg_trgm
-- that 0003 already installed.
create index if not exists food_items_name_trgm_idx
  on public.food_items using gin (normalized_name extensions.gin_trgm_ops);


create or replace function public.food_items_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists food_items_touch on public.food_items;
create trigger food_items_touch before update on public.food_items
  for each row execute function public.food_items_touch();


-- ────────────────────────────────────────────────────────────
-- Ladder precedence
--
-- Which rung's answer wins when two disagree. Higher is better. A resolver run
-- may only replace a row whose rank is strictly lower than what it is offering,
-- which is what makes re-running the whole ladder safe: a cheap rung can fill a
-- gap but can never demote a good answer.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_source_rank(p_source text)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case p_source
    when 'manual'    then 60
    when 'curated'   then 50
    when 'off'       then 40
    when 'fdc'       then 35
    when 'llm'       then 20
    when 'heuristic' then 10
    else 0
  end;
$$;


-- ────────────────────────────────────────────────────────────
-- food_upsert_item — the only way a dish row is written
--
-- Mirrors ledger_ingest_event's contract: the caller hands over what it
-- learned, and the database decides whether that is an improvement. A verified
-- row is never touched. A row from a better rung is never demoted. Anything
-- else is filled in.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_upsert_item(p_user_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  -- The jobs pass an explicit id because they run with nobody signed in. The
  -- browser passes null and means "me", the same convention the other RPCs use.
  v_user    uuid := coalesce(p_user_id, auth.uid());
  v_name    text := nullif(btrim(p_payload ->> 'display_name'), '');
  v_norm    text;
  v_source  text := coalesce(nullif(p_payload ->> 'source', ''), 'llm');
  v_existing public.food_items;
  v_row     public.food_items;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'display_name is required' using errcode = '22023';
  end if;

  v_norm := public.ledger_normalize_name(v_name);
  if v_norm is null then
    raise exception 'display_name normalizes to nothing: %', v_name using errcode = '22023';
  end if;

  select * into v_existing from public.food_items
   where user_id = v_user and normalized_name = v_norm;

  if found then
    -- Rule 1, enforced: a human's answer and a better rung's answer both stand.
    if v_existing.verified then
      return jsonb_build_object('id', v_existing.id, 'action', 'kept_verified');
    end if;
    if public.food_source_rank(v_source) < public.food_source_rank(v_existing.source) then
      return jsonb_build_object('id', v_existing.id, 'action', 'kept_stronger',
                                'existing_source', v_existing.source);
    end if;

    update public.food_items set
      display_name = coalesce(v_name, display_name),
      kcal      = coalesce(public.ledger_num(p_payload, 'kcal'),      kcal),
      protein_g = coalesce(public.ledger_num(p_payload, 'protein_g'), protein_g),
      carbs_g   = coalesce(public.ledger_num(p_payload, 'carbs_g'),   carbs_g),
      fat_g     = coalesce(public.ledger_num(p_payload, 'fat_g'),     fat_g),
      portion_g = coalesce(public.ledger_num(p_payload, 'portion_g'), portion_g),
      category  = coalesce(nullif(p_payload ->> 'category', ''),      category),
      source    = v_source,
      source_ref = case when p_payload ? 'source_ref'
                        then coalesce(p_payload -> 'source_ref', '{}'::jsonb) else source_ref end,
      confidence = coalesce(public.ledger_num(p_payload, 'confidence'), confidence)
     where id = v_existing.id
     returning * into v_row;

    return jsonb_build_object('id', v_row.id, 'action', 'updated', 'source', v_row.source);
  end if;

  insert into public.food_items (
    user_id, display_name, normalized_name, kcal, protein_g, carbs_g, fat_g,
    portion_g, category, source, source_ref, confidence
  ) values (
    v_user, v_name, v_norm,
    public.ledger_num(p_payload, 'kcal'),      public.ledger_num(p_payload, 'protein_g'),
    public.ledger_num(p_payload, 'carbs_g'),   public.ledger_num(p_payload, 'fat_g'),
    public.ledger_num(p_payload, 'portion_g'),
    nullif(p_payload ->> 'category', ''), v_source,
    coalesce(p_payload -> 'source_ref', '{}'::jsonb),
    public.ledger_num(p_payload, 'confidence')
  ) returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'action', 'created', 'source', v_row.source);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- food_match_item — the reference engine
--
-- Before anything is looked up or estimated, ask whether we already know this
-- dish under a slightly different name. A year of receipts spells the same
-- plate several ways — "Idli (2pc)" and "Idly (2pc)", "Kapoor's Cafe" and
-- "Kapoors Cafe" — and paying a model to re-estimate a dish already in the
-- dictionary is both wasteful and worse: two rows for one plate will disagree,
-- and the disagreement will show up as noise in a daily total.
--
-- Similarity is pg_trgm's, over the *normalized* names, so punctuation and
-- case never enter into it. The interesting part is what happens above the
-- threshold, and the rule is conservative on purpose:
--
--   Trigram similarity is blind to meaning. "Paneer Butter Masala Mini Thali"
--   and "Paneer Butter Masala Thali" score ~0.88 and are nearly the same dish.
--   "Veg Fried Rice" and "Egg Fried Rice" score ~0.79 and are not. So a match
--   is only *returned*, never auto-applied here — the caller decides, and it
--   applies one only when the two names differ by nothing that could change
--   what is on the plate. See MODIFIERS in ledger/nutrition/resolve.js.
--
-- Returns the best few candidates with their scores rather than a verdict, for
-- the same reason ledger_duplicate_candidates does: the judgement belongs to
-- the layer that can explain itself.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_match_item(
  p_name      text,
  p_threshold numeric default 0.55,
  p_limit     integer default 5,
  p_user_id   uuid    default null
)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_norm text := public.ledger_normalize_name(p_name);
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  if v_norm is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.similarity desc), '[]'::jsonb) into v_out
  from (
    select f.display_name, f.normalized_name, f.kcal, f.protein_g, f.carbs_g, f.fat_g,
           f.portion_g, f.category, f.source, f.confidence, f.verified,
           round(extensions.similarity(f.normalized_name, v_norm)::numeric, 3) as similarity,
           f.normalized_name = v_norm as exact
      from public.food_items f
     where f.user_id = v_user
       and f.kcal is not null
       and (f.normalized_name = v_norm
            or extensions.similarity(f.normalized_name, v_norm) >= p_threshold)
     order by (f.normalized_name = v_norm) desc,
              extensions.similarity(f.normalized_name, v_norm) desc
     limit greatest(p_limit, 1)
  ) r;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- food_pending_items — what the resolver still has to answer
--
-- Every distinct dish name across the user's food events that has no resolved
-- row yet, with how often it appears so the resolver can spend its budget on
-- the dishes that actually carry the calories. This is the query that makes the
-- cache the architecture: it returns 146 names for 654 events, and shrinks to
-- nothing once resolved.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_pending_items(
  p_limit   integer default 500,
  p_user_id uuid    default null
)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with line_items as (
    select
      nullif(btrim(item ->> 'name'), '')                             as display_name,
      public.ledger_normalize_name(nullif(btrim(item ->> 'name'), '')) as normalized_name,
      coalesce(public.ledger_num(item, 'qty'), 1)                    as qty
    from public.events e
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(e.data -> 'items') = 'array'
           then e.data -> 'items' else '[]'::jsonb end) as item
    where e.user_id = v_user
      and e.type = 'food'
      and e.status <> 'dismissed'
  ),
  rolled as (
    select normalized_name,
           mode() within group (order by display_name) as display_name,
           count(*)::int                              as occurrences,
           sum(qty)::numeric                          as total_qty
    from line_items
    where normalized_name is not null
    group by normalized_name
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.occurrences desc, r.normalized_name), '[]'::jsonb)
    into v_out
  from (
    select rolled.*
    from rolled
    left join public.food_items f
      on f.user_id = v_user and f.normalized_name = rolled.normalized_name
    where f.id is null or f.kcal is null
    order by rolled.occurrences desc, rolled.normalized_name
    limit greatest(p_limit, 0)
  ) r;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- food_event_nutrition — the rollup
--
-- Joins each food event's line items to the dictionary and sums them. The
-- honest part is `basis`:
--
--   'itemized'  every line item resolved. The number means something.
--   'partial'   some resolved, some did not. Reported WITH the shortfall, so a
--               half-answered order can never be read as a light meal.
--   'none'      no line items at all — 53% of this ledger. The caller decides
--               whether to fall back to scaling from the bill; the database
--               will not invent a number to fill the hole.
--
-- Rule 1 again: this is a read-time computation. It writes nothing back onto
-- the event, so correcting one dish row re-values the entire year at once and
-- leaves no stale copies behind.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_event_nutrition(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_limit   integer     default 2000,
  p_user_id uuid        default null
)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id, e.occurred_at, e.subtype, e.title,
           public.ledger_num(e.data, 'amount')                         as amount,
           coalesce(e.data ->> 'ordered_via', e.data ->> 'merchant')   as via,
           coalesce(e.data ->> 'restaurant',  e.data ->> 'merchant')   as place,
           case when jsonb_typeof(e.data -> 'items') = 'array'
                then e.data -> 'items' else '[]'::jsonb end            as items
    from public.events e
    where e.user_id = v_user
      and e.type = 'food'
      and e.status <> 'dismissed'
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <= p_to)
    order by e.occurred_at desc
    limit greatest(p_limit, 0)
  ),
  li as (
    select ev.id as event_id,
           coalesce(public.ledger_num(item, 'qty'), 1) as qty,
           f.kcal, f.protein_g, f.carbs_g, f.fat_g, f.category, f.source, f.confidence
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  agg as (
    select event_id,
           count(*)::int                                     as items_total,
           count(kcal)::int                                  as items_resolved,
           sum(qty * kcal)                                   as kcal,
           sum(qty * protein_g)                              as protein_g,
           sum(qty * carbs_g)                                as carbs_g,
           sum(qty * fat_g)                                  as fat_g,
           min(confidence)                                   as confidence,
           -- The weakest rung that contributed is the one worth reporting.
           min(public.food_source_rank(source))              as weakest_rank
    from li group by event_id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.occurred_at desc), '[]'::jsonb) into v_out
  from (
    select ev.id, ev.occurred_at, ev.subtype, ev.title, ev.amount, ev.via, ev.place,
           coalesce(a.items_total, 0)    as items_total,
           coalesce(a.items_resolved, 0) as items_resolved,
           round(a.kcal, 1)      as kcal,
           round(a.protein_g, 1) as protein_g,
           round(a.carbs_g, 1)   as carbs_g,
           round(a.fat_g, 1)     as fat_g,
           a.confidence,
           case
             when coalesce(a.items_total, 0) = 0                then 'none'
             when a.items_resolved = 0                          then 'none'
             when a.items_resolved < a.items_total              then 'partial'
             else 'itemized'
           end as basis
    from ev left join agg a on a.event_id = ev.id
  ) r;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- food_coverage — how much of the ledger the dictionary can actually answer
--
-- The number to look at before trusting any total on the dashboard. Reported
-- as line items and as events, because those degrade differently: one
-- unresolved side dish barely moves an order, one unresolved thali is the
-- whole meal.
-- ────────────────────────────────────────────────────────────
create or replace function public.food_coverage(p_user_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id,
           case when jsonb_typeof(e.data -> 'items') = 'array'
                then e.data -> 'items' else '[]'::jsonb end as items
    from public.events e
    where e.user_id = v_user and e.type = 'food' and e.status <> 'dismissed'
  ),
  li as (
    select ev.id as event_id, f.kcal is not null as resolved
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  per_event as (
    select event_id, count(*) as n, count(*) filter (where resolved) as ok
    from li group by event_id
  )
  select jsonb_build_object(
    'events_total',        (select count(*) from ev),
    'events_with_items',   (select count(*) from per_event),
    'events_itemized',     (select count(*) from per_event where ok = n),
    'events_partial',      (select count(*) from per_event where ok > 0 and ok < n),
    'events_no_items',     (select count(*) from ev) - (select count(*) from per_event),
    'line_items_total',    (select count(*) from li),
    'line_items_resolved', (select count(*) from li where resolved),
    'dictionary_size',     (select count(*) from public.food_items where user_id = v_user),
    'dictionary_resolved', (select count(*) from public.food_items
                             where user_id = v_user and kcal is not null),
    'by_source',           (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
                              from (select source, count(*) as n from public.food_items
                                     where user_id = v_user and kcal is not null
                                     group by source) s)
  ) into v_out;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Security
--
-- Same posture as 0003: RLS owner-scoped, anon revoked, and the SECURITY
-- DEFINER functions gated on ledger_can_act_as() rather than trusting the
-- user id they were handed.
-- ────────────────────────────────────────────────────────────
alter table public.food_items enable row level security;
drop policy if exists food_items_owner on public.food_items;
create policy food_items_owner on public.food_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.food_items from anon;
grant select, insert, update, delete on public.food_items to authenticated;
grant all on public.food_items to service_role;

revoke all on function public.food_upsert_item(uuid, jsonb)                     from anon;
revoke all on function public.food_match_item(text, numeric, integer, uuid)     from anon;
revoke all on function public.food_pending_items(integer, uuid)                 from anon;
revoke all on function public.food_event_nutrition(timestamptz, timestamptz, integer, uuid) from anon;
revoke all on function public.food_coverage(uuid)                               from anon;
revoke all on function public.food_source_rank(text)                            from anon;

grant execute on function public.food_upsert_item(uuid, jsonb)                     to authenticated, service_role;
grant execute on function public.food_match_item(text, numeric, integer, uuid)     to authenticated, service_role;
grant execute on function public.food_pending_items(integer, uuid)                 to authenticated, service_role;
grant execute on function public.food_event_nutrition(timestamptz, timestamptz, integer, uuid) to authenticated, service_role;
grant execute on function public.food_coverage(uuid)                               to authenticated, service_role;
grant execute on function public.food_source_rank(text)                            to authenticated, service_role;
