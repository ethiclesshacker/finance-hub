-- ============================================================
-- One person, one entity
--
-- ledger_resolve_entity() finds an entity by its normalised name, or by a
-- trigram match close to it. That works for merchants, whose names vary by a
-- suffix. It fails for people, whose names vary by everything: a bank writes
-- "MS FIRSTNAME SURNAME", an airline writes "Firstname Surname", and the person
-- who knows them writes a first name, or "Papa". None of those is within 0.82
-- similarity of another, so one father became three entities and a partner two,
-- and a question about either found a fraction of the events.
--
-- Two additions:
--
--   metadata.aliases   a list of normalised names that also mean this entity.
--                      resolve checks it between the exact match and the fuzzy
--                      one, so a nickname resolves to the person and never
--                      creates a stranger with the same nickname.
--   ledger_merge_entities()  folds a duplicate into a target: its events move,
--                      its name and aliases become aliases of the target, and it
--                      is deleted. The same shape as ledger_merge_events().
--
-- metadata.relationship ("partner", "father") is free text for readers — Hermes
-- mostly — and is not interpreted here.
--
-- Run order: after 0004_ledger_api.sql. Safe to re-run.
-- ============================================================

create or replace function public.ledger_resolve_entity(
  p_user_id         uuid,
  p_type            text,
  p_name            text,
  p_normalized_name text default null,
  p_metadata        jsonb default '{}'::jsonb
) returns uuid
language plpgsql set search_path = public, extensions, pg_temp as $$
declare
  v_norm    text := coalesce(nullif(p_normalized_name, ''), public.ledger_normalize_name(p_name));
  v_id      uuid;
  v_min_sim numeric;
  v_alias   boolean := false;
begin
  if v_norm is null or p_name is null then return null; end if;

  select id into v_id from public.entities
   where user_id = p_user_id and type = p_type and normalized_name = v_norm;

  -- A known other name for someone. Before the fuzzy match, on purpose: "papa"
  -- is nowhere near the legal name it stands for.
  if v_id is null then
    select id into v_id from public.entities
     where user_id = p_user_id and type = p_type
       and jsonb_typeof(metadata -> 'aliases') = 'array'
       and metadata -> 'aliases' ? v_norm
     limit 1;
    v_alias := v_id is not null;
  end if;

  if v_id is null then
    v_min_sim := public.ledger_setting(p_user_id, 'ledger_entity_similarity', 0.82);
    select id into v_id from public.entities
     where user_id = p_user_id and type = p_type
       and extensions.similarity(normalized_name, v_norm) >= v_min_sim
     order by extensions.similarity(normalized_name, v_norm) desc
     limit 1;
  end if;

  if v_id is null then
    insert into public.entities (user_id, type, name, normalized_name, metadata)
    values (p_user_id, p_type, p_name, v_norm, coalesce(p_metadata, '{}'::jsonb))
    on conflict (user_id, type, normalized_name) do update set name = public.entities.name
    returning id into v_id;
  else
    update public.entities
       -- An alias never renames the person: "Papa" is longer than nothing, but
       -- it is not his name.
       set name     = case when not v_alias and char_length(p_name) > char_length(name) then p_name else name end,
           metadata = metadata || (coalesce(p_metadata, '{}'::jsonb) - 'aliases')
     where id = v_id;
  end if;

  return v_id;
end;
$$;


