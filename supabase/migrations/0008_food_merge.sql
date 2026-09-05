-- ============================================================
-- Merge two dishes, retroactively
--
-- "Cheese Slice" and "Cheese Slices" are one thing that two receipts spelled
-- two ways. The dictionary keyed them apart, so the ranking counted them apart
-- and one of them was priced twice. Merging is a rewrite of the past, not a
-- pointer: every meal that named the duplicate is edited to name the target,
-- so the rollup, the ranking and the "times eaten" count all agree from the
-- first receipt onward. The events trigger records each edit in the audit
-- log, and the merge itself is logged once against the target.
--
-- The duplicate row is deleted. If the target had no numbers and the
-- duplicate did, the target inherits them first — merging into the better
-- spelling must not throw away the only calories anyone had.
-- ============================================================

create or replace function public.food_merge_items(
  p_user_id      uuid,
  p_target_id    uuid,
  p_duplicate_id uuid
)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user    uuid := coalesce(p_user_id, auth.uid());
  v_target  public.food_items;
  v_dup     public.food_items;
  v_events  integer := 0;
  v_items   integer := 0;
  r         record;
  v_item    jsonb;
  v_arr     jsonb;
  v_changed boolean;
  v_title   text;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  if p_target_id is null or p_duplicate_id is null then
    raise exception 'both dishes are required' using errcode = '22023';
  end if;
  if p_target_id = p_duplicate_id then
    raise exception 'a dish cannot be merged into itself' using errcode = '22023';
  end if;

  select * into v_target from public.food_items where id = p_target_id and user_id = v_user;
  if not found then
    raise exception 'target dish not found' using errcode = 'P0002';
  end if;
  select * into v_dup from public.food_items where id = p_duplicate_id and user_id = v_user;
  if not found then
    raise exception 'duplicate dish not found' using errcode = 'P0002';
  end if;

  -- Every meal that named the duplicate, by normalized name, which is how the
  -- rollup keys a line item to a dish.
  for r in
    select e.id, e.title, e.data
      from public.events e
     where e.user_id = v_user
       and jsonb_typeof(e.data -> 'items') = 'array'
       and exists (
         select 1 from jsonb_array_elements(e.data -> 'items') it
          where public.ledger_normalize_name(nullif(btrim(it ->> 'name'), '')) = v_dup.normalized_name)
  loop
    v_arr := '[]'::jsonb;
    v_changed := false;
    for v_item in select value from jsonb_array_elements(r.data -> 'items') loop
      if public.ledger_normalize_name(nullif(btrim(v_item ->> 'name'), '')) = v_dup.normalized_name then
        v_item := v_item || jsonb_build_object('name', v_target.display_name);
        v_items := v_items + 1;
        v_changed := true;
      end if;
      v_arr := v_arr || jsonb_build_array(v_item);
    end loop;

    if v_changed then
      -- A title built from the basket names the old spelling; fix that too,
      -- but only where the old spelling actually appears.
      v_title := r.title;
      if coalesce(r.title, '') <> '' and position(v_dup.display_name in r.title) > 0 then
        v_title := replace(r.title, v_dup.display_name, v_target.display_name);
      end if;
      update public.events
         set data = jsonb_set(data, '{items}', v_arr),
             title = v_title
       where id = r.id;
      v_events := v_events + 1;
    end if;
  end loop;

  if v_target.kcal is null and v_dup.kcal is not null then
    update public.food_items set
      kcal       = v_dup.kcal,
      protein_g  = coalesce(protein_g, v_dup.protein_g),
      carbs_g    = coalesce(carbs_g,   v_dup.carbs_g),
      fat_g      = coalesce(fat_g,     v_dup.fat_g),
      portion_g  = coalesce(portion_g, v_dup.portion_g),
      category   = coalesce(category,  v_dup.category),
      source     = v_dup.source,
      confidence = v_dup.confidence,
      source_ref = coalesce(v_dup.source_ref, '{}'::jsonb)
                   || jsonb_build_object('inherited_from', v_dup.display_name, 'at', now())
     where id = v_target.id;
  end if;

  delete from public.food_items where id = v_dup.id;

  insert into public.ledger_audit_log (user_id, actor, action, table_name, record_id, before, after)
  values (
    v_user, public.ledger_actor(), 'dish_merged', 'food_items', v_target.id,
    jsonb_build_object('duplicate', to_jsonb(v_dup)),
    jsonb_build_object('target', v_target.display_name, 'events_updated', v_events, 'items_renamed', v_items)
  );

  return jsonb_build_object(
    'target_id',      v_target.id,
    'target',         v_target.display_name,
    'duplicate',      v_dup.display_name,
    'events_updated', v_events,
    'items_renamed',  v_items
  );
end;
$$;

revoke all on function public.food_merge_items(uuid, uuid, uuid) from anon;
grant execute on function public.food_merge_items(uuid, uuid, uuid) to authenticated, service_role;
