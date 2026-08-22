-- ============================================================
-- Personal Event Ledger — function layer
--
-- This file is the API. The browser calls it, the ingestion jobs call it, and
-- Hermes calls it — the same functions, with the same rules, over the same
-- rows. Nothing here is a convenience wrapper the UI could skip: the
-- deduplication and merge logic lives in the database precisely so that a new
-- source connector cannot accidentally get it wrong.
--
-- Security model: every function is SECURITY INVOKER, so RLS is what enforces
-- ownership for a signed-in caller. The jobs connect with the service role,
-- which bypasses RLS, so functions that jobs use take an explicit p_user_id and
-- check ledger_can_act_as() rather than trusting the argument.
--
-- Requires 0003_event_ledger.sql.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Guards and small helpers
-- ────────────────────────────────────────────────────────────

create or replace function public.ledger_can_act_as(p_user_id uuid)
returns boolean language sql stable set search_path = public, extensions, pg_temp as $$
  select p_user_id is not null
     and (auth.uid() = p_user_id or current_user in ('service_role','postgres','supabase_admin'));
$$;

-- Thresholds are user settings, not constants baked into the schema. Missing
-- rows fall back to the default passed in, so nothing needs seeding.
create or replace function public.ledger_setting(p_user_id uuid, p_key text, p_default numeric)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select nullif(value #>> '{}', '')::numeric from public.user_settings
      where user_id = p_user_id and key = p_key),
    p_default
  );
$$;

create or replace function public.ledger_setting_text(p_user_id uuid, p_key text, p_default text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select nullif(value #>> '{}', '') from public.user_settings
      where user_id = p_user_id and key = p_key),
    p_default
  );
$$;

-- Confidence → status. The bands are settings (ledger_confidence_confirmed /
-- ledger_confidence_review), so tightening what counts as "reliable" is a
-- settings change, not a migration.
create or replace function public.ledger_status_for(p_user_id uuid, p_confidence numeric)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when p_confidence is null then 'confirmed'
    when p_confidence >= public.ledger_setting(p_user_id, 'ledger_confidence_confirmed', 0.90) then 'confirmed'
    when p_confidence >= public.ledger_setting(p_user_id, 'ledger_confidence_review',    0.75) then 'inferred'
    else 'needs_review'
  end;
$$;

-- A jsonb value that should be a number but came from an LLM might be "₹1,299".
-- Never let that abort an ingestion run.
create or replace function public.ledger_num(p_data jsonb, p_key text)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $$
begin
  return nullif(p_data ->> p_key, '')::numeric;
exception when others then
  return null;
end;
$$;

-- The SQL twin of normalizeName() in src/ledger/normalize.js. The pipeline
-- normalizes in JS and passes normalized_name explicitly — the same rules also
-- have to run in the browser — but ledger_find_duplicate has to normalize raw
-- source strings here, so the two must produce identical output. The suffix
-- strip loops because "Amazon Pay India Private Limited" sheds three of them.
create or replace function public.ledger_normalize_name(p_name text)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v text := regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g');
  v_prev text;
begin
  loop
    v_prev := v;
    v := regexp_replace(v, '\s+(pvt|private|ltd|limited|inc|llc|india|technologies|services)\s*$', '');
    exit when v = v_prev;
  end loop;
  return nullif(btrim(v), '');
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Entity resolution
--
-- Exact match on the normalized name first, then a trigram near-match, so
-- "Third Wave Coffee" and "Third Wave Coffee Roasters" resolve to one entity
-- instead of two. `name` keeps the longest form seen — usually the most
-- complete one — and metadata accumulates.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_resolve_entity(
  p_user_id         uuid,
  p_type            text,
  p_name            text,
  p_normalized_name text default null,
  p_metadata        jsonb default '{}'::jsonb
) returns uuid
language plpgsql set search_path = public, extensions, pg_temp as $$
declare
  v_norm    text := coalesce(nullif(p_normalized_name, ''), public.ledger_normalize_name(p_name));
  v_id      uuid;
  v_min_sim numeric;
begin
  if v_norm is null or p_name is null then return null; end if;

  select id into v_id from public.entities
   where user_id = p_user_id and type = p_type and normalized_name = v_norm;

  if v_id is null then
    v_min_sim := public.ledger_setting(p_user_id, 'ledger_entity_similarity', 0.82);
    select id into v_id from public.entities
     where user_id = p_user_id and type = p_type
       and extensions.similarity(normalized_name, v_norm) >= v_min_sim
     order by extensions.similarity(normalized_name, v_norm) desc
     limit 1;
  end if;

  if v_id is null then
    insert into public.entities (user_id, type, name, normalized_name, metadata)
    values (p_user_id, p_type, p_name, v_norm, coalesce(p_metadata, '{}'::jsonb))
    on conflict (user_id, type, normalized_name) do update set name = public.entities.name
    returning id into v_id;
  else
    update public.entities
       set name     = case when char_length(p_name) > char_length(name) then p_name else name end,
           metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
     where id = v_id;
  end if;

  return v_id;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Duplicate detection
--
-- Only reached when no deterministic identifier was available. Amount is
-- treated as disqualifying rather than merely unhelpful: two ₹450 and ₹780
-- restaurant charges an hour apart are two meals, not one, and merging them
-- would silently destroy a fact.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_find_duplicate(
  p_user_id     uuid,
  p_type        text,
  p_subtype     text,
  p_occurred_at timestamptz,
  p_amount      numeric default null,
  p_match_name  text    default null,
  p_window_minutes integer default null,
  -- Types a match may cross into. A card alert arrives as `purchase` and the
  -- food order it paid for as `food`; restricting to one type guarantees two
  -- events for one dinner. The caller only widens this when there is an amount
  -- to agree on, and a disagreement on amount or name still disqualifies.
  p_match_types text[] default null
) returns uuid
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare
  v_window   integer := coalesce(p_window_minutes, public.ledger_setting(p_user_id, 'ledger_dedupe_window_minutes', 180)::int);
  v_tol      numeric := public.ledger_setting(p_user_id, 'ledger_dedupe_amount_tolerance', 0.02);
  v_min      numeric := public.ledger_setting(p_user_id, 'ledger_dedupe_min_score', 0.60);
  v_min_name numeric := public.ledger_setting(p_user_id, 'ledger_dedupe_min_name_similarity', 0.30);
  v_norm     text    := public.ledger_normalize_name(p_match_name);
  v_id       uuid;
