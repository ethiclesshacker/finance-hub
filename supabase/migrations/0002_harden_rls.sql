-- ============================================================
-- Defensive constraints on the three data tables.
--
-- AUDITED 2026-08-17 — the RLS policies here were already correct, so the
-- policy-creation block this migration originally carried was dropped rather
-- than run. What exists today:
--
--   net_worth_entries | ALL | (auth.uid() = user_id) | check (auth.uid() = user_id)
--   cc_transactions   | ALL | (auth.uid() = user_id) | check (auth.uid() = user_id)
--   cc_redemptions    | ALL | (auth.uid() = user_id) | check (auth.uid() = user_id)
--
-- A FOR ALL policy with BOTH clauses set covers every command: USING governs
-- SELECT and DELETE plus the which-rows half of UPDATE, WITH CHECK governs
-- INSERT plus the what-you-write half of UPDATE. Adding per-command policies
-- on top would be pure redundancy — permissive policies combine with OR, so
-- extra correct policies change nothing.
--
-- Re-audit any time with supabase/checks/rls_audit.sql (read-only).
-- ============================================================

-- The app never filters reads by user_id and deletes by id alone, so these
-- policies are the only thing protecting the data. A row with a null user_id
-- can never satisfy `auth.uid() = user_id`, which makes it invisible to
-- everyone — including you — while still occupying the table. Nothing stops
-- one being written today.
--
-- Verified zero null user_ids before running. If this fails, find them with
-- query 4 of the audit script and assign an owner first.
alter table public.net_worth_entries alter column user_id set not null;
alter table public.cc_transactions   alter column user_id set not null;
alter table public.cc_redemptions    alter column user_id set not null;
