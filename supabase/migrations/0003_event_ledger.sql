-- ============================================================
-- Personal Event Ledger — core schema
--
-- A structured, searchable record of things that happened, populated mostly by
-- automated ingestion. The database is the product: it has to stay useful with
-- the UI unopened, with Hermes removed, and with any single source broken.
--
-- Three rules the schema itself enforces:
--
--   1. Provenance is never lost. Every automatically created event points at
--      the source row it came from, and `event_sources` keeps *every* piece of
--      evidence when several sources describe the same real-world event.
--   2. Facts and interpretation live in different columns. `events.data` holds
--      what a source actually said; `events.inference` holds what an LLM thinks
--      it means. Merge logic below never lets the second overwrite the first.
--   3. Ingestion is idempotent. `sources (user_id, source_type, external_id)`
--      and `events (user_id, dedupe_key)` are both unique, so replaying a run
--      updates rows instead of multiplying them.
--
-- Run order: after 0002_harden_rls.sql. Companion: 0004_ledger_api.sql, which
-- carries the ingestion/query functions Hermes and the jobs call.
-- ============================================================

-- pg_trgm powers fuzzy entity matching and the ILIKE fallback in search.
-- Supabase keeps extensions in their own schema; every function below sets an
-- explicit search_path that includes it.
create extension if not exists pg_trgm with schema extensions;


-- ────────────────────────────────────────────────────────────
-- Event type catalogue
--
-- Deliberately a table, not an enum. Adding a type must never require a
-- migration, and an unknown type must never make an ingestion run fail — a
-- trigger on `events` registers anything new it sees. The catalogue exists so
-- the UI can enumerate and label types, not to gate writes.
-- ────────────────────────────────────────────────────────────
create table if not exists public.ledger_event_types (
  type       text primary key check (type ~ '^[a-z][a-z0-9_]{1,31}$'),
  label      text        not null,
  icon       text        not null default 'fa-circle-dot',
  is_builtin boolean     not null default false,
  created_at timestamptz not null default now()
);

insert into public.ledger_event_types (type, label, icon, is_builtin) values
  ('activity',      'Activity',      'fa-person-walking',      true),
  ('purchase',      'Purchase',      'fa-bag-shopping',        true),
  ('food',          'Food',          'fa-utensils',            true),
  ('travel',        'Travel',        'fa-plane',               true),
  ('work',          'Work',          'fa-briefcase',           true),
  ('meeting',       'Meeting',       'fa-users',               true),
  ('communication', 'Communication', 'fa-comments',            true),
  ('health',        'Health',        'fa-heart-pulse',         true),
  ('entertainment', 'Entertainment', 'fa-film',                true),
  ('subscription',  'Subscription',  'fa-arrows-rotate',       true),
  ('delivery',      'Delivery',      'fa-truck',               true),
  ('appointment',   'Appointment',   'fa-calendar-check',      true),
  ('note',          'Note',          'fa-note-sticky',         true),
  ('task',          'Task',          'fa-circle-check',        true),
  ('milestone',     'Milestone',     'fa-flag',                true),
  ('location',      'Location',      'fa-location-dot',        true),
  ('other',         'Other',         'fa-circle-dot',          true)
on conflict (type) do update
  set label = excluded.label, icon = excluded.icon, is_builtin = true;