begin
  if p_occurred_at is null then return null; end if;

  select c.id into v_id
  from (
    select
      e.id,
        -- An exact amount is much stronger evidence than one that merely falls
        -- inside the tolerance, and scoring them the same let a ₹94.00 payment
        -- merge into a ₹94.58 order.
        case when m.exact_amount then 0.50
             when m.near_amount  then 0.32
             else 0 end
      + case when m.name_sim is not null then m.name_sim * 0.35 else 0 end
      + case when e.type = p_type then 0.10 else 0 end
      + case when p_subtype is not null and e.subtype = p_subtype then 0.05 else 0 end
      + (1 - least(abs(extract(epoch from (e.occurred_at - p_occurred_at))) / greatest(v_window * 60, 1), 1)) * 0.15
      as score
    from public.events e
    left join lateral (
      select max(extensions.similarity(en.normalized_name, v_norm)) as sim
      from public.event_entities ee
      join public.entities en on en.id = ee.entity_id
      where ee.event_id = e.id
    ) ent on v_norm is not null
    cross join lateral (
      select
        public.ledger_num(e.data, 'amount') as ev_amount,
        -- Only real name fields. The title is not one: "Card transaction —
        -- ₹450" would otherwise be compared as if it named a merchant.
        public.ledger_normalize_name(
          coalesce(e.data ->> 'merchant', e.data ->> 'restaurant', e.data ->> 'provider')) as ev_name
    ) raw
    cross join lateral (
      select
        raw.ev_amount,
        (p_amount is not null and raw.ev_amount is not null and raw.ev_amount = p_amount) as exact_amount,
        (p_amount is not null and raw.ev_amount is not null
          and abs(raw.ev_amount - p_amount) <= greatest(1, abs(p_amount) * v_tol)) as near_amount,
        -- Null when either side is unnamed: nothing to agree or disagree about.
        case when raw.ev_name is null or v_norm is null then null
             else greatest(coalesce(ent.sim, 0),
                           coalesce(extensions.similarity(raw.ev_name, v_norm), 0))
        end as name_sim
    ) m
    where e.user_id = p_user_id
      and e.type = any (coalesce(p_match_types, array[p_type]))
      and e.status <> 'dismissed'
      and e.occurred_at between p_occurred_at - make_interval(mins => v_window)
                            and p_occurred_at + make_interval(mins => v_window)
      -- An amount disagreement disqualifies outright. Two restaurant charges an
      -- hour apart for different amounts are two meals, and merging them would
      -- destroy a fact rather than deduplicate one.
      and (p_amount is null or m.ev_amount is null or m.near_amount)
      -- And so does a name disagreement, for exactly the same reason. A ₹94
      -- payment to Smartworks and a ₹94.58 order from Zomato are two things
      -- that happened, however close together they were.
      and (m.name_sim is null or m.name_sim >= v_min_name)
  ) c
  where c.score >= v_min
  order by c.score desc
  limit 1;

  return v_id;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Audit writer
