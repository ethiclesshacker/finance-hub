-- ============================================================
-- 'indb' joins the resolver's sources
--
-- The Anuvaad Indian Nutrient Databank (vegetarian subset, checked in as
-- ledger/nutrition/indb.json) becomes a resolver rung: measured, standardized
-- Indian recipes with real per-serving portions. This migration only teaches
-- the database that the source exists and where it ranks.
--
-- Rank 38 — above USDA FDC (35), below Open Food Facts (40): INDB is measured
-- recipe data and beats FDC's US-ingredient tables for Indian cooked food, but
-- an OFF row is the printed label of the exact branded product, which nothing
-- generic outranks. The two barely compete in practice: OFF fires on packaged
-- goods, INDB on composed dishes.
--
-- Run order: after 0006_stated_calories.sql.
-- ============================================================

alter table public.food_items drop constraint if exists food_items_source_check;
alter table public.food_items add constraint food_items_source_check
  check (source in ('manual','curated','off','fdc','indb','llm','heuristic'));

create or replace function public.food_source_rank(p_source text)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case p_source
    when 'manual'    then 60
    when 'curated'   then 50
    when 'off'       then 40
    when 'indb'      then 38
    when 'fdc'       then 35
    when 'llm'       then 20
    when 'heuristic' then 10
    else 0
  end;
$$;