create or replace function public.ledger_merge_entities(p_target uuid, p_duplicate uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_target public.entities%rowtype;
  v_dup    public.entities%rowtype;
  v_moved  int;
begin
  if p_target = p_duplicate then raise exception 'cannot merge an entity into itself'; end if;
  select * into v_target from public.entities where id = p_target;
  if not found then raise exception 'target entity % not found', p_target using errcode = 'P0002'; end if;
  select * into v_dup from public.entities where id = p_duplicate;
  if not found then raise exception 'duplicate entity % not found', p_duplicate using errcode = 'P0002'; end if;
  if not public.ledger_can_act_as(v_target.user_id) or v_target.user_id <> v_dup.user_id or v_target.type <> v_dup.type then
    raise exception 'not authorized, or not the same kind of entity' using errcode = '42501';
  end if;

  update public.event_entities ee set entity_id = p_target
   where ee.entity_id = p_duplicate
     and not exists (select 1 from public.event_entities t
                      where t.event_id = ee.event_id and t.entity_id = p_target and t.relationship = ee.relationship);
  get diagnostics v_moved = row_count;
  delete from public.event_entities where entity_id = p_duplicate;

  update public.entities e
     set metadata = (e.metadata || (v_dup.metadata - 'aliases')) || jsonb_build_object('aliases', (
           select coalesce(jsonb_agg(distinct a), '[]'::jsonb)
             from (select jsonb_array_elements_text(coalesce(e.metadata -> 'aliases', '[]'::jsonb)) as a
                   union select jsonb_array_elements_text(coalesce(v_dup.metadata -> 'aliases', '[]'::jsonb))
                   union select v_dup.normalized_name) s
            where a is not null and a <> e.normalized_name))
   where e.id = p_target;

  perform public.ledger_log(v_target.user_id, 'entities_merged', 'entities', p_target,
    jsonb_build_object('absorbed', to_jsonb(v_dup)), jsonb_build_object('target', p_target));

  delete from public.entities where id = p_duplicate;
  return jsonb_build_object('target', p_target, 'events_moved', v_moved);
end;
$$;

-- Add other names for an entity. Names are normalised the same way resolve normalises them.
create or replace function public.ledger_add_entity_aliases(p_entity uuid, p_aliases text[], p_metadata jsonb default '{}'::jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_entity public.entities%rowtype;
begin
  select * into v_entity from public.entities where id = p_entity;
  if not found then raise exception 'entity % not found', p_entity using errcode = 'P0002'; end if;
  if not public.ledger_can_act_as(v_entity.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.entities e
     set metadata = (e.metadata || (coalesce(p_metadata, '{}'::jsonb) - 'aliases')) || jsonb_build_object('aliases', (
           select coalesce(jsonb_agg(distinct a), '[]'::jsonb)
             from (select jsonb_array_elements_text(coalesce(e.metadata -> 'aliases', '[]'::jsonb)) as a
                   union select public.ledger_normalize_name(x) from unnest(p_aliases) x) s
            where a is not null and a <> '' and a <> e.normalized_name))
   where e.id = p_entity;

  return (select to_jsonb(e) from public.entities e where e.id = p_entity);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- A note that names someone links them
--
-- Notes follow one grammar: `Type: detail | who | when`. The segments after the
-- first are tags, and a tag that is a known person — by name or by alias — is a
-- statement that the event was for them. This trigger reads that statement and
-- records it, from whichever screen the note was written on.
--
-- It only ever links people who already exist. "Apr" and "15% off" are tags
-- too, and a trigger that created an entity for every unfamiliar word would
-- fill the ledger with people called April. Links it made are removed when the
-- note stops naming the person; links from any other source are left alone,
-- which is what the 'note' relationship is for.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_link_people_from_note()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  v_tag text;
  v_id  uuid;
  v_ids uuid[] := '{}';
begin
  if new.description is not null and position('|' in new.description) > 0 then
    foreach v_tag in array (string_to_array(new.description, '|'))[2:] loop
      v_tag := public.ledger_normalize_name(v_tag);
      continue when v_tag is null or v_tag = '';
      select e.id into v_id from public.entities e
       where e.user_id = new.user_id and e.type = 'person'
         and (e.normalized_name = v_tag
              or (jsonb_typeof(e.metadata -> 'aliases') = 'array' and e.metadata -> 'aliases' ? v_tag))
       limit 1;
      if v_id is not null then
        v_ids := v_ids || v_id;
        insert into public.event_entities (event_id, entity_id, user_id, relationship)
        values (new.id, v_id, new.user_id, 'note')
        on conflict do nothing;
      end if;
    end loop;
  end if;

  delete from public.event_entities ee
   where ee.event_id = new.id and ee.relationship = 'note' and not (ee.entity_id = any (v_ids));
  return new;
end;
$$;

drop trigger if exists ledger_link_people_from_note on public.events;
create trigger ledger_link_people_from_note
  after insert or update of description on public.events
  for each row execute function public.ledger_link_people_from_note();


do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.ledger_merge_entities(uuid, uuid)',
    'public.ledger_add_entity_aliases(uuid, text[], jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