--
-- The audit table has no INSERT policy on purpose, so the append has to go
-- through here. SECURITY DEFINER, but it can only ever write a log line, and
-- only for a user the caller is allowed to act as.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_log(
  p_user_id uuid, p_action text, p_table text, p_record uuid,
  p_before jsonb default null, p_after jsonb default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.ledger_can_act_as(p_user_id) then
    raise exception 'not authorized for user %', p_user_id using errcode = '42501';
  end if;
  insert into public.ledger_audit_log (user_id, actor, action, table_name, record_id, before, after)
  values (p_user_id, public.ledger_actor(), p_action, p_table, p_record, p_before, p_after);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- ledger_ingest_event — the single write path
--
-- Every connector, Hermes and the manual "Add event" form all land here, which
-- is what makes "one real-world event, one row, all of its sources" a property
-- of the system rather than of any one caller.
--
-- Payload:
--   { "event":    { occurred_at, occurred_at_end, type, subtype, title, description,
--                   data, inference, confidence, status, dedupe_key, source_type },
--     "source":   { source_type, external_id, external_url, source_timestamp,
--                   raw_reference, metadata, account_key },
--     "entities": [ { type, name, normalized_name, relationship, metadata } ],
--     "relations":[ { related_event_id | related_dedupe_key, relationship } ],
--     "match":    { amount, name },        -- fuzzy fallback keys
--     "extracted_by": "rules:amazon_order" }
--
-- `event` may be omitted entirely: an email worth keeping as provenance but
-- carrying no event (a work thread, a newsletter that was checked and rejected)
-- still records its source, which is what keeps the next run from re-reading it.
--
-- Returns { action, event_id, source_id, matched_by, conflicts }.
-- action is one of created | updated | skipped | source_only.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_ingest_event(p_user_id uuid, p_payload jsonb)
returns jsonb
language plpgsql set search_path = public, extensions, pg_temp as $$
declare
  v_ev        jsonb := p_payload -> 'event';
  v_src       jsonb := p_payload -> 'source';
  v_ents      jsonb := coalesce(p_payload -> 'entities',  '[]'::jsonb);
  v_rels      jsonb := coalesce(p_payload -> 'relations', '[]'::jsonb);
  v_match     jsonb := coalesce(p_payload -> 'match',     '{}'::jsonb);
  v_source_id uuid;
  v_event_id  uuid;
  v_existing  public.events%rowtype;
  v_after     public.events%rowtype;
  v_action    text;
  v_matched_by text;
  v_conf      numeric;
  v_bump      numeric := 0;
  v_status    text;
  v_conflicts jsonb := '[]'::jsonb;
  v_occ       timestamptz;
  v_ent       jsonb;
  v_rel       jsonb;
  v_entity_id uuid;
  v_related   uuid;
  v_src_type  text;
begin
  if not public.ledger_can_act_as(p_user_id) then
    raise exception 'not authorized for user %', p_user_id using errcode = '42501';
  end if;

  -- 1. Provenance first. The source row is written whether or not an event
  --    comes out of it, so the checkpoint can move past this item either way.
  if v_src is not null and coalesce(v_src ->> 'external_id', '') <> '' then
    insert into public.sources (user_id, source_type, external_id, external_url,
                                source_timestamp, raw_reference, metadata, account_key)
    values (p_user_id,
            coalesce(v_src ->> 'source_type', 'other'),
            v_src ->> 'external_id',
            nullif(v_src ->> 'external_url', ''),
            nullif(v_src ->> 'source_timestamp', '')::timestamptz,
            v_src -> 'raw_reference',
            coalesce(v_src -> 'metadata', '{}'::jsonb),
            nullif(v_src ->> 'account_key', ''))
    on conflict (user_id, source_type, external_id) do update
      set metadata     = public.sources.metadata || excluded.metadata,
          external_url = coalesce(excluded.external_url, public.sources.external_url)
    returning id into v_source_id;
  end if;

  if v_ev is null or jsonb_typeof(v_ev) <> 'object' then
    return jsonb_build_object('action', 'source_only', 'event_id', null, 'source_id', v_source_id);
  end if;

  v_occ      := nullif(v_ev ->> 'occurred_at', '')::timestamptz;
  v_src_type := coalesce(nullif(v_ev ->> 'source_type', ''), v_src ->> 'source_type', 'manual');
  if v_occ is null then
    raise exception 'event.occurred_at is required' using errcode = '22004';
  end if;

  -- 2. Is this already in the ledger? Strongest evidence first.
  --
  -- event_keys, not events.dedupe_key: an event is known by every identifier
  -- any of its sources carried, so the card alert's transaction reference finds
  -- the purchase that the order mail created under an order number.
  if coalesce(v_ev ->> 'dedupe_key', '') <> '' then
    select e.* into v_existing
      from public.event_keys k
      join public.events e on e.id = k.event_id
     where k.user_id = p_user_id and k.key = v_ev ->> 'dedupe_key';
    if found then v_matched_by := 'dedupe_key'; end if;
  end if;

  -- A source we have already turned into an event: a replay of the same run.
  if v_existing.id is null and v_source_id is not null then
    select e.* into v_existing
      from public.events e
      join public.event_sources es on es.event_id = e.id
     where es.source_id = v_source_id
     order by es.created_at
     limit 1;
    if v_existing.id is not null then v_matched_by := 'source_replay'; end if;
  end if;

  -- Last resort: same kind of thing, around the same time, same money or name.
  if v_existing.id is null then
    v_event_id := public.ledger_find_duplicate(
      p_user_id, coalesce(v_ev ->> 'type', 'other'), nullif(v_ev ->> 'subtype', ''), v_occ,
      public.ledger_num(v_match, 'amount'), nullif(v_match ->> 'name', ''), null,
      case when jsonb_typeof(v_match -> 'types') = 'array'
           then array(select jsonb_array_elements_text(v_match -> 'types'))
           else null end);
    if v_event_id is not null then
      select * into v_existing from public.events where id = v_event_id;
      v_matched_by := 'fuzzy';
    end if;
  end if;

  -- 3a. Known event → merge evidence into it.
  if v_existing.id is not null then
    v_event_id := v_existing.id;

    -- A dismissed event stays dismissed. Attach the evidence — provenance is
    -- still worth keeping — but never let a later source resurrect it.
    if v_existing.status = 'dismissed' then
      if v_source_id is not null then
        insert into public.event_sources (event_id, source_id, user_id, role, contributed, confidence, extracted_by)
        values (v_event_id, v_source_id, p_user_id, 'corroborating',
                coalesce(v_ev -> 'data', '{}'::jsonb), public.ledger_num(v_ev, 'confidence'),
                coalesce(p_payload ->> 'extracted_by', 'unknown'))
        on conflict (event_id, source_id) do nothing;
      end if;
      return jsonb_build_object('action', 'skipped', 'event_id', v_event_id,
                                'source_id', v_source_id, 'matched_by', v_matched_by,
                                'reason', 'dismissed');
    end if;

    -- What the new source claims that contradicts what we already hold. The
    -- existing value wins (rule 2: a later interpretation never overwrites a
    -- recorded fact) and the disagreement is logged rather than dropped.
    select coalesce(jsonb_agg(jsonb_build_object(
             'key', k, 'kept', v_existing.data -> k, 'rejected', (v_ev -> 'data') -> k)), '[]'::jsonb)
      into v_conflicts
      from jsonb_object_keys(coalesce(v_ev -> 'data', '{}'::jsonb)) k
     where v_existing.data ? k
       and v_existing.data -> k is distinct from (v_ev -> 'data') -> k;

    -- Corroboration raises confidence only when the evidence is independent —
    -- the same connector seeing the same mail twice proves nothing.
    if v_source_id is not null and not exists (
      select 1 from public.event_sources es
      join public.sources s on s.id = es.source_id
      where es.event_id = v_event_id and s.source_type = coalesce(v_src ->> 'source_type', v_src_type)
    ) then
      v_bump := public.ledger_setting(p_user_id, 'ledger_corroboration_bump', 0.03);
    end if;

    if v_existing.confidence is null and (v_ev ->> 'confidence') is null then
      v_conf := null;
    else
      v_conf := least(0.999, greatest(coalesce(v_existing.confidence, 0),
                                      coalesce(public.ledger_num(v_ev, 'confidence'), 0)) + v_bump);
    end if;

    -- A verdict the user entered by hand outranks anything an extractor computes.
    v_status := case
      when v_existing.source_type in ('manual', 'hermes') and v_existing.status = 'confirmed' then v_existing.status
      else public.ledger_status_for(p_user_id, v_conf)
    end;

    update public.events e set
      data            = coalesce(v_ev -> 'data', '{}'::jsonb) || e.data,   -- existing keys win
      inference       = e.inference || coalesce(v_ev -> 'inference', '{}'::jsonb),
      description     = coalesce(e.description, nullif(v_ev ->> 'description', '')),
      subtype         = coalesce(e.subtype, nullif(v_ev ->> 'subtype', '')),
      occurred_at_end = coalesce(e.occurred_at_end, nullif(v_ev ->> 'occurred_at_end', '')::timestamptz),
      confidence      = v_conf,
      status          = v_status
    where e.id = v_event_id
    returning e.* into v_after;

    v_action := case
      when v_after.data       is distinct from v_existing.data
        or v_after.status     is distinct from v_existing.status
        or v_after.confidence is distinct from v_existing.confidence
        or v_after.subtype    is distinct from v_existing.subtype
        or v_after.description is distinct from v_existing.description
      then 'updated' else 'skipped'
    end;

    if v_action = 'updated' or v_conflicts <> '[]'::jsonb then
      perform public.ledger_log(p_user_id, 'event_merged', 'events', v_event_id,
        jsonb_build_object('confidence', v_existing.confidence, 'status', v_existing.status),
        jsonb_build_object('confidence', v_after.confidence, 'status', v_after.status,
                           'matched_by', v_matched_by, 'source_id', v_source_id,
                           'conflicts', v_conflicts));
    end if;

  -- 3b. New event.
  else
    v_conf   := public.ledger_num(v_ev, 'confidence');
    v_status := coalesce(nullif(v_ev ->> 'status', ''), public.ledger_status_for(p_user_id, v_conf));

    insert into public.events (user_id, occurred_at, occurred_at_end, type, subtype, title, description,
                               data, inference, source_id, source_type, confidence, status, dedupe_key)
    values (p_user_id, v_occ, nullif(v_ev ->> 'occurred_at_end', '')::timestamptz,
            coalesce(nullif(v_ev ->> 'type', ''), 'other'), nullif(v_ev ->> 'subtype', ''),
            left(coalesce(nullif(v_ev ->> 'title', ''), 'Untitled event'), 300),
            nullif(v_ev ->> 'description', ''),
            coalesce(v_ev -> 'data', '{}'::jsonb), coalesce(v_ev -> 'inference', '{}'::jsonb),
            v_source_id, v_src_type, v_conf, v_status, nullif(v_ev ->> 'dedupe_key', ''))
    -- Two jobs racing on the same order id must not both win.
    on conflict (user_id, dedupe_key) where dedupe_key is not null
      do update set updated_at = now()
    returning id into v_event_id;

    v_action    := 'created';
    v_matched_by := coalesce(v_matched_by, 'none');
  end if;

  -- 4. Register this identifier against the event, whether it created the
  --    event or merged into one. That is what makes the *next* source carrying
  --    either identifier an exact match instead of a fuzzy guess.
  if coalesce(v_ev ->> 'dedupe_key', '') <> '' then
    insert into public.event_keys (user_id, key, event_id)
    values (p_user_id, v_ev ->> 'dedupe_key', v_event_id)
    on conflict (user_id, key) do nothing;
  end if;

  -- 5. Attach the evidence.
  if v_source_id is not null then
    insert into public.event_sources (event_id, source_id, user_id, role, contributed, confidence, extracted_by)
    values (v_event_id, v_source_id, p_user_id,
            case when v_action = 'created' then 'origin' else 'corroborating' end,
            coalesce(v_ev -> 'data', '{}'::jsonb),
            public.ledger_num(v_ev, 'confidence'),
            coalesce(p_payload ->> 'extracted_by', 'unknown'))
    on conflict (event_id, source_id) do nothing;
  end if;

  -- 6. Entities: "what did I buy from Amazon" is this join, not a text search.
  for v_ent in select value from jsonb_array_elements(v_ents) loop
    v_entity_id := public.ledger_resolve_entity(
      p_user_id, coalesce(nullif(v_ent ->> 'type', ''), 'other'), v_ent ->> 'name',
      nullif(v_ent ->> 'normalized_name', ''), coalesce(v_ent -> 'metadata', '{}'::jsonb));
    if v_entity_id is not null then
      insert into public.event_entities (event_id, entity_id, user_id, relationship)
      values (v_event_id, v_entity_id, p_user_id, coalesce(nullif(v_ent ->> 'relationship', ''), 'related'))
      on conflict do nothing;
    end if;
  end loop;

  -- 7. Relations to other events, addressable by dedupe_key so a connector can
  --    link to an event it has not seen the id of.
  for v_rel in select value from jsonb_array_elements(v_rels) loop
    v_related := null;
    if coalesce(v_rel ->> 'related_event_id', '') <> '' then
      v_related := (v_rel ->> 'related_event_id')::uuid;
    elsif coalesce(v_rel ->> 'related_dedupe_key', '') <> '' then
      select event_id into v_related from public.event_keys
       where user_id = p_user_id and key = v_rel ->> 'related_dedupe_key';
    end if;
    if v_related is not null and v_related <> v_event_id then
      insert into public.event_relations (user_id, event_id, related_event_id, relationship)
      values (p_user_id, v_event_id, v_related, coalesce(nullif(v_rel ->> 'relationship', ''), 'related'))
      on conflict do nothing;
    end if;
  end loop;

  return jsonb_build_object(
    'action', v_action, 'event_id', v_event_id, 'source_id', v_source_id,
    'matched_by', v_matched_by, 'conflicts', v_conflicts);
end;
$$;


-- ============================================================
-- Query layer — what Hermes and the UI actually call
-- ============================================================

-- One event, rendered. `p_detail` adds provenance, related events and the
-- audit history; the timeline does not need any of that per row.
create or replace function public.ledger_event_json(p_event public.events, p_detail boolean default false)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id',              p_event.id,
    'occurred_at',     p_event.occurred_at,
    'occurred_at_end', p_event.occurred_at_end,
    'type',            p_event.type,
    'subtype',         p_event.subtype,
    'title',           p_event.title,
    'description',     p_event.description,
    'data',            p_event.data,
    'inference',       p_event.inference,
    'source_type',     p_event.source_type,
    'source_id',       p_event.source_id,
    'confidence',      p_event.confidence,
    'status',          p_event.status,
    'dedupe_key',      p_event.dedupe_key,
    'created_at',      p_event.created_at,
    'updated_at',      p_event.updated_at,
    'entities', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', en.id, 'type', en.type, 'name', en.name, 'relationship', ee.relationship
             ) order by en.name), '[]'::jsonb)
      from public.event_entities ee
      join public.entities en on en.id = ee.entity_id
      where ee.event_id = p_event.id
    ),
    'source_count', (select count(*) from public.event_sources es where es.event_id = p_event.id)
  )
  || case when p_detail then jsonb_build_object(
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'source_type', s.source_type, 'external_id', s.external_id,
               'external_url', s.external_url, 'source_timestamp', s.source_timestamp,
               'account_key', s.account_key, 'metadata', s.metadata, 'raw_reference', s.raw_reference,
               'role', es.role, 'extracted_by', es.extracted_by, 'contributed', es.contributed
             ) order by es.created_at), '[]'::jsonb)
      from public.event_sources es
      join public.sources s on s.id = es.source_id
      where es.event_id = p_event.id
    ),
    'related_events', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e2.id, 'relationship', r.relationship, 'title', e2.title,
               'occurred_at', e2.occurred_at, 'type', e2.type)), '[]'::jsonb)
      from public.event_relations r
      join public.events e2 on e2.id = r.related_event_id
      where r.event_id = p_event.id
    ),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'action', a.action, 'actor', a.actor, 'at', a.at,
               'before', a.before, 'after', a.after) order by a.at desc), '[]'::jsonb)
      from public.ledger_audit_log a where a.record_id = p_event.id
    )
  ) else '{}'::jsonb end;
