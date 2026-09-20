-- ============================================================
-- The three tables the app started with
--
-- net_worth_entries, cc_transactions and cc_redemptions were made by hand in
-- the Supabase dashboard before this directory existed. Every migration from
-- 0002 on assumes they are there, and none of them says how they got there —
-- so the repository could rebuild every function in the project and none of
-- the tables those functions read.
--
-- This file records them as they were on day one: their original columns only.
-- What came later is left to the migration that added it (the event link,
-- `basis`, `raw_merchant` in 0012; `no_alert` in 0013; `is_work` in 0014), and
-- `user_id` is nullable here because making it NOT NULL is 0002's job. Written
-- from the live schema, so on the existing database every statement is a no-op.
--
-- Numbered 0000 because it has to run before everything else.
-- ============================================================

create table if not exists public.net_worth_entries (
  id            uuid        primary key default gen_random_uuid(),
  date          date        not null,
  stocks        numeric     default 0,
  mutual_funds  numeric     default 0,
  cash          numeric     default 0,
  epf           numeric     default 0,
  gold          numeric     default 0,
  fds           numeric     default 0,
  credit_cards  numeric     default 0,          -- a liability: subtracted, not added
  created_at    timestamptz default now(),
  user_id       uuid        references auth.users (id) on delete cascade
);

create index if not exists idx_net_worth_entries_date on public.net_worth_entries (date);

create table if not exists public.cc_transactions (
  id           uuid     primary key default gen_random_uuid(),
  date         date     not null,
  merchant     text     not null,               -- your label, not the bank's name for it
  description  text,
  amount       numeric  not null,
  multiplier   integer  not null,               -- points per ₹100
  points       numeric,                         -- null: computed as amount × multiplier / 100
  user_id      uuid     references auth.users (id) on delete cascade
);

create table if not exists public.cc_redemptions (
  id               uuid     primary key default gen_random_uuid(),
  date             date     not null,
  partner          text     not null,
  description      text,
  points_redeemed  numeric  not null,
  value_amount     numeric  not null,
  currency         text     default 'INR',
  user_id          uuid     references auth.users (id) on delete cascade
);

-- The app reads these tables without filtering by user and deletes by id alone,
-- so these policies are the only thing between one user's money and another's.
-- FOR ALL with both clauses covers every command (0002 explains why that is
-- enough). Guarded, because a policy cannot be created twice.
alter table public.net_worth_entries enable row level security;
alter table public.cc_transactions   enable row level security;
alter table public.cc_redemptions    enable row level security;

do $$
declare
  t record;
begin
  for t in select * from (values
      ('net_worth_entries', 'Users manage own net worth entries'),
      ('cc_transactions',   'Users manage own transactions'),
      ('cc_redemptions',    'Users manage own redemptions')) as v(tbl, policy)
  loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.tbl) then
      execute format('create policy %I on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', t.policy, t.tbl);
    end if;
    execute format('grant select, insert, update, delete on public.%I to authenticated', t.tbl);
    execute format('grant all on public.%I to service_role', t.tbl);
  end loop;
end;
$$;
