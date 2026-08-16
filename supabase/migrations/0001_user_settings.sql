-- ============================================================
-- user_settings — per-user configuration as key/value pairs
--
-- Deliberately key/value rather than one column per setting: adding a knob
-- should be an object literal in src/settings.js, not a migration + rebuild +
-- redeploy.
--
-- `value` is jsonb, not text, so numbers stay numbers and booleans stay
-- booleans. Storing "40000" as text means every read is a parseFloat and a
-- typo silently becomes NaN.
--
-- Per-key typing, defaults and validation live in SETTINGS_SCHEMA in
-- src/settings.js — that catalogue is the source of truth and also drives
-- the settings screen.
-- ============================================================

create table if not exists public.user_settings (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null check (char_length(key) between 1 and 64),
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_settings enable row level security;

-- Four separate policies. A single FOR ALL policy is easy to get subtly wrong,
-- and USING alone does not restrict INSERT.
drop policy if exists user_settings_select on public.user_settings;
create policy user_settings_select on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists user_settings_insert on public.user_settings;
create policy user_settings_insert on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists user_settings_update on public.user_settings;
create policy user_settings_update on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists user_settings_delete on public.user_settings;
create policy user_settings_delete on public.user_settings
  for delete using (auth.uid() = user_id);

-- Keep updated_at honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.touch_updated_at();
