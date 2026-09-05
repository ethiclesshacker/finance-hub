-- ============================================================
-- Stated calories outrank the dictionary
--
-- Found in the field, one day after 0005 shipped: a meal logged through Hermes
-- as "Maharaja Mac 833, fries 225, Coke Zero 0" rolled up as **1 kcal** — the
-- two named dishes were not in the dictionary, the Coke Zero was (1 kcal), and
-- the rollup only ever read the dictionary. The person had stated the exact
-- numbers and the system threw them away.
--
-- The rule this migration adds, in both rollup paths: a calorie count carried
-- on the line item itself (`kcal` or `calories`) wins over the dictionary. It
-- came from the person or the menu, about that exact serving. Zero is a
-- legitimate statement — a Coke Zero — so the test is "is a number", never
-- "is truthy". Macros still come from the dictionary when it knows the dish.
--
-- This file replaces food_event_nutrition and food_coverage from 0005. The JS
-- twin (src/ledger/nutrition.js) applies the identical rule — change one,
-- change both.
--
-- Run order: after 0005_nutrition.sql.
-- ============================================================

create or replace function public.food_event_nutrition(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_limit   integer     default 2000,
  p_user_id uuid        default null
)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id, e.occurred_at, e.subtype, e.title,
           public.ledger_num(e.data, 'amount')                         as amount,
           coalesce(e.data ->> 'ordered_via', e.data ->> 'merchant')   as via,
           coalesce(e.data ->> 'restaurant',  e.data ->> 'merchant')   as place,
           case when jsonb_typeof(e.data -> 'items') = 'array'
                then e.data -> 'items' else '[]'::jsonb end            as items
    from public.events e
    where e.user_id = v_user
      and e.type = 'food'
      and e.status <> 'dismissed'
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <= p_to)
    order by e.occurred_at desc
    limit greatest(p_limit, 0)
  ),
  li as (
    select ev.id as event_id,
           coalesce(public.ledger_num(item, 'qty'), 1) as qty,
           -- The stated count, when the line item carries one.
           coalesce(public.ledger_num(item, 'kcal'),
                    public.ledger_num(item, 'calories'))               as stated_kcal,
           f.kcal as dict_kcal,
           f.protein_g, f.carbs_g, f.fat_g, f.source, f.confidence
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  agg as (
    select event_id,
           count(*)::int                                              as items_total,
           count(coalesce(stated_kcal, dict_kcal))::int               as items_resolved,
           sum(qty * coalesce(stated_kcal, dict_kcal))                as kcal,
           sum(qty * protein_g)                                       as protein_g,
           sum(qty * carbs_g)                                         as carbs_g,
           sum(qty * fat_g)                                           as fat_g,
           min(confidence)                                            as confidence,
           min(public.food_source_rank(source))                       as weakest_rank
    from li group by event_id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.occurred_at desc), '[]'::jsonb) into v_out
  from (
    select ev.id, ev.occurred_at, ev.subtype, ev.title, ev.amount, ev.via, ev.place,
           coalesce(a.items_total, 0)    as items_total,
           coalesce(a.items_resolved, 0) as items_resolved,
           round(a.kcal, 1)      as kcal,
           round(a.protein_g, 1) as protein_g,
           round(a.carbs_g, 1)   as carbs_g,
           round(a.fat_g, 1)     as fat_g,
           a.confidence,
           case
             when coalesce(a.items_total, 0) = 0                then 'none'
             when a.items_resolved = 0                          then 'none'
             when a.items_resolved < a.items_total              then 'partial'
             else 'itemized'
           end as basis
    from ev left join agg a on a.event_id = ev.id
  ) r;

  return v_out;
end;
$$;


create or replace function public.food_coverage(p_user_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id,
           case when jsonb_typeof(e.data -> 'items') = 'array'
                then e.data -> 'items' else '[]'::jsonb end as items
    from public.events e
    where e.user_id = v_user and e.type = 'food' and e.status <> 'dismissed'
  ),
  li as (
    select ev.id as event_id,
           (coalesce(public.ledger_num(item, 'kcal'),
                     public.ledger_num(item, 'calories')) is not null
            or f.kcal is not null) as resolved
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  per_event as (
    select event_id, count(*) as n, count(*) filter (where resolved) as ok
    from li group by event_id
  )
  select jsonb_build_object(
    'events_total',        (select count(*) from ev),
    'events_with_items',   (select count(*) from per_event),
    'events_itemized',     (select count(*) from per_event where ok = n),
    'events_partial',      (select count(*) from per_event where ok > 0 and ok < n),
    'events_no_items',     (select count(*) from ev) - (select count(*) from per_event),
    'line_items_total',    (select count(*) from li),
    'line_items_resolved', (select count(*) from li where resolved),
    'dictionary_size',     (select count(*) from public.food_items where user_id = v_user),
    'dictionary_resolved', (select count(*) from public.food_items
                             where user_id = v_user and kcal is not null),
    'by_source',           (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
                              from (select source, count(*) as n from public.food_items
                                     where user_id = v_user and kcal is not null
                                     group by source) s)
  ) into v_out;

  return v_out;
end;
$$;
