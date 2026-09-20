-- ============================================================
-- Card points, fed by the ledger instead of by hand
--
-- The points tracker (cc_transactions, cc_redemptions) was built before the
-- event ledger existed. Every HSBC TravelOne spend was typed in, with a label
-- and a multiplier. Then the email ingest started capturing the same spends as
-- events — and from that day each card transaction existed twice, once typed
-- and once read from the bank's alert, with nothing connecting them. Of 261
-- typed rows, 213 had an exact twin among the card's events.
--
-- The typed rows are not redundant, though. They carry two things no bank email
-- knows:
--
--   the label       what YOU call it: a short name for the landlord's company, a
--                   booking portal's name for whatever the statement calls it —
--                   and above all the work label, which is not a merchant at
--                   all but a purpose: work spend, pooled under the employer's
--                   name whether it went to a bookshop, an airline or a
--                   software subscription.
--   the multiplier  2× by default, more on travel and through portals. A
--                   property of the merchant: 84 of 87 labels had only ever
--                   had one.
--
-- So this file keeps cc_transactions as the home of points and changes how rows
-- get there:
--
--   1. Each row can link to the ledger event it describes (event_id).
--   2. cc_merchant_rules maps a ledger merchant to your label and multiplier.
--      It is seeded by LEARNING from the rows you already typed, so none of
--      that work is repeated. This table is what you curate from now on.
--   3. New events on the card create their own row, marked `assumed`, using the
--      rule for that merchant — "look at the previous transactions at the same
--      merchant and assume the points". You confirm or correct; you do not type.
--   4. Where a typed row and the bank disagree, the bank wins on amount and
--      date, and your row wins on label, multiplier and points.
--   5. Rows labelled with the work label are work spend, and life_days() now
--      reports spend split into personal and work. Nothing is written to an
--      event to do this: the ledger keeps what the source said, and the label
--      stays yours, in your table.
--
-- What a row still holds, and what it no longer needs to. Once a row is linked,
-- its date, amount and description are the event's, and copying them is how two
-- stores drift apart. So everything reads through the `cc_points` view, which
-- takes those three from the event whenever there is one. A linked row is, in
-- effect, five columns: the event, your label, the multiplier, any points you
-- stated, and whether you have looked at it.
--
-- The description is the clearest case. What was bought against a vending
-- machine charge, which hotel against a booking portal's, which route against a
-- bus operator's — 198 linked rows carried a note like that, and one event did. That context
-- belongs to the event, where the Life timeline, search, the daily summary and
-- Hermes can all see it, so cc_move_descriptions() moves it there. It stays
-- editable from the Points page: cc_confirm() writes it through to the event.
--
-- The physical columns stay, as a fallback and not as the truth, for two
-- reasons. Forty-eight typed rows have no event at all — the bank's email never
-- came, or the ledger was not running yet — and they need somewhere to keep a
-- date and an amount. And the ledger merges and deletes events: a row whose
-- event disappears must fall back to what it knew, not lose its amount.
--
-- One card only. The account is a setting (cc_points_account, the last four
-- digits; empty until set, and with it empty nothing here does anything).
-- Events on any other card are never touched.
--
-- Auto-creation starts the day after your last typed row. Everything older
-- that did not pair goes to cc_reconcile() instead, because an unpaired old
-- event is as likely to be a typo on one side (two digits transposed against
-- the bank's figure) as a transaction you never entered — and creating a row for it
-- would count those points twice.
--
-- Run order: after 0011_life_api.sql. Run once, in order: 0013 and 0014 replace
-- several functions defined here and widen the cc_points view, so re-running
-- this file on its own after them would undo their changes (and the view
-- cannot be narrowed). To re-apply, run 0012, 0013 and 0014 together.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- Shape
-- ────────────────────────────────────────────────────────────
alter table public.cc_transactions
  add column if not exists event_id     uuid references public.events (id) on delete set null,
  add column if not exists basis        text not null default 'manual',
  add column if not exists raw_merchant text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cc_transactions_basis_check') then
    alter table public.cc_transactions
      add constraint cc_transactions_basis_check check (basis in ('manual', 'assumed', 'confirmed'));
  end if;
end;
$$;

-- One row per event. Partial, so the many rows with no event stay legal.
create unique index if not exists cc_transactions_event_uidx
  on public.cc_transactions (event_id) where event_id is not null;

create table if not exists public.cc_merchant_rules (
  user_id          uuid        not null references auth.users (id) on delete cascade,
  merchant_key     text        not null,          -- ledger_normalize_name(ledger merchant)
  ledger_merchant  text        not null,          -- as the bank spells it, for display
  label            text        not null,          -- what you call it
  multiplier       integer     not null default 2,
  -- True when your history files this merchant under more than one label
  -- (a marketplace: sometimes personal, sometimes work). The rule still applies its
  -- majority; rows it produces are worth a second look.
  ambiguous        boolean     not null default false,
  source           text        not null default 'learned' check (source in ('learned', 'manual')),
  uses             integer     not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, merchant_key)
);

