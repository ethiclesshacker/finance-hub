-- ============================================================
-- Read-only RLS audit. Changes nothing — safe to run any time.
-- Paste the whole thing into the Supabase SQL editor, or
--   npx supabase db query --linked -f supabase/checks/rls_audit.sql
--
-- Covers every table in `public`, read from the catalogue, so a table added
-- by a later migration is audited without editing this file.
-- ============================================================

-- 1. Is RLS actually switched on?
--    `has_user_id` says whether the owner-scoped policy shape even applies;
--    the one table without it (ledger_event_types) is a shared catalogue.
select
  c.relname                      as table_name,
  c.relrowsecurity               as rls_enabled,
  c.relforcerowsecurity          as rls_forced,
  exists (select 1 from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped) as has_user_id
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
order by c.relname;


-- 2. Which commands are covered, and is each one owner-scoped?
--    verdict tells you what to look at:
--      OK             → scoped to auth.uid()
--      OVER-BROAD     → matches every row for anyone who gets past the API key
--      REVIEW         → scoped to something else; read it yourself
select
  tablename,
  cmd,
  policyname,
  coalesce(qual, '(none)')       as using_expr,
  coalesce(with_check, '(none)') as check_expr,
  case
    when coalesce(qual, with_check) ilike '%auth.uid()%' then 'OK'
    when coalesce(qual, with_check) in ('true', '(true)') then 'OVER-BROAD'
    else 'REVIEW'
  end                            as verdict
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;


-- 3. Which commands have NO policy at all?
--    With RLS on, a command with no policy is denied outright — safe, but it
--    means that operation silently fails in the app. Some gaps are on
--    purpose: ledger_audit_log has no INSERT/UPDATE/DELETE policy (writes go
--    through SECURITY DEFINER functions), ledger_event_types has none at all.
with wanted as (
  select t.tablename, c.cmd
  from pg_tables t
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as c(cmd)
  where t.schemaname = 'public'
)
select w.tablename, w.cmd as missing_policy_for
from wanted w
where not exists (
  select 1 from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = w.tablename
    and p.cmd in (w.cmd, 'ALL')
)
order by w.tablename, w.cmd;


-- 4. Rows with a null user_id, in every table that has the column.
--    These are invisible to any owner-scoped policy — including yours — and
--    they are the one thing that makes 0002_harden_rls.sql fail, because it
--    sets user_id NOT NULL. Must be 0 everywhere. (query_to_xml is how a
--    plain SELECT runs one count per table without creating a function.)
select
  c.table_name,
  (xpath('/row/n/text()',
         query_to_xml(format('select count(*) as n from public.%I where user_id is null', c.table_name),
                      false, true, '')))[1]::text::bigint as null_user_id
from information_schema.columns c
join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
where c.table_schema = 'public'
  and c.column_name = 'user_id'
order by c.table_name;