-- ────────────────────────────────────────────────────────────
-- sources — where an event came from
--
-- Stores a *pointer*, not a copy. `raw_reference` carries just enough to find
-- the original again (mailbox, folder, UID, RFC822 message-id) and `metadata`
-- carries the handful of headers worth keeping for debugging. Full email
-- bodies are never written here; see ledger_purge_snippets() in 0004.
-- ────────────────────────────────────────────────────────────
create table if not exists public.sources (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  source_type      text        not null check (source_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- Provider-unique and stable: Gmail/Zoho message-id, calendar UID, Hermes
  -- message id, or a generated id for manual entries. The uniqueness of
  -- (user, type, external_id) is what makes re-running ingestion free.
  external_id      text        not null check (char_length(external_id) between 1 and 512),
  external_url     text,
  source_timestamp timestamptz,
  raw_reference    jsonb,
  metadata         jsonb       not null default '{}'::jsonb,
  -- Which mailbox/account this came from, so one broken or removed account can
  -- be purged without touching the rest of the ledger.
  account_key      text,
  created_at       timestamptz not null default now(),
  unique (user_id, source_type, external_id)
);

create index if not exists sources_user_type_time_idx
  on public.sources (user_id, source_type, source_timestamp desc nulls last);
create index if not exists sources_account_idx
  on public.sources (user_id, account_key) where account_key is not null;


-- ────────────────────────────────────────────────────────────
-- events — the ledger itself
--
-- `data`      facts, as stated by a source. Merge logic never overwrites a key
--             that is already present; a disagreeing source is recorded as a
--             conflict in the audit log instead.
-- `inference` LLM interpretation ("probably an electronics purchase"). Free to
--             be rewritten, never promoted into `data`.
-- `source_id` the originating source, per spec. Everything that corroborates
--             the event afterwards lands in `event_sources`.
-- ────────────────────────────────────────────────────────────
create table if not exists public.events (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  occurred_at     timestamptz not null,
  occurred_at_end timestamptz,
  type            text        not null check (type ~ '^[a-z][a-z0-9_]{1,31}$'),
  subtype         text                 check (subtype ~ '^[a-z][a-z0-9_]{1,47}$'),
  title           text        not null check (char_length(title) between 1 and 300),
  description     text,
  data            jsonb       not null default '{}'::jsonb,
  inference       jsonb       not null default '{}'::jsonb,
  source_id       uuid        references public.sources (id) on delete set null,
  source_type     text        not null check (source_type ~ '^[a-z][a-z0-9_]{1,31}$'),
  confidence      numeric(4,3)         check (confidence >= 0 and confidence <= 1),
  status          text        not null default 'confirmed'
                    check (status in ('confirmed','inferred','scheduled','needs_review','dismissed')),
  -- Deterministic identity, when the source gave us one: order id, booking
  -- reference, transaction id, calendar UID. Namespaced by kind so an order id
  -- and a booking reference can never collide. Null when only fuzzy matching
  -- is possible.
  dedupe_key      text,
  search_tsv      tsvector,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint events_end_after_start check (occurred_at_end is null or occurred_at_end >= occurred_at)
);

-- The single most important index in this file: it is what makes replaying an
-- ingestion run an upsert rather than a duplicate.
create unique index if not exists events_dedupe_key_uidx
  on public.events (user_id, dedupe_key) where dedupe_key is not null;

create index if not exists events_user_time_idx        on public.events (user_id, occurred_at desc);
create index if not exists events_user_type_time_idx   on public.events (user_id, type, occurred_at desc);
create index if not exists events_user_source_time_idx on public.events (user_id, source_type, occurred_at desc);
create index if not exists events_review_idx           on public.events (user_id, occurred_at desc)
  where status in ('needs_review','inferred');
create index if not exists events_search_idx           on public.events using gin (search_tsv);
create index if not exists events_data_idx             on public.events using gin (data jsonb_path_ops);


-- ────────────────────────────────────────────────────────────
-- event_sources — every piece of evidence for an event
--
-- The Amazon order email and the card-transaction alert for the same ₹1,299
-- become one event with two rows here. Dropping either would be losing
-- provenance, which rule 1 forbids.
-- ────────────────────────────────────────────────────────────
create table if not exists public.event_sources (
  event_id     uuid        not null references public.events  (id) on delete cascade,
  source_id    uuid        not null references public.sources (id) on delete cascade,
  user_id      uuid        not null references auth.users     (id) on delete cascade,
  -- 'origin' for the source that created the event, 'corroborating' for one
  -- that later matched it, 'correction' for a source that revised it.
  role         text        not null default 'corroborating'
                 check (role in ('origin','corroborating','correction')),
  -- What this particular source contributed, so a later correction can be
  -- traced back to the evidence that justified it.
  contributed  jsonb       not null default '{}'::jsonb,
  confidence   numeric(4,3)         check (confidence >= 0 and confidence <= 1),
  extracted_by text,
  created_at   timestamptz not null default now(),
  primary key (event_id, source_id)
);

create index if not exists event_sources_source_idx on public.event_sources (source_id);
create index if not exists event_sources_user_idx   on public.event_sources (user_id, created_at desc);


-- ────────────────────────────────────────────────────────────
-- event_keys — every deterministic identifier an event is known by
--
-- One real-world purchase carries several identifiers, one per source: the
-- order number on the confirmation mail, the transaction reference on the card
-- alert, a tracking number on the dispatch mail. `events.dedupe_key` holds the
-- one it was created with; this table holds all of them.
--
-- Without it, the second source's identifier is nowhere, and the third mail —
-- a statement line, a refund — has to fall back to fuzzy matching for an event
-- whose identity was already known exactly.
-- ────────────────────────────────────────────────────────────
create table if not exists public.event_keys (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null check (char_length(key) between 1 and 200),
  event_id   uuid        not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

create index if not exists event_keys_event_idx on public.event_keys (event_id);


-- ────────────────────────────────────────────────────────────
-- entities — recurring real-world things
--
-- `normalized_name` is the join key ("amazon" for "Amazon.in", "AMAZON PAY",
-- "Amazon Seller Services"); `name` keeps the nicest display form seen so far.
-- ────────────────────────────────────────────────────────────
create table if not exists public.entities (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users (id) on delete cascade,
  type            text        not null check (type ~ '^[a-z][a-z0-9_]{1,31}$'),
  name            text        not null check (char_length(name) between 1 and 200),
  normalized_name text        not null check (char_length(normalized_name) between 1 and 200),
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, type, normalized_name)
);

create index if not exists entities_user_type_idx on public.entities (user_id, type);
create index if not exists entities_trgm_idx      on public.entities using gin (normalized_name extensions.gin_trgm_ops);


create table if not exists public.event_entities (
  event_id     uuid        not null references public.events   (id) on delete cascade,
  entity_id    uuid        not null references public.entities (id) on delete cascade,
  user_id      uuid        not null references auth.users      (id) on delete cascade,
  relationship text        not null default 'related'
                 check (relationship ~ '^[a-z][a-z0-9_]{1,31}$'),
  created_at   timestamptz not null default now(),
  primary key (event_id, entity_id, relationship)
);

-- "What have I bought from Amazon?" walks this index.
create index if not exists event_entities_entity_idx on public.event_entities (entity_id, event_id);
create index if not exists event_entities_user_idx   on public.event_entities (user_id);


-- ────────────────────────────────────────────────────────────
-- event_relations — one real-world happening, several ledger rows
--
-- Used when two events are genuinely distinct but connected (a trip and the
-- hotel booking inside it), as opposed to duplicates, which get merged into a
-- single event instead.
-- ────────────────────────────────────────────────────────────
create table if not exists public.event_relations (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  event_id         uuid        not null references public.events (id) on delete cascade,
  related_event_id uuid        not null references public.events (id) on delete cascade,
  relationship     text        not null check (relationship ~ '^[a-z][a-z0-9_]{1,31}$'),
  created_at       timestamptz not null default now(),
  constraint event_relations_distinct check (event_id <> related_event_id),
  unique (event_id, related_event_id, relationship)
);

create index if not exists event_relations_related_idx on public.event_relations (related_event_id);
create index if not exists event_relations_user_idx    on public.event_relations (user_id);


-- ────────────────────────────────────────────────────────────
-- Derived artefacts
--
-- None of these are the source of truth. Every one can be deleted and
-- regenerated from `events` alone — which is exactly what the weekly and
-- monthly jobs do, rather than summarising previous summaries.
-- ────────────────────────────────────────────────────────────
create table if not exists public.daily_summaries (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  date         date        not null,
  summary      text        not null,
  -- The structured form of the same summary (major activities, purchases,
  -- food, travel, work, people, open questions) so the UI does not have to
  -- parse prose.
  sections     jsonb       not null default '{}'::jsonb,
  event_count  integer     not null default 0,
  generated_by text        not null default 'system',
  generated_at timestamptz not null default now(),
  metadata     jsonb       not null default '{}'::jsonb,
  primary key (user_id, date)
);

create table if not exists public.period_summaries (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  period_type  text        not null check (period_type in ('week','month','quarter','year')),
  start_date   date        not null,
  end_date     date        not null,
  summary      text        not null,
  sections     jsonb       not null default '{}'::jsonb,
  event_count  integer     not null default 0,
  generated_by text        not null default 'system',
  generated_at timestamptz not null default now(),
  metadata     jsonb       not null default '{}'::jsonb,
  primary key (user_id, period_type, start_date),
  constraint period_summaries_range check (end_date >= start_date)
);

-- Observations an LLM made *about* the ledger. Kept apart from events on
-- purpose: "you eat out more on Fridays" is not a thing that happened.
create table if not exists public.derived_insights (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  scope        text        not null,
  subject      text,
  insight      text        not null,
  evidence     jsonb       not null default '{}'::jsonb,
  generated_by text        not null default 'llm',
  generated_at timestamptz not null default now(),
  expires_at   timestamptz
);

create index if not exists derived_insights_user_idx on public.derived_insights (user_id, generated_at desc);


-- ────────────────────────────────────────────────────────────
-- Ingestion observability
-- ────────────────────────────────────────────────────────────
create table if not exists public.ingestion_runs (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users (id) on delete cascade,
  source_type    text        not null,
  account_key    text,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  status         text        not null default 'running'
                   check (status in ('running','succeeded','failed','partial')),
  items_seen     integer     not null default 0,
  events_created integer     not null default 0,
  events_updated integer     not null default 0,
  events_skipped integer     not null default 0,
  errors         jsonb       not null default '[]'::jsonb,
  metadata       jsonb       not null default '{}'::jsonb
);

create index if not exists ingestion_runs_user_idx on public.ingestion_runs (user_id, started_at desc);

-- The checkpoint is what keeps ingestion off the whole inbox. `cursor` is
-- connector-shaped: IMAP stores {uidvalidity, uid} per folder, an HTTP API
-- would store a sync token, so the pipeline never needs to know the shape.
create table if not exists public.ingestion_checkpoints (
  user_id       uuid        not null references auth.users (id) on delete cascade,
  source_type   text        not null,
  account_key   text        not null default 'default',
  cursor        jsonb       not null default '{}'::jsonb,
  last_run_at   timestamptz,
  last_success_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (user_id, source_type, account_key)
);


-- ────────────────────────────────────────────────────────────
-- Audit log — append-only
--
-- Writes come from triggers only; there is deliberately no UPDATE or DELETE
-- policy, so with RLS on, nothing a user's JWT can do will rewrite history.
-- ────────────────────────────────────────────────────────────
create table if not exists public.ledger_audit_log (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  actor      text        not null,
  action     text        not null,
  table_name text        not null,
  record_id  uuid,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create index if not exists ledger_audit_log_user_idx on public.ledger_audit_log (user_id, at desc);
create index if not exists ledger_audit_log_rec_idx  on public.ledger_audit_log (record_id);


-- ============================================================
-- Triggers
-- ============================================================

-- Who is doing this? A job sets `ledger.actor` ("job:ingest-email",
-- "hermes"); a browser session has a JWT; anything else is the service role.
create or replace function public.ledger_actor()
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    nullif(current_setting('ledger.actor', true), ''),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''),
    'service_role'
  );