alter table public.cc_merchant_rules enable row level security;
drop policy if exists cc_merchant_rules_owner on public.cc_merchant_rules;
create policy cc_merchant_rules_owner on public.cc_merchant_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.cc_merchant_rules to authenticated;
grant all on public.cc_merchant_rules to service_role;


-- ────────────────────────────────────────────────────────────
-- cc_points — the table as it should be read
--
-- security_invoker, so the RLS on cc_transactions and on events both apply.
-- `amount_typed` survives only where it differs from the bank's, which is how a
-- typo stays visible after the bank has won.
-- ────────────────────────────────────────────────────────────
create or replace view public.cc_points
with (security_invoker = true) as
select c.id, c.user_id, c.event_id, c.basis,
       c.merchant, c.raw_merchant, c.multiplier, c.points,
       coalesce((e.occurred_at at time zone public.ledger_setting_text(c.user_id, 'ledger_timezone', 'Asia/Kolkata'))::date, c.date) as date,
       coalesce(case when (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'amount')::numeric end, c.amount) as amount,
       -- The event's note when there is an event; the typed one only as a
       -- fallback, for a row with no event or whose event has gone.
       coalesce(nullif(btrim(e.description), ''), nullif(btrim(c.description), '')) as description,
       case when e.id is not null then 'event' else 'typed' end as source,
       case when e.id is not null and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
             and abs((e.data ->> 'amount')::numeric - c.amount) >= 1 then c.amount end as amount_typed
  from public.cc_transactions c
  left join public.events e on e.id = c.event_id;

grant select on public.cc_points to authenticated, service_role;