$$;

-- Local-day boundaries. The ledger stores timestamptz; "what did I do
-- yesterday" is a question about the user's clock, not UTC.
create or replace function public.ledger_day_range(p_user_id uuid, p_date date)
returns tstzrange language sql stable set search_path = public, pg_temp as $$
  select tstzrange(
    (p_date::timestamp)             at time zone public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata'),
    ((p_date + 1)::timestamp)       at time zone public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata'),
    '[)'
  );
$$;

-- search_events(query, filters, date_range)
--
-- Dismissed events are hidden unless explicitly asked for: they are the
-- answer to "this never happened", and they should not come back in a
-- timeline just because they matched a keyword.
create or replace function public.ledger_search_events(
  p_query          text        default null,
  p_types          text[]      default null,
  p_subtypes       text[]      default null,
  p_statuses       text[]      default null,
  p_source_types   text[]      default null,
  p_entity_id      uuid        default null,
  p_entity_name    text        default null,
  p_from           timestamptz default null,
  p_to             timestamptz default null,
  p_min_confidence numeric     default null,
  p_limit          integer     default 50,
  p_offset         integer     default 0,
  p_ascending      boolean     default false,
  p_user_id        uuid        default null
) returns jsonb
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare
  v_uid    uuid := coalesce(p_user_id, auth.uid());
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  with base as (
    select e.*
    from public.events e
    where e.user_id = v_uid
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <  p_to)
      and (p_types        is null or e.type        = any (p_types))
      and (p_subtypes     is null or e.subtype     = any (p_subtypes))
      and (p_source_types is null or e.source_type = any (p_source_types))
      and (case when p_statuses is null then e.status <> 'dismissed'
                else e.status = any (p_statuses) end)
      and (p_min_confidence is null or coalesce(e.confidence, 1) >= p_min_confidence)
      and (p_query is null or p_query = '' or
           e.search_tsv @@ websearch_to_tsquery('simple', p_query) or
           e.title ilike '%' || p_query || '%')
      and (p_entity_id is null or exists (
             select 1 from public.event_entities ee
             where ee.event_id = e.id and ee.entity_id = p_entity_id))
      and (p_entity_name is null or exists (
             select 1 from public.event_entities ee
             join public.entities en on en.id = ee.entity_id
             where ee.event_id = e.id
               and en.normalized_name = public.ledger_normalize_name(p_entity_name)))
  ), page as (
    select id,
           row_number() over (
             order by case when p_ascending then occurred_at end asc,
                      case when p_ascending then null else occurred_at end desc,
                      id
           ) as rn
    from base
    order by rn
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total',  (select count(*) from base),
    'limit',  v_limit,
    'offset', v_offset,
    -- Ordered inside the aggregate, and joined back to `events` for a real
    -- composite. jsonb_agg makes no promise about a subquery's row order, and
    -- a timeline whose order drifts is worse than no timeline.
    'events', coalesce((
      select jsonb_agg(public.ledger_event_json(e, false) order by p.rn)
      from page p
      join public.events e on e.id = p.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- get_event(event_id)
create or replace function public.ledger_get_event(p_event_id uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_event public.events%rowtype;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then return null; end if;
  if not public.ledger_can_act_as(v_event.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return public.ledger_event_json(v_event, true);
end;
$$;

-- create_event(event)
--
-- The manual and Hermes write path. Everything a connector gets — dedupe,
-- entity resolution, provenance — applies here too, so an event typed by hand
-- and the order email that arrives an hour later still collapse into one row.
create or replace function public.ledger_create_event(
  p_event       jsonb,
  p_entities    jsonb   default '[]'::jsonb,
  p_source_type text    default 'manual',
  p_allow_merge boolean default true,
  p_user_id     uuid    default null
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_uid     uuid := coalesce(p_user_id, auth.uid());
  v_payload jsonb;
  v_result  jsonb;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_payload := jsonb_build_object(
    'event', (p_event - 'dedupe_key')
             || jsonb_build_object(
                  'source_type', p_source_type,
                  'status',      coalesce(nullif(p_event ->> 'status', ''), 'confirmed'))
             || case when p_allow_merge and (p_event ? 'dedupe_key')
                     then jsonb_build_object('dedupe_key', p_event ->> 'dedupe_key')
                     else '{}'::jsonb end,
    'source', jsonb_build_object(
      'source_type',      p_source_type,
      'external_id',      coalesce(nullif(p_event ->> 'external_id', ''), gen_random_uuid()::text),
      'source_timestamp', now(),
      'metadata',         jsonb_build_object('entered_by', public.ledger_actor())),
    'entities', coalesce(p_entities, '[]'::jsonb),
    'extracted_by', 'user:' || p_source_type
  );

  -- Without match keys the fuzzy pass cannot fire, which is how "no, this
  -- really is a separate event" is expressed.
  if p_allow_merge then
    v_payload := v_payload || jsonb_build_object('match', jsonb_build_object(
      'amount', p_event -> 'data' -> 'amount',
      'name',   coalesce(p_event -> 'data' ->> 'merchant',
                         p_event -> 'data' ->> 'restaurant',
                         p_event -> 'data' ->> 'provider')));
  end if;

  v_result := public.ledger_ingest_event(v_uid, v_payload);
  return v_result || jsonb_build_object('event', public.ledger_get_event((v_result ->> 'event_id')::uuid));
end;
$$;

-- update_event(event_id, changes)
--
-- A correction from a person, so unlike ingestion it *does* overwrite facts —
-- and the audit trigger keeps the previous values.
create or replace function public.ledger_update_event(
  p_event_id     uuid,
  p_changes      jsonb,
  p_replace_data boolean default false
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_event public.events%rowtype;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'event % not found', p_event_id using errcode = 'P0002'; end if;
  if not public.ledger_can_act_as(v_event.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.events e set
    occurred_at     = coalesce(nullif(p_changes ->> 'occurred_at', '')::timestamptz, e.occurred_at),
    occurred_at_end = case when p_changes ? 'occurred_at_end'
                           then nullif(p_changes ->> 'occurred_at_end', '')::timestamptz
                           else e.occurred_at_end end,
    type            = coalesce(nullif(p_changes ->> 'type', ''), e.type),
    subtype         = case when p_changes ? 'subtype' then nullif(p_changes ->> 'subtype', '') else e.subtype end,
    title           = coalesce(left(nullif(p_changes ->> 'title', ''), 300), e.title),
    description     = case when p_changes ? 'description' then nullif(p_changes ->> 'description', '') else e.description end,
    data            = case when p_changes ? 'data'
                           then case when p_replace_data then p_changes -> 'data' else e.data || (p_changes -> 'data') end
                           else e.data end,
    inference       = case when p_changes ? 'inference' then e.inference || (p_changes -> 'inference') else e.inference end,
    status          = coalesce(nullif(p_changes ->> 'status', ''), e.status),
    confidence      = case when p_changes ? 'confidence' then public.ledger_num(p_changes, 'confidence') else e.confidence end
  where e.id = p_event_id;

  return public.ledger_get_event(p_event_id);
end;
$$;

-- delete_or_dismiss_event(event_id)
--
-- Dismissing is the reversible, auditable, provenance-preserving option and is
-- what the review queue uses. Deleting is for "this should never have been
-- recorded at all" and can take the source rows with it.
create or replace function public.ledger_dismiss_event(p_event_id uuid, p_reason text default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  return public.ledger_update_event(p_event_id, jsonb_build_object(
    'status', 'dismissed',
    'inference', jsonb_build_object('dismissed_reason', coalesce(p_reason, 'dismissed by user'),
                                    'dismissed_at', now())));
end;
$$;

create or replace function public.ledger_delete_event(p_event_id uuid, p_purge_sources boolean default false)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_event   public.events%rowtype;
  v_sources uuid[];
  v_purged  integer := 0;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then return jsonb_build_object('deleted', false, 'reason', 'not found'); end if;
  if not public.ledger_can_act_as(v_event.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select array_agg(source_id) into v_sources from public.event_sources where event_id = p_event_id;

  delete from public.events where id = p_event_id;

  -- Only sources nothing else points at. A shared order email that also fed a
  -- delivery event has to survive.
  if p_purge_sources and v_sources is not null then
    with orphaned as (
      delete from public.sources s
       where s.id = any (v_sources)
         and s.user_id = v_event.user_id
         and not exists (select 1 from public.event_sources es where es.source_id = s.id)
      returning 1
    )
    select count(*) into v_purged from orphaned;
  end if;

  return jsonb_build_object('deleted', true, 'event_id', p_event_id, 'sources_purged', v_purged);
end;
$$;

-- Fold `p_duplicate` into `p_target`: all evidence moves, the target's facts
-- win, the duplicate row goes. This is the "merge" button in the review queue.
create or replace function public.ledger_merge_events(p_target uuid, p_duplicate uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_target public.events%rowtype;
  v_dup    public.events%rowtype;
begin
  if p_target = p_duplicate then raise exception 'cannot merge an event into itself'; end if;

  select * into v_target from public.events where id = p_target;
  if not found then raise exception 'target event % not found', p_target using errcode = 'P0002'; end if;
  select * into v_dup from public.events where id = p_duplicate;
  if not found then raise exception 'duplicate event % not found', p_duplicate using errcode = 'P0002'; end if;

  if not public.ledger_can_act_as(v_target.user_id) or v_target.user_id <> v_dup.user_id then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.event_sources es set event_id = p_target, role = 'corroborating'
   where es.event_id = p_duplicate
     and not exists (select 1 from public.event_sources t
                     where t.event_id = p_target and t.source_id = es.source_id);
  delete from public.event_sources where event_id = p_duplicate;

  -- Identifiers move too, or a later source carrying the absorbed event's
  -- order number would create it all over again.
  update public.event_keys k set event_id = p_target
   where k.event_id = p_duplicate
     and not exists (select 1 from public.event_keys t
                     where t.user_id = k.user_id and t.key = k.key and t.event_id = p_target);
  delete from public.event_keys where event_id = p_duplicate;

  update public.event_entities ee set event_id = p_target
   where ee.event_id = p_duplicate
     and not exists (select 1 from public.event_entities t
                     where t.event_id = p_target and t.entity_id = ee.entity_id
                       and t.relationship = ee.relationship);
  delete from public.event_entities where event_id = p_duplicate;

  update public.event_relations set event_id = p_target
   where event_id = p_duplicate and related_event_id <> p_target;
  update public.event_relations set related_event_id = p_target
   where related_event_id = p_duplicate and event_id <> p_target;
  delete from public.event_relations where event_id = p_duplicate or related_event_id = p_duplicate;

  update public.events e set
    data        = e.data || (v_dup.data - array(select jsonb_object_keys(e.data))),
    inference   = e.inference || v_dup.inference,
    description = coalesce(e.description, v_dup.description),
    subtype     = coalesce(e.subtype, v_dup.subtype),
    confidence  = greatest(coalesce(e.confidence, 0), coalesce(v_dup.confidence, 0)),
    occurred_at_end = coalesce(e.occurred_at_end, v_dup.occurred_at_end)
  where e.id = p_target;

  perform public.ledger_log(v_target.user_id, 'events_merged', 'events', p_target,
    jsonb_build_object('absorbed', to_jsonb(v_dup) - 'search_tsv'), jsonb_build_object('target', p_target));

  delete from public.events where id = p_duplicate;

  return public.ledger_get_event(p_target);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Review queue and merge candidates
-- ────────────────────────────────────────────────────────────

create or replace function public.ledger_review_queue(p_limit integer default 50, p_user_id uuid default null)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  return public.ledger_search_events(
    p_statuses => array['needs_review','inferred'],
    p_limit    => p_limit,
    p_user_id  => v_uid);
end;
$$;

-- "Is this the same thing as one of those?" — powers the merge picker.
create or replace function public.ledger_duplicate_candidates(p_event_id uuid, p_limit integer default 5)
returns jsonb language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare
  v_event  public.events%rowtype;
  v_window integer;
  v_name   text;
  v_result jsonb;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then return '[]'::jsonb; end if;
  if not public.ledger_can_act_as(v_event.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_window := public.ledger_setting(v_event.user_id, 'ledger_dedupe_window_minutes', 180)::int * 4;
  v_name   := public.ledger_normalize_name(coalesce(v_event.data ->> 'merchant', v_event.data ->> 'restaurant',
                                                    v_event.data ->> 'provider', v_event.title));

  select coalesce(jsonb_agg(x order by x -> 'similarity' desc), '[]'::jsonb) into v_result
  from (
    select public.ledger_event_json(e, false) || jsonb_build_object(
             'similarity', round(coalesce(extensions.similarity(
               public.ledger_normalize_name(coalesce(e.data ->> 'merchant', e.data ->> 'restaurant',
                                                     e.data ->> 'provider', e.title)), v_name), 0)::numeric, 3),
             'minutes_apart', round(abs(extract(epoch from (e.occurred_at - v_event.occurred_at)) / 60)::numeric, 1)
           ) as x
    from public.events e
    where e.user_id = v_event.user_id
      and e.id <> p_event_id
      and e.status <> 'dismissed'
      and e.occurred_at between v_event.occurred_at - make_interval(mins => v_window)
                            and v_event.occurred_at + make_interval(mins => v_window)
    order by abs(extract(epoch from (e.occurred_at - v_event.occurred_at)))
    limit p_limit
  ) c;

  return v_result;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Entities
-- ────────────────────────────────────────────────────────────

create or replace function public.ledger_get_entity(p_entity_id uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_entity public.entities%rowtype;
begin
  select * into v_entity from public.entities where id = p_entity_id;
  if not found then return null; end if;
  if not public.ledger_can_act_as(v_entity.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_entity.id, 'type', v_entity.type, 'name', v_entity.name,
    'normalized_name', v_entity.normalized_name, 'metadata', v_entity.metadata,
    'created_at', v_entity.created_at,
    'event_count',  (select count(*) from public.event_entities where entity_id = p_entity_id),
    'first_seen_at',(select min(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id where ee.entity_id = p_entity_id),
    'last_seen_at', (select max(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id where ee.entity_id = p_entity_id),
    'total_amount', (select sum(public.ledger_num(e.data, 'amount')) from public.event_entities ee join public.events e on e.id = ee.event_id
                      where ee.entity_id = p_entity_id and e.status <> 'dismissed')
  );
end;
$$;

create or replace function public.ledger_search_entities(
  p_query text default null, p_type text default null,
  p_limit integer default 25, p_user_id uuid default null
) returns jsonb
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'type', x.type, 'name', x.name, 'normalized_name', x.normalized_name,
             'event_count', x.event_count, 'last_seen_at', x.last_seen_at) order by x.event_count desc)
    from (
      select en.*,
             (select count(*) from public.event_entities ee where ee.entity_id = en.id) as event_count,
             (select max(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id
               where ee.entity_id = en.id) as last_seen_at
      from public.entities en
      where en.user_id = v_uid
        and (p_type is null or en.type = p_type)
        and (p_query is null or p_query = ''
             or en.normalized_name like '%' || public.ledger_normalize_name(p_query) || '%'
             or extensions.similarity(en.normalized_name, public.ledger_normalize_name(p_query)) >= 0.4)
      limit greatest(p_limit, 1)
    ) x
  ), '[]'::jsonb);
end;
$$;

-- search_entity_events(entity_id, date_range) — "what have I bought from
-- Amazon", "when was I last in Hyderabad", "meetings with this person".
create or replace function public.ledger_search_entity_events(
  p_entity_id uuid,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_limit     integer     default 100
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_entity public.entities%rowtype;
begin
  select * into v_entity from public.entities where id = p_entity_id;
  if not found then return jsonb_build_object('total', 0, 'events', '[]'::jsonb); end if;

  return public.ledger_search_events(
    p_entity_id => p_entity_id, p_from => p_from, p_to => p_to,
    p_limit => p_limit, p_user_id => v_entity.user_id);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Summaries
--
-- Reads return the stored summary *and* the live event count, so a summary
-- that has gone stale (events ingested after it was written) is visible as
-- stale rather than quietly wrong.
-- ────────────────────────────────────────────────────────────

create or replace function public.ledger_get_daily_summary(p_date date, p_user_id uuid default null)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid   uuid := coalesce(p_user_id, auth.uid());
  v_row   public.daily_summaries%rowtype;
  v_range tstzrange;
  v_live  integer;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_range := public.ledger_day_range(v_uid, p_date);
  select count(*) into v_live from public.events
   where user_id = v_uid and occurred_at <@ v_range and status <> 'dismissed';

  select * into v_row from public.daily_summaries where user_id = v_uid and date = p_date;

  return jsonb_build_object(
    'date', p_date,
    'summary', v_row.summary,
    'sections', coalesce(v_row.sections, '{}'::jsonb),
    'event_count', coalesce(v_row.event_count, 0),
    'live_event_count', v_live,
    'stale', coalesce(v_row.event_count, -1) <> v_live,
    'generated_by', v_row.generated_by,
    'generated_at', v_row.generated_at,
    'metadata', coalesce(v_row.metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.ledger_upsert_daily_summary(
  p_date date, p_summary text, p_sections jsonb default '{}'::jsonb,
  p_generated_by text default 'system', p_metadata jsonb default '{}'::jsonb,
  p_user_id uuid default null
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_uid   uuid := coalesce(p_user_id, auth.uid());
  v_range tstzrange;
  v_count integer;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_range := public.ledger_day_range(v_uid, p_date);
  select count(*) into v_count from public.events
   where user_id = v_uid and occurred_at <@ v_range and status <> 'dismissed';

  insert into public.daily_summaries (user_id, date, summary, sections, event_count, generated_by, generated_at, metadata)
  values (v_uid, p_date, p_summary, coalesce(p_sections, '{}'::jsonb), v_count, p_generated_by, now(), coalesce(p_metadata, '{}'::jsonb))
  on conflict (user_id, date) do update
    set summary = excluded.summary, sections = excluded.sections, event_count = excluded.event_count,
        generated_by = excluded.generated_by, generated_at = excluded.generated_at, metadata = excluded.metadata;

  return public.ledger_get_daily_summary(p_date, v_uid);
end;
$$;

-- get_period_summary(start_date, end_date) — returns the stored weekly/monthly
-- retrospective when one exists, and always returns live aggregates, so Hermes
-- can answer about a period nothing has summarised yet.
create or replace function public.ledger_get_period_summary(
  p_start date, p_end date, p_period_type text default 'week', p_user_id uuid default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_row public.period_summaries%rowtype;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_row from public.period_summaries
   where user_id = v_uid and period_type = p_period_type and start_date = p_start;

  return jsonb_build_object(
    'period_type', p_period_type, 'start_date', p_start, 'end_date', p_end,
    'summary', v_row.summary, 'sections', coalesce(v_row.sections, '{}'::jsonb),
    'generated_by', v_row.generated_by, 'generated_at', v_row.generated_at,
    'stats', public.ledger_stats(
               lower(public.ledger_day_range(v_uid, p_start)),
               upper(public.ledger_day_range(v_uid, p_end)),
               v_uid),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.date, 'summary', d.summary, 'event_count', d.event_count) order by d.date)
      from public.daily_summaries d
      where d.user_id = v_uid and d.date between p_start and p_end), '[]'::jsonb)
  );
end;
$$;

create or replace function public.ledger_upsert_period_summary(
  p_period_type text, p_start date, p_end date, p_summary text,
  p_sections jsonb default '{}'::jsonb, p_generated_by text default 'system',
  p_metadata jsonb default '{}'::jsonb, p_user_id uuid default null
) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_uid   uuid := coalesce(p_user_id, auth.uid());
  v_count integer;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select count(*) into v_count from public.events
   where user_id = v_uid and status <> 'dismissed'
     and occurred_at >= lower(public.ledger_day_range(v_uid, p_start))
     and occurred_at <  upper(public.ledger_day_range(v_uid, p_end));

  insert into public.period_summaries (user_id, period_type, start_date, end_date, summary, sections,
                                       event_count, generated_by, generated_at, metadata)
  values (v_uid, p_period_type, p_start, p_end, p_summary, coalesce(p_sections, '{}'::jsonb),
          v_count, p_generated_by, now(), coalesce(p_metadata, '{}'::jsonb))
  on conflict (user_id, period_type, start_date) do update
    set end_date = excluded.end_date, summary = excluded.summary, sections = excluded.sections,
        event_count = excluded.event_count, generated_by = excluded.generated_by,
        generated_at = excluded.generated_at, metadata = excluded.metadata;

  return public.ledger_get_period_summary(p_start, p_end, p_period_type, v_uid);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- ledger_stats — aggregates computed from events, never stored
--
-- This is what "what did I spend on food this month", "how many times did I
-- eat out", "compare this month with last" resolve to. Deriving them live is
-- the point: a stored number is a number that can go stale.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_stats(
  p_from timestamptz default null,
  p_to   timestamptz default null,
  p_user_id uuid default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid    uuid := coalesce(p_user_id, auth.uid());
  v_result jsonb;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  with base as (
    select e.*,
           public.ledger_num(e.data, 'amount') as amount,
           -- Refunds, salary credits and card bill payments carry an amount but
           -- are not spending. Summing them would inflate every total, so the
           -- direction is decided once, here, rather than at each call site.
           case when e.type = 'transfer' or e.data ->> 'direction' = 'credit'
                then null else public.ledger_num(e.data, 'amount') end as spend_amount,
           case when e.type = 'transfer' or e.data ->> 'direction' = 'credit'
                then public.ledger_num(e.data, 'amount') else null end as inflow_amount
    from public.events e
    where e.user_id = v_uid
      and e.status <> 'dismissed'
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <  p_to)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'event_count',   (select count(*) from base),
    'first_event_at',(select min(occurred_at) from base),
    'last_event_at', (select max(occurred_at) from base),
    'active_days',   (select count(distinct (occurred_at at time zone public.ledger_setting_text(v_uid, 'ledger_timezone', 'Asia/Kolkata'))::date) from base),
    'by_type',       (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)   from (select type, count(*) n from base group by type) t),
    'by_subtype',    (select coalesce(jsonb_object_agg(subtype, n), '{}'::jsonb) from (select subtype, count(*) n from base where subtype is not null group by subtype) t),
    'by_status',     (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from base group by status) t),
    'by_source',     (select coalesce(jsonb_object_agg(source_type, n), '{}'::jsonb) from (select source_type, count(*) n from base group by source_type) t),
    'spend', jsonb_build_object(
      'total',       (select coalesce(sum(spend_amount), 0) from base where spend_amount is not null),
      'by_type',     (select coalesce(jsonb_object_agg(type, total), '{}'::jsonb)
                      from (select type, sum(spend_amount) total from base where spend_amount is not null group by type) t),
      'by_category', (select coalesce(jsonb_object_agg(category, total), '{}'::jsonb)
                      from (select coalesce(data ->> 'category', subtype, 'uncategorised') category, sum(spend_amount) total
                            from base where spend_amount is not null group by 1) t),
      'transactions',(select count(*) from base where spend_amount is not null)
    ),
    'inflow', jsonb_build_object(
      'total',        (select coalesce(sum(inflow_amount), 0) from base where inflow_amount is not null),
      'transactions', (select count(*) from base where inflow_amount is not null)
    ),
    'top_entities', coalesce((
      select jsonb_agg(x order by x -> 'count' desc)
      from (
        select jsonb_build_object('id', en.id, 'name', en.name, 'type', en.type,
                                  'count', count(*),
                                  -- An issuer is on the transaction, not on the
                                  -- receiving end of it. Attributing the amount
                                  -- to the card's bank makes it the largest
                                  -- merchant in the ledger.
                                  'amount', coalesce(sum(b.spend_amount)
                                    filter (where ee.relationship <> 'issuer'), 0)) as x
        from base b
        join public.event_entities ee on ee.event_id = b.id
        join public.entities en on en.id = ee.entity_id
        group by en.id, en.name, en.type
        order by count(*) desc
        limit 15
      ) t), '[]'::jsonb),
    'needs_review', (select count(*) from public.events
                      where user_id = v_uid and status in ('needs_review','inferred')
                        and (p_from is null or occurred_at >= p_from)
                        and (p_to   is null or occurred_at <  p_to))
  ) into v_result;

  return v_result;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Export and retention
--
-- "Make the data exportable" and "ability to delete events and their
-- source-derived data" are product requirements, so they are functions, not
-- something to reconstruct with ad-hoc SQL when it is needed.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_export(
  p_from timestamptz default null, p_to timestamptz default null, p_user_id uuid default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'events', coalesce((
      select jsonb_agg(public.ledger_event_json(e, true) order by e.occurred_at)
      from public.events e
      where e.user_id = v_uid
        and (p_from is null or e.occurred_at >= p_from)
        and (p_to   is null or e.occurred_at <  p_to)), '[]'::jsonb),
    'entities', coalesce((
      select jsonb_agg(to_jsonb(en) order by en.name) from public.entities en where en.user_id = v_uid), '[]'::jsonb),
    'daily_summaries', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.date) from public.daily_summaries d where d.user_id = v_uid), '[]'::jsonb),
    'period_summaries', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.start_date) from public.period_summaries p where p.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- Drop the cached body text from old sources but keep the pointer. Provenance
-- survives — the message id and URL still resolve to the original — while the
-- copy of your mail that this database holds stays as small as possible.
create or replace function public.ledger_purge_snippets(p_days integer default null, p_user_id uuid default null)
returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_uid  uuid := coalesce(p_user_id, auth.uid());
  v_days integer;
  v_n    integer;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_days := coalesce(p_days, public.ledger_setting(v_uid, 'ledger_snippet_retention_days', 90)::int);

  with cleaned as (
    update public.sources
       set metadata = metadata - 'snippet' - 'body_preview' - 'headers'
     where user_id = v_uid
       and created_at < now() - make_interval(days => v_days)
       and (metadata ? 'snippet' or metadata ? 'body_preview' or metadata ? 'headers')
    returning 1
  )
  select count(*) into v_n from cleaned;

  return v_n;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- ledger_fingerprint_stats — the cost control's memory
--
-- Groups every source we have read by its sender/subject-shape fingerprint and
-- counts how often that shape produced an event. A shape seen repeatedly that
-- has never yielded one is not worth another model call. Only ever suppresses
-- negatives, so it cannot hide an event the deterministic rules would catch.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_fingerprint_stats(
  p_days integer default 90, p_user_id uuid default null
) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_object_agg(t.fp, jsonb_build_object('seen', t.seen, 'events', t.events))
    from (
      select s.metadata ->> 'fingerprint' as fp,
             count(*)                     as seen,
             count(distinct es.event_id)  as events
      from public.sources s
      left join public.event_sources es on es.source_id = s.id
      where s.user_id = v_uid
        and s.source_type = 'email'
        and s.created_at > now() - make_interval(days => greatest(coalesce(p_days, 90), 1))
        and s.metadata ? 'fingerprint'
      group by 1
      -- A shape seen once tells us nothing; leaving those out keeps the
      -- payload the job downloads each run small.
      having count(*) >= 2
    ) t
  ), '{}'::jsonb);
end;
$$;

-- ============================================================
-- Function grants
--
-- `anon` gets nothing. Everything else is reachable by a signed-in session
-- (RLS still applies inside) and by the service role the jobs use.
-- ============================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'ledger\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end;
$$;