$$;

-- Flatten a jsonb payload to its scalar leaves, so a merchant name buried in
-- data->'merchant' is findable by full-text search without the query layer
-- knowing which keys exist for which event type.
create or replace function public.ledger_jsonb_text(p_data jsonb)
returns text language sql immutable set search_path = public, pg_temp as $$
  select coalesce(string_agg(t.txt, ' '), '')
  from (
    select case jsonb_typeof(v)
             when 'string' then v #>> '{}'
             when 'number' then v #>> '{}'
             else null
           end as txt
    from jsonb_path_query(coalesce(p_data, '{}'::jsonb), '$.**') as v
  ) t
  where t.txt is not null;
$$;

-- One BEFORE trigger does both jobs that must happen on every write: keep the
-- search vector current, and make sure the type catalogue knows about any type
-- this event introduces. SECURITY DEFINER because the catalogue is shared and
-- users have no write grant on it — an unknown type must never fail a write.
create or replace function public.ledger_events_before_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('simple', public.ledger_jsonb_text(new.data)), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.type, '') || ' ' || coalesce(new.subtype, '')), 'D');

  if not exists (select 1 from public.ledger_event_types where type = new.type) then
    insert into public.ledger_event_types (type, label, icon, is_builtin)
    values (new.type, initcap(replace(new.type, '_', ' ')), 'fa-circle-dot', false)
    on conflict (type) do nothing;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_before_write on public.events;