-- ────────────────────────────────────────────────────────────
-- The card's spends, as the ledger sees them
--
-- Debits on the configured account that carry an amount. Credits (refunds, bill
-- payments) and transfers earn nothing and are left out.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_card_events(p_user_id uuid)
returns table (event_id uuid, day date, amount numeric, merchant text, merchant_key text, title text, status text)
language sql stable
set search_path = public, pg_temp as $$
  select e.id,
         (e.occurred_at at time zone public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata'))::date,
         (e.data ->> 'amount')::numeric,
         nullif(btrim(e.data ->> 'merchant'), ''),
         public.ledger_normalize_name(nullif(btrim(e.data ->> 'merchant'), '')),
         e.title, e.status
    from public.events e
   where e.user_id = p_user_id
     and e.data ->> 'account' = public.ledger_setting_text(p_user_id, 'cc_points_account', '')
     and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
     and e.status <> 'dismissed'
     and e.type <> 'transfer'
     and coalesce(e.data ->> 'direction', 'debit') <> 'credit';
$$;


-- ────────────────────────────────────────────────────────────
-- Linking: pair each typed row with the event it describes
--
-- Exact pairs only: the same amount to the rupee, within two days (a card
-- alert is sent at the swipe; a typed row is often dated when it posted).
-- Strictly one to one — two ₹154 Uber rides on one day are two pairs, never
-- one event claimed twice — so rows are taken in date order and each takes the
-- nearest event still free.
--
-- Linking writes only the link. The bank's date reaches every reader through
-- the cc_points view; the typed date is left as it was.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_link_existing(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user   uuid := coalesce(p_user_id, auth.uid());
  r        record;
  v_event  record;
  v_linked int := 0;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  for r in
    select c.id, c.date, c.amount from public.cc_transactions c
     where c.user_id = v_user and c.event_id is null
     order by c.date, c.id
  loop
    select ce.event_id, ce.day, ce.merchant into v_event
      from public.cc_card_events(v_user) ce
     where abs(ce.amount - r.amount) < 1
       and abs(ce.day - r.date) <= 2
       and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
     order by abs(ce.day - r.date), ce.day
     limit 1;

    if found then
      update public.cc_transactions
         set event_id = v_event.event_id, raw_merchant = v_event.merchant
       where id = r.id;
      v_linked := v_linked + 1;
    end if;
  end loop;

  return jsonb_build_object('linked', v_linked,
    'rows_without_event', (select count(*) from public.cc_transactions c where c.user_id = v_user and c.event_id is null));
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Learning: your labels, read back out of the rows you typed
--
-- For each ledger merchant, the label and multiplier you used most. Only rows
-- you typed or confirmed teach a rule — an assumed row is the rule's own
-- output, and learning from it would be the rule agreeing with itself.
-- "Unknown Merchant" teaches nothing: the ledger already knows the name.
--
-- A rule you edited by hand (source = 'manual') is never overwritten.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_learn_rules(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with taught as (
    select public.ledger_normalize_name(c.raw_merchant) as merchant_key, c.raw_merchant, c.merchant as label, c.multiplier
      from public.cc_transactions c
     where c.user_id = v_user and c.event_id is not null and c.basis in ('manual', 'confirmed')
       and nullif(btrim(c.raw_merchant), '') is not null
       and lower(btrim(c.merchant)) <> 'unknown merchant'
  ),
  per_key as (
    select t.merchant_key, count(*) as uses, count(distinct t.label) > 1 as ambiguous,
           mode() within group (order by t.label)        as label,
           mode() within group (order by t.multiplier)   as multiplier,
           mode() within group (order by t.raw_merchant) as ledger_merchant
      from taught t
     where t.merchant_key is not null and t.merchant_key <> ''
     group by t.merchant_key
  )
  insert into public.cc_merchant_rules as r (user_id, merchant_key, ledger_merchant, label, multiplier, ambiguous, source, uses)
  select v_user, k.merchant_key, k.ledger_merchant, k.label, k.multiplier, k.ambiguous, 'learned', k.uses
    from per_key k
  on conflict (user_id, merchant_key) do update
     set ledger_merchant = excluded.ledger_merchant, label = excluded.label, multiplier = excluded.multiplier,
         ambiguous = excluded.ambiguous, uses = excluded.uses, updated_at = now()
   where r.source = 'learned';

  get diagnostics v_n = row_count;
  return jsonb_build_object('rules_written', v_n,
    'rules_total', (select count(*) from public.cc_merchant_rules r where r.user_id = v_user));
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Sync: a row for every new spend on the card
--
-- Runs after each email ingest, and from the Points page. Idempotent: the
-- unique index on event_id means a second run finds nothing to do.
--
-- The cutover is fixed the first time this runs — the day after the last row
-- you typed — and stored, so that later typing an old row cannot move it.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_sync_from_events(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user    uuid := coalesce(p_user_id, auth.uid());
  v_from    date;
  v_created int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  select (s.value #>> '{}')::date into v_from
    from public.user_settings s where s.user_id = v_user and s.key = 'cc_auto_from';

  if v_from is null then
    select coalesce(max(c.date) + 1, current_date) into v_from
      from public.cc_transactions c where c.user_id = v_user and c.basis = 'manual';
    insert into public.user_settings (user_id, key, value)
    values (v_user, 'cc_auto_from', to_jsonb(v_from::text))
    on conflict (user_id, key) do nothing;
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant)
  select v_user, ce.day,
         coalesce(r.label, ce.merchant, 'Unknown Merchant'),
         null,                       -- the note lives on the event; nothing to copy
         ce.amount,
         coalesce(r.multiplier, 2),
         null,                       -- computed from amount × multiplier until you state otherwise
         ce.event_id, 'assumed', ce.merchant
    from public.cc_card_events(v_user) ce
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.day >= v_from
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id);

  get diagnostics v_created = row_count;
  return jsonb_build_object('created', v_created, 'auto_from', v_from,
    'assumed_waiting', (select count(*) from public.cc_transactions c where c.user_id = v_user and c.basis = 'assumed'));
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Confirming, correcting, linking by hand
-- ────────────────────────────────────────────────────────────

-- Save a row: accept it as it is, or change its label, multiplier, points or
-- note. ANY save marks it confirmed — touching a row is looking at it, and
-- asking for a second click to say so would be a chore with no information in
-- it. `p_remember` also teaches the rule, so the next spend there arrives right.
--
-- The note goes to the event when there is one (null leaves it alone, an empty
-- string clears it). A copy is kept on the row only as the fallback the view
-- uses if the event is ever merged away.
drop function if exists public.cc_confirm(uuid, text, integer, numeric, boolean, uuid);
create or replace function public.cc_confirm(
  p_id uuid, p_label text default null, p_multiplier integer default null,
  p_points numeric default null, p_remember boolean default false,
  p_description text default null, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_row  public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  update public.cc_transactions c
     set merchant    = coalesce(nullif(btrim(p_label), ''), c.merchant),
         multiplier  = coalesce(p_multiplier, c.multiplier),
         points      = coalesce(p_points, c.points),
         description = case when p_description is null then c.description else nullif(btrim(p_description), '') end,
         basis       = case when c.basis = 'assumed' then 'confirmed' else c.basis end
   where c.id = p_id and c.user_id = v_user
  returning c.* into v_row;

  if v_row.id is null then
    raise exception 'no such row' using errcode = 'P0002';
  end if;

  if p_description is not null and v_row.event_id is not null then
    update public.events e
       set description = nullif(btrim(p_description), '')
     where e.id = v_row.event_id and e.user_id = v_user;
  end if;

  if p_remember and nullif(btrim(v_row.raw_merchant), '') is not null then
    insert into public.cc_merchant_rules as r (user_id, merchant_key, ledger_merchant, label, multiplier, ambiguous, source, uses)
    values (v_user, public.ledger_normalize_name(v_row.raw_merchant), v_row.raw_merchant, v_row.merchant, v_row.multiplier, false, 'manual', 1)
    on conflict (user_id, merchant_key) do update
       set label = excluded.label, multiplier = excluded.multiplier, ambiguous = false, source = 'manual', updated_at = now();
  end if;

  return to_jsonb(v_row);
end;
$$;

-- Move the notes you typed onto the events they describe. Only where the event
-- has none of its own: a note already on the event is the newer one. Safe to
-- run again after linking more rows.
create or replace function public.cc_move_descriptions(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  -- A row the sync made used to copy the event's title in as its note. That is
  -- not a note; clear it so it is not mistaken for one.
  update public.cc_transactions c set description = null
    from public.events e
   where e.id = c.event_id and c.user_id = v_user and c.description = e.title;

  update public.events e
     set description = btrim(c.description)
    from public.cc_transactions c
   where c.event_id = e.id and c.user_id = v_user and e.user_id = v_user
     and nullif(btrim(c.description), '') is not null
     and nullif(btrim(e.description), '') is null;

  get diagnostics v_n = row_count;
  return jsonb_build_object('moved', v_n);
end;
$$;

-- Pair a typed row with an event the exact matcher would not: a typo, a tip, a
-- currency conversion. The bank wins the amount and the date — through the
-- cc_points view, which prefers the event — and what you typed is left in place
-- so the disagreement stays visible as `amount_typed`. The label, the
-- multiplier and any stated points stay yours.
create or replace function public.cc_link(p_id uuid, p_event_id uuid, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user  uuid := coalesce(p_user_id, auth.uid());
  v_event record;
  v_row   public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  select * into v_event from public.cc_card_events(v_user) ce where ce.event_id = p_event_id;
  if not found then
    raise exception 'that event is not a spend on the points card' using errcode = 'P0002';
  end if;

  update public.cc_transactions c
     set event_id = p_event_id, raw_merchant = v_event.merchant
   where c.id = p_id and c.user_id = v_user and c.event_id is null
  returning c.* into v_row;

  if v_row.id is null then
    raise exception 'no such unlinked row' using errcode = 'P0002';
  end if;
  return to_jsonb(v_row);
end;
$$;

-- Make a row for one old event the cutover left out.
create or replace function public.cc_create_from_event(p_event_id uuid, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_row  public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, 2), null, ce.event_id, 'assumed', ce.merchant
    from public.cc_card_events(v_user) ce
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.event_id = p_event_id
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
  returning * into v_row;

  if v_row.id is null then
    raise exception 'that event is not an unlinked spend on the points card' using errcode = 'P0002';
  end if;
  return to_jsonb(v_row);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Reconciliation: what did not pair, from both sides
--
-- For each typed row with no event, the most likely event it was meant to be:
-- within three days, and either filed under the same label by a rule and within
-- half the amount, or — with no label in common — within a quarter of it. That
-- is wide enough for a transposed digit (typically a gap under 20%) and
-- narrow enough that two unrelated spends in the same week are not offered as
-- a pair. A row that combines two events (a ₹829 meal and its ₹50 fee typed as
-- one ₹879 row) gets no suggestion; that one is a human's call.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_reconcile(p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with free_events as (
    select ce.*, r.label as rule_label
      from public.cc_card_events(v_user) ce
      left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
     where not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
  ),
  free_rows as (
    select c.* from public.cc_transactions c where c.user_id = v_user and c.event_id is null
  ),
  suggestions as (
    select distinct on (fr.id) fr.id as row_id, fe.event_id, fe.day, fe.amount, fe.merchant,
           case when fe.rule_label = fr.merchant then 'same label, close amount' else 'close amount' end as why
      from free_rows fr
      join free_events fe on abs(fe.day - fr.date) <= 3
       and abs(fe.amount - fr.amount) / nullif(fr.amount, 0) <= case when fe.rule_label = fr.merchant then 0.5 else 0.25 end
     order by fr.id,
              (fe.rule_label = fr.merchant) desc nulls last,
              abs(fe.amount - fr.amount) / nullif(fr.amount, 0),
              abs(fe.day - fr.date)
  )
  select jsonb_build_object(
    'rows_without_event', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'id', fr.id, 'date', fr.date, 'label', fr.merchant, 'amount', fr.amount, 'multiplier', fr.multiplier,
               'suggestion', (select jsonb_build_object('event_id', s.event_id, 'date', s.day, 'amount', s.amount,
                                                        'merchant', s.merchant, 'why', s.why)
                                from suggestions s where s.row_id = fr.id))) order by fr.date desc)
        from free_rows fr), '[]'::jsonb),
    'events_without_row', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'event_id', fe.event_id, 'date', fe.day, 'merchant', fe.merchant, 'title', fe.title, 'amount', fe.amount,
               'would_be_label', coalesce(fe.rule_label, fe.merchant), 'status', fe.status)) order by fe.day desc)
        from free_events fe), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- finance_card_points, now aware of what is assumed and what is work
