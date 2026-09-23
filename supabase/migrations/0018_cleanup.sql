-- ============================================================
-- Cleanup: one guard that actually guards, and the dead weight gone
--
-- Ten changes, in the order they run. Everything is guarded, so the file is
-- safe to run again; the data fixes in §6 and §7 are no-ops the second time.
--
-- §1  ledger_can_act_as() — the security fix.
--     The old body tested `current_user`. Inside a SECURITY DEFINER function
--     current_user is the function's OWNER (postgres), so the "am I an admin"
--     branch was true for every caller of every SECURITY DEFINER function, and
--     any authenticated JWT could pass any p_user_id and read or write that
--     user's rows. 0010 noticed this and wrote health.can_read() around it;
--     this file gives ledger_can_act_as() the same three tests:
--
--       auth.uid() = p_user_id                 the signed-in browser, itself
--       JWT claim role = 'service_role'        the jobs, Hermes, the CLI
--                                              (SUPABASE_SERVICE_ROLE_KEY:
--                                              PostgREST puts the key's claims
--                                              in request.jwt.claims)
--       session_user in (postgres,             the SQL editor, `supabase db
--                        supabase_admin)       query --linked`, migrations,
--                                              pg_cron. session_user, unlike
--                                              current_user, is not changed
--                                              by SECURITY DEFINER.
--
--     Signature unchanged; every caller keeps working. Callers were read one
--     by one: all of them are `if not ledger_can_act_as(x) then raise`, none
--     relies on the old behaviour, and the SECURITY INVOKER callers are
--     unaffected in practice (for them current_user was already the API role,
--     so the JWT test replaces a `current_user = 'service_role'` test that
--     meant the same thing).
--
--     SECURITY DEFINER functions that were open and are now correctly gated
--     (each checks ledger_can_act_as() on the user it was handed):
--       0004  ledger_log(uuid, text, text, uuid, jsonb, jsonb)
--       0005  food_upsert_item(uuid, jsonb)
--             food_match_item(text, numeric, integer, uuid)
--             food_pending_items(integer, uuid)
--       0006  food_event_nutrition(timestamptz, timestamptz, integer, uuid)
--             food_coverage(uuid)                    (0005's versions, replaced)
--       0008  food_merge_items(uuid, uuid, uuid)
--     SECURITY DEFINER functions that were already gated correctly and are
--     untouched: every 0010/0011 health_* and life_* function (health.reader →
--     health.can_read), 0009 health_ingest (token hash, service_role only) and
--     health.mint_ingest_token (admin only), and the 0003 trigger functions
--     (fired by RLS-protected writes; they take no user argument).
--
-- §2  anon posture. cc_merchant_rules and cc_ignored_events (0012, 0013) and
--     the cc_points view were granted to authenticated and service_role but
--     never revoked from anon, which Supabase's default privileges hand every
--     new relation in public. Same revoke 0003 and 0005 do. ledger_money_flow
--     and ledger_spend_category (0017) were created after 0004's grant loop
--     ran, so anon and public had EXECUTE on them; same revoke/grant as 0004.
--
-- §3  dead objects, each checked by grep across src/, ledger/, test/, docs/
--     and every migration before dropping:
--       public.derived_insights            0 rows; nothing reads or writes it
--                                          (docs/ledger.md still lists it;
--                                          that file is not edited here)
--       health.daily_totals, sleep_nights  0009's ad hoc views; superseded by
--                                          health.daily_cumulative() and
--                                          health.nights() in 0010
--       public.health_workouts             the browser and Hermes both read
--                                          workouts through life_activity()
--                                          (0011); src/health/api.js still
--                                          exports a wrapper nothing calls
--       public.cc_link_existing            0012's one-off seeding, run once
--       public.cc_learn_rules              (0012, redefined 0014); rules are
--       public.cc_move_descriptions        now written by cc_confirm()
--     A re-run of 0003 will now stop at its grant loop (derived_insights) and
--     a re-run of 0009/0010 would recreate the views and health_workouts;
--     harmless, and noted in those files.
--
-- §4  cc_points loses `source` ('event' | 'typed'). Nothing reads it: the
--     browser's r.source is on cc_merchant_rules rows, and no SQL function
--     selects it. A view cannot drop a column through CREATE OR REPLACE, so
--     the view is dropped and recreated with 0014's other columns, in order.
--     Functions that read the view (finance_card_points, cc_work_spend) do
--     not hold a dependency on it and need no change.
--
-- §5  ledger_purge_snippets() strips only what src/ledger/email.js writes
--     (metadata.snippet; body_preview and headers never existed), and takes
--     on two bits of ingestion_runs hygiene: a run still `running` after six
--     hours is marked failed (the job died; nothing will ever finish it), and
--     succeeded runs that saw nothing are deleted after 30 days. Returns
--     counts as jsonb — the return type changes, so the function is dropped
--     and re-created with the same grants. ledger/cli.js `purge` prints the
--     result with `${data}` and needs to read `.snippets_cleared` instead.
--
-- §6  one-off data fixes: the runs currently stuck in `running` (the §5 rule,
--     applied directly rather than through the function, which needs a user),
--     and the cc_work_label setting, which nothing reads since 0014 replaced
--     finance_card_points() and cc_work_spend(). The delete is guarded on
--     0014's is_work column existing, so its backfill can never be skipped.
--
-- §7  merchant aliases. Entity resolution (ledger_resolve_entity, 0015)
--     matches on normalized_name, then on metadata.aliases, then by trigram;
--     none of "orbgen" ~ "district", "myjio" ~ "jio", "bundl" ~ "swiggy",
--     "tata 1mg healthca" ~ "tata 1mg" is within 0.82, so each bank spelling
--     became its own entity. The JS twin (canonicalMerchant in
--     src/ledger/normalize.js) is gaining the same aliases; this is the SQL
--     side, and it also repairs history. For each user and each of the pairs,
--     per entity type (merchant, company):
--       both entities exist    ledger_merge_entities(canonical, bank): events
--                              move, the bank spelling becomes an alias
--       only canonical exists  ledger_add_entity_aliases(canonical, bank)
--       only the bank one      renamed to the canonical spelling, bank
--                              spelling kept as an alias
--     Both helpers normalise with ledger_normalize_name(), which is also what
--     strips "Technologies" from "Orbgen Technologies" and "Bundl
--     Technologies". cc_merchant_rules is keyed on the event's own
--     data.merchant and is not touched: a rule for "orbgen" keeps applying to
--     events whose merchant the bank wrote as Orbgen.
--
-- §8  supabase/checks/rls_audit.sql now audits every table in public
--     (separate file).
--
-- Run order: after 0017_money_flow.sql. Safe to re-run.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- §1  Who may act as whom
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_can_act_as(p_user_id uuid)
returns boolean language sql stable set search_path = public, extensions, pg_temp as $$
  select p_user_id is not null and (
       auth.uid() = p_user_id
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    -- No JWT at all, connected as an admin: the SQL editor, migrations, pg_cron.
    -- session_user, unlike current_user, is not changed by SECURITY DEFINER.
    or session_user in ('postgres', 'supabase_admin')
  );
$$;


-- ────────────────────────────────────────────────────────────
-- §2  anon gets nothing
-- ────────────────────────────────────────────────────────────
revoke all on public.cc_merchant_rules from anon;
revoke all on public.cc_ignored_events from anon;

revoke all on function public.ledger_money_flow(text, text, jsonb)           from public, anon;
revoke all on function public.ledger_spend_category(text, text, jsonb, text) from public, anon;
grant execute on function public.ledger_money_flow(text, text, jsonb)           to authenticated, service_role;
grant execute on function public.ledger_spend_category(text, text, jsonb, text) to authenticated, service_role;


-- ────────────────────────────────────────────────────────────
-- §3  Dead objects
-- ────────────────────────────────────────────────────────────
-- Its index and policy go with it.
drop table if exists public.derived_insights;

drop view if exists health.daily_totals;
drop view if exists health.sleep_nights;

drop function if exists public.health_workouts(date, date, uuid);
drop function if exists public.cc_link_existing(uuid);
drop function if exists public.cc_learn_rules(uuid);
drop function if exists public.cc_move_descriptions(uuid);


-- ────────────────────────────────────────────────────────────
-- §4  cc_points without `source`
-- ────────────────────────────────────────────────────────────
drop view if exists public.cc_points;

create view public.cc_points
with (security_invoker = true) as
select c.id, c.user_id, c.event_id, c.basis,
       c.merchant, c.raw_merchant, c.multiplier, c.points,
       coalesce((e.occurred_at at time zone public.ledger_setting_text(c.user_id, 'ledger_timezone', 'Asia/Kolkata'))::date, c.date) as date,
       coalesce(case when (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'amount')::numeric end, c.amount) as amount,
       -- The event's note when there is an event; the typed one only as a
       -- fallback, for a row with no event or whose event has gone.
       coalesce(nullif(btrim(e.description), ''), nullif(btrim(c.description), '')) as description,
       case when e.id is not null and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
             and abs((e.data ->> 'amount')::numeric - c.amount) >= 1 then c.amount end as amount_typed,
       c.is_work
  from public.cc_transactions c
  left join public.events e on e.id = c.event_id;

revoke all on public.cc_points from public, anon;
grant select on public.cc_points to authenticated, service_role;


-- ────────────────────────────────────────────────────────────
-- §5  ledger_purge_snippets — what email.js writes, and run hygiene
--
-- Drop the cached body text from old sources but keep the pointer. Provenance
-- survives — the message id and URL still resolve to the original — while the
-- copy of your mail that this database holds stays as small as possible.
-- SECURITY INVOKER, as before: RLS scopes a signed-in caller, and the service
-- role names the user and passes ledger_can_act_as().
-- ────────────────────────────────────────────────────────────
drop function if exists public.ledger_purge_snippets(integer, uuid);

create function public.ledger_purge_snippets(p_days integer default null, p_user_id uuid default null)
returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_uid          uuid := coalesce(p_user_id, auth.uid());
  v_days         integer;
  v_snippets     integer;
  v_runs_failed  integer;
  v_runs_deleted integer;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_days := coalesce(p_days, public.ledger_setting(v_uid, 'ledger_snippet_retention_days', 90)::int);

  -- The one key buildIngestPayload() stores (src/ledger/email.js).
  update public.sources
     set metadata = metadata - 'snippet'
   where user_id = v_uid
     and created_at < now() - make_interval(days => v_days)
     and metadata ? 'snippet';
  get diagnostics v_snippets = row_count;

  -- A run that is still "running" six hours on was never finished: the job
  -- died before finishRun(). Say so, so the row stops looking live.
  update public.ingestion_runs
     set status       = 'failed',
         completed_at = coalesce(completed_at, now()),
         errors       = errors || jsonb_build_array(jsonb_build_object(
                          'stage', 'purge',
                          'error', 'still running after 6 hours; marked failed by ledger_purge_snippets()'))
   where user_id = v_uid
     and status = 'running'
     and started_at < now() - interval '6 hours';
  get diagnostics v_runs_failed = row_count;

  -- A run that saw nothing and succeeded says only "the job ran". A month of
  -- those is a month of noise in front of the runs that did something.
  delete from public.ingestion_runs
   where user_id = v_uid
     and status = 'succeeded'
     and items_seen = 0
     and started_at < now() - interval '30 days';
  get diagnostics v_runs_deleted = row_count;

  return jsonb_build_object(
    'snippets_cleared', v_snippets,
    'runs_failed',      v_runs_failed,
    'runs_deleted',     v_runs_deleted,
    'retention_days',   v_days);
end;
$$;

revoke all on function public.ledger_purge_snippets(integer, uuid) from public, anon;
grant execute on function public.ledger_purge_snippets(integer, uuid) to authenticated, service_role;


-- ────────────────────────────────────────────────────────────
-- §6  One-off data fixes (no-ops on re-run)
-- ────────────────────────────────────────────────────────────
-- The runs stuck in `running` today, by the §5 rule, for every user.
update public.ingestion_runs
   set status       = 'failed',
       completed_at = coalesce(completed_at, now()),
       errors       = errors || jsonb_build_array(jsonb_build_object(
                        'stage', 'cleanup',
                        'error', 'still running after 6 hours; marked failed by 0018_cleanup.sql'))
 where status = 'running'
   and started_at < now() - interval '6 hours';

-- cc_work_label: read by 0012's finance_card_points() and cc_work_spend(),
-- both replaced in 0014, whose backfill was its last reader. Only once 0014
-- has run (is_work exists) is the setting safe to lose.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'cc_transactions' and column_name = 'is_work') then
    delete from public.user_settings where key = 'cc_work_label';
  end if;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- §7  Bank spellings → the entity the receipt names
-- ────────────────────────────────────────────────────────────
do $$
declare
  r        record;
  v_target uuid;
  v_dup    uuid;
begin
  for r in
    select u.user_id, t.type, p.canonical, p.bank,
           public.ledger_normalize_name(p.canonical) as canon_norm,
           public.ledger_normalize_name(p.bank)      as bank_norm
      from (values ('District', 'Orbgen Technologies'),
                   ('Jio',      'MYJIO'),
                   ('Swiggy',   'Bundl Technologies'),
                   ('Tata 1mg', 'Tata 1Mg Healthca'),
                   ('Tata 1mg', 'Tata 1Mg Healthcare')) as p(canonical, bank)
     cross join (select distinct e.user_id from public.entities e) as u
     cross join (values ('merchant'), ('company')) as t(type)
     order by u.user_id, t.type, p.canonical, p.bank
  loop
    select e.id into v_target from public.entities e
     where e.user_id = r.user_id and e.type = r.type and e.normalized_name = r.canon_norm;
    select e.id into v_dup from public.entities e
     where e.user_id = r.user_id and e.type = r.type and e.normalized_name = r.bank_norm;

    if v_target is not null and v_dup is not null and v_target <> v_dup then
      -- Two entities for one merchant: fold the bank's into the receipt's.
      -- Events move, the bank spelling becomes an alias, the audit log says so.
      perform public.ledger_merge_entities(v_target, v_dup);
    elsif v_target is not null then
      perform public.ledger_add_entity_aliases(v_target, array[r.bank]);
    elsif v_dup is not null then
      -- Only ever seen through the bank: give it the name the receipt uses,
      -- and keep the bank's as an alias so the next alert still lands here.
      update public.entities e
         set name = r.canonical, normalized_name = r.canon_norm
       where e.id = v_dup;
      perform public.ledger_add_entity_aliases(v_dup, array[r.bank]);
    end if;
  end loop;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- §9  The guard must never return NULL, and the food functions must not be
--     callable by anon at all
--
-- Found while verifying §1 against the live project: for an anonymous
-- request auth.uid() is NULL, so `auth.uid() = p_user_id` is NULL, and
-- `NULL or false or false` is NULL. Every caller tests `if not guard then
-- raise`, and `not NULL` is NULL, which plpgsql treats as "do not raise".
-- So the guard was silently open for anon — in both ledger_can_act_as() and
-- health.can_read(), which has the same shape. coalesce() closes it.
--
-- Belt and braces: the food_* functions were created without the
-- `revoke ... from public` that 0004 gives every ledger_% function, so
-- Supabase's default EXECUTE-to-PUBLIC still let anon call them. Revoked.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_can_act_as(p_user_id uuid)
returns boolean language sql stable set search_path = public, extensions, pg_temp as $$
  select p_user_id is not null and (
       coalesce(auth.uid() = p_user_id, false)
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    or session_user in ('postgres', 'supabase_admin')
  );
$$;

create or replace function health.can_read(p_user_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_user_id is not null and (
       coalesce(auth.uid() = p_user_id, false)
    or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    or session_user in ('postgres', 'supabase_admin')
  );
$$;

revoke all on function public.food_upsert_item(uuid, jsonb)                                   from public, anon;
revoke all on function public.food_match_item(text, numeric, integer, uuid)                   from public, anon;
revoke all on function public.food_pending_items(integer, uuid)                               from public, anon;
revoke all on function public.food_event_nutrition(timestamptz, timestamptz, integer, uuid)   from public, anon;
revoke all on function public.food_coverage(uuid)                                             from public, anon;
revoke all on function public.food_source_rank(text)                                          from public, anon;
revoke all on function public.food_merge_items(uuid, uuid, uuid)                              from public, anon;

drop function if exists public._diag_guard(uuid);
