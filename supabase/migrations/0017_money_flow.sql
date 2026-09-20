-- ============================================================
-- One rule for which way money went
--
-- "Is this amount spending, income, or neither?" was answered in three places —
-- ledger_stats() here, isInflow() in src/ledger/summary.js, and life_days() in
-- 0011 — and each was wrong in its own direction.
--
--   ledger_stats, isInflow   every transfer was an inflow. So ₹15,000 moved from
--                            one of your accounts to another was income, and so
--                            was every credit card bill you paid. Lakhs of "money
--                            in" that never existed, in the weekly email and the
--                            daily digest.
--   life_days                no transfer was ever an inflow. A salary credit,
--                            a refund, a dividend: all invisible.
--
-- ledger_money_flow() is the one rule, and src/ledger/summary.js moneyFlow() is
-- its twin. Change one, change both.
--
--   neither   money moving between your own pockets: a self-transfer, or paying
--             off a card whose spends were already counted one by one
--   spend     a purchase; or a transfer that left for good — a payment to a
--             person, an insurance premium
--   inflow    anything marked as a credit; or a transfer that is an arrival even
--             when the bank's email gave no direction — a credit, refund,
--             interest, dividend, cashback, reward
--
-- ledger_stats() also stops using the payment method as a spending category.
-- "card_transaction" is how you paid, not what you bought, and it was the
-- largest "category" in every report. The category is now, in order: the
-- event's own category; the type of its note (`Food: …`, `Flight: …` — the
-- grammar from 0015), which is a category you chose yourself; its subtype,
-- unless that is a payment method; its type.
--
-- Run order: after 0011_life_api.sql. Safe to re-run.
-- ============================================================

create or replace function public.ledger_money_flow(p_type text, p_subtype text, p_data jsonb)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select case
    when p_type = 'transfer' then case
      when p_subtype in ('self_transfer', 'credit_card_bill_repayment', 'card_bill_payment', 'scheduled_bill_payment') then null
      when p_subtype in ('payment', 'insurance_premium')
        then case when p_data ->> 'direction' = 'credit' then 'inflow' else 'spend' end
      when p_data ->> 'direction' = 'credit'
        or p_subtype in ('credit', 'refund', 'interest_credit', 'dividend', 'cashback', 'reward') then 'inflow'
      else null end
    when p_data ->> 'direction' = 'credit' then 'inflow'
    else 'spend'
  end;
$$;

-- What a spend was for. See the header for the order and why.
create or replace function public.ledger_spend_category(p_type text, p_subtype text, p_data jsonb, p_description text)
returns text language sql immutable
set search_path = public, pg_temp as $$
  select lower(coalesce(
    nullif(btrim(p_data ->> 'category'), ''),
    case when p_description ~ '^[A-Z][a-z]+(:|$| \|)' then substring(p_description from '^[A-Za-z]+') end,
    case when p_subtype is not null
          and p_subtype !~ '(card|upi|payment|transaction|purchase)' then p_subtype end,
    p_type, 'uncategorised'));
$$;


-- ledger_stats(), with the one rule and an honest category.
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
           -- Which way the amount counts is decided once, by the one rule, and
           -- an amount that only moved between your own pockets counts as neither.
           case when public.ledger_money_flow(e.type, e.subtype, e.data) = 'spend'
                then public.ledger_num(e.data, 'amount') end as spend_amount,
           case when public.ledger_money_flow(e.type, e.subtype, e.data) = 'inflow'
                then public.ledger_num(e.data, 'amount') end as inflow_amount
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
                      from (select public.ledger_spend_category(type, subtype, data, description) category, sum(spend_amount) total
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