-- ────────────────────────────────────────────────────────────
create or replace function public.finance_card_points(p_from date default null, p_to date default null, p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_work text;
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  v_work := public.ledger_setting_text(v_user, 'cc_work_label', 'Work');

  with tx as (
    select c.date, c.merchant, c.amount, c.basis,
           coalesce(c.points, c.amount * c.multiplier / 100.0) as pts
      from public.cc_points c
     where c.user_id = v_user
  ),
  rd as (
    select r.date, r.partner, r.points_redeemed, r.value_amount, r.currency
      from public.cc_redemptions r
     where r.user_id = v_user
  ),
  in_range as (
    select * from tx t
     where (p_from is null or t.date >= p_from) and (p_to is null or t.date <= p_to)
  )
  select jsonb_build_object(
    -- The balance is lifetime by definition; the range only scopes the rest.
    'balance', round((select coalesce(sum(pts), 0) from tx) - (select coalesce(sum(points_redeemed), 0) from rd)),
    -- Points on rows nobody has looked at yet. Part of the balance, but a guess.
    'assumed', jsonb_build_object(
      'rows',   (select count(*) from tx where basis = 'assumed'),
      'points', round((select coalesce(sum(pts), 0) from tx where basis = 'assumed'))),
    'lifetime', jsonb_build_object(
      'accrued',  round((select coalesce(sum(pts), 0) from tx)),
      'redeemed', round((select coalesce(sum(points_redeemed), 0) from rd)),
      'spend',    round((select coalesce(sum(amount), 0) from tx)),
      'first_transaction', (select min(date) from tx),
      'last_transaction',  (select max(date) from tx)),
    'range', jsonb_build_object(
      'from', p_from, 'to', p_to,
      'spend',        round((select coalesce(sum(amount), 0) from in_range)),
      'work_spend',   round((select coalesce(sum(amount), 0) from in_range where merchant = v_work)),
      'points',       round((select coalesce(sum(pts), 0) from in_range)),
      'transactions', (select count(*) from in_range),
      'points_per_100', (select round((sum(pts) / nullif(sum(amount), 0) * 100)::numeric, 2) from in_range)),
    'by_month', coalesce((select jsonb_agg(to_jsonb(m) order by m.month)
                            from (select to_char(date_trunc('month', date), 'YYYY-MM') as month,
                                         round(sum(amount)) as spend, round(sum(pts)) as points, count(*) as transactions
                                    from in_range group by 1) m), '[]'::jsonb),
    'top_merchants', coalesce((select jsonb_agg(to_jsonb(t))
                                 from (select merchant, round(sum(amount)) as spend, round(sum(pts)) as points
                                         from in_range group by merchant order by sum(pts) desc limit 8) t), '[]'::jsonb),
    'redemptions', coalesce((select jsonb_agg(to_jsonb(r) order by r.date desc) from rd r), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Work spend, per local day — for life_days()
--
-- An event is work spend when its points row carries the work label. Read at
-- query time from your own table; the event itself is never written to.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_work_spend(p_user_id uuid, p_from date, p_to date)
returns table (day date, amount numeric)
language sql stable
set search_path = public, pg_temp as $$
  select c.date, sum(c.amount)
    from public.cc_points c
   where c.user_id = p_user_id
     and c.event_id is not null
     and c.merchant = public.ledger_setting_text(p_user_id, 'cc_work_label', 'Work')
     and c.date between p_from and p_to
   group by c.date;
$$;


do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.cc_card_events(uuid)',
    'public.cc_link_existing(uuid)',
    'public.cc_learn_rules(uuid)',
    'public.cc_sync_from_events(uuid)',
    'public.cc_confirm(uuid, text, integer, numeric, boolean, text, uuid)',
    'public.cc_move_descriptions(uuid)',
    'public.cc_link(uuid, uuid, uuid)',
    'public.cc_create_from_event(uuid, uuid)',
    'public.cc_reconcile(uuid)',
    'public.cc_work_spend(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
