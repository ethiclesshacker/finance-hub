-- ============================================================
-- Read-only RLS audit. Changes nothing — safe to run any time.
-- Paste the whole thing into the Supabase SQL editor.
-- ============================================================

-- 1. Is RLS actually switched on?
select
  c.relname                      as table_name,
  c.relrowsecurity               as rls_enabled,
  c.relforcerowsecurity          as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('net_worth_entries', 'cc_transactions', 'cc_redemptions', 'user_settings')
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
  and tablename in ('net_worth_entries', 'cc_transactions', 'cc_redemptions', 'user_settings')
order by tablename, cmd, policyname;


-- 3. Which commands have NO policy at all?
--    With RLS on, a command with no policy is denied outright — safe, but it
--    means that operation silently fails in the app.
with wanted as (
  select t.tablename, c.cmd
  from (values ('net_worth_entries'), ('cc_transactions'), ('cc_redemptions'), ('user_settings')) as t(tablename)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as c(cmd)
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


-- 4. Rows with a null user_id.
--    These are invisible to any owner-scoped policy — including yours — and
--    they are the one thing that makes 0002_harden_rls.sql fail, because it
--    sets user_id NOT NULL. Must be 0 everywhere before you run it.
select 'net_worth_entries' as table_name, count(*) as null_user_id from public.net_worth_entries where user_id is null
union all
select 'cc_transactions', count(*) from public.cc_transactions where user_id is null
union all
select 'cc_redemptions',  count(*) from public.cc_redemptions  where user_id is null;