create trigger events_before_write
  before insert or update on public.events
  for each row execute function public.ledger_events_before_write();

drop trigger if exists entities_touch on public.entities;
create trigger entities_touch
  before update on public.entities
  for each row execute function public.touch_updated_at();

-- Audit only what matters: deletions, dismissals, and edits to the facts. A
-- confidence bump from corroboration is logged by the merge function itself,
-- with the evidence attached — logging it here too would be noise.
create or replace function public.ledger_audit_events()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_action text;
begin
  if tg_op = 'DELETE' then
    insert into public.ledger_audit_log (user_id, actor, action, table_name, record_id, before)
    values (old.user_id, public.ledger_actor(), 'event_deleted', 'events', old.id, to_jsonb(old) - 'search_tsv');
    return old;
  end if;

  if new.status is distinct from old.status then
    v_action := case when new.status = 'dismissed' then 'event_dismissed' else 'event_status_changed' end;
  elsif new.data          is distinct from old.data
     or new.title         is distinct from old.title
     or new.occurred_at   is distinct from old.occurred_at
     or new.type          is distinct from old.type
     or new.subtype       is distinct from old.subtype then
    v_action := 'event_edited';
  else
    return new;
  end if;

  insert into public.ledger_audit_log (user_id, actor, action, table_name, record_id, before, after)
  values (
    new.user_id, public.ledger_actor(), v_action, 'events', new.id,
    jsonb_build_object('status', old.status, 'title', old.title, 'occurred_at', old.occurred_at,
                       'type', old.type, 'subtype', old.subtype, 'data', old.data),
    jsonb_build_object('status', new.status, 'title', new.title, 'occurred_at', new.occurred_at,
                       'type', new.type, 'subtype', new.subtype, 'data', new.data)
  );
  return new;
end;
$$;

drop trigger if exists events_audit on public.events;
create trigger events_audit
  after update or delete on public.events
  for each row execute function public.ledger_audit_events();

-- Deleting a source destroys provenance, so it is always worth a record.
create or replace function public.ledger_audit_sources()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.ledger_audit_log (user_id, actor, action, table_name, record_id, before)
  values (old.user_id, public.ledger_actor(), 'source_deleted', 'sources', old.id, to_jsonb(old));
  return old;
end;
$$;

drop trigger if exists sources_audit on public.sources;
create trigger sources_audit
  after delete on public.sources
  for each row execute function public.ledger_audit_sources();


-- ============================================================
-- Row level security
--
-- Same shape as the audited policies on the finance tables: one FOR ALL policy
-- with both clauses set. USING covers SELECT/DELETE and which rows an UPDATE
-- may touch; WITH CHECK covers INSERT and what an UPDATE may write. Per-command
-- policies on top would be pure redundancy — permissive policies OR together.
--
-- Re-audit with supabase/checks/rls_audit.sql after any change here.
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'sources','events','event_sources','event_keys','entities','event_entities','event_relations',
    'daily_summaries','period_summaries','derived_insights',
    'ingestion_runs','ingestion_checkpoints','ledger_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
  end loop;
end;
$$;

create policy sources_owner              on public.sources              for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy events_owner               on public.events               for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy event_sources_owner        on public.event_sources        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy event_keys_owner          on public.event_keys           for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy entities_owner             on public.entities             for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy event_entities_owner       on public.event_entities       for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy event_relations_owner      on public.event_relations      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy daily_summaries_owner      on public.daily_summaries      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy period_summaries_owner     on public.period_summaries     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy derived_insights_owner     on public.derived_insights     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy ingestion_runs_owner       on public.ingestion_runs       for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy ingestion_checkpoints_owner on public.ingestion_checkpoints for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Append-only: readable by its owner, writable only by the SECURITY DEFINER
-- triggers above. No INSERT/UPDATE/DELETE policy exists, so with RLS on, a
-- user's JWT cannot rewrite or erase its own audit trail.
create policy ledger_audit_log_owner on public.ledger_audit_log for select using (auth.uid() = user_id);

alter table public.ledger_event_types enable row level security;
drop policy if exists ledger_event_types_read on public.ledger_event_types;
create policy ledger_event_types_read on public.ledger_event_types for select using (true);


-- ============================================================
-- Grants
--
-- Supabase's default privileges hand `anon` the same grants as `authenticated`
-- on every new table in public. RLS already makes that harmless, but this data
-- is sensitive enough to want the grant gone as well.
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'sources','events','event_sources','event_keys','entities','event_entities','event_relations',
    'daily_summaries','period_summaries','derived_insights',
    'ingestion_runs','ingestion_checkpoints','ledger_audit_log'
  ] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- The audit trail is readable, never writable, from a user session.
revoke insert, update, delete on public.ledger_audit_log from authenticated;

revoke all    on public.ledger_event_types from anon;
grant  select on public.ledger_event_types to authenticated;
grant  all    on public.ledger_event_types to service_role;
