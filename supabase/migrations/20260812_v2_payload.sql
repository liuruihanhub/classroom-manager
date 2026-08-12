-- WorkBuddy classroom manager v2.0 payload gate.
-- Apply only after every editing device has been upgraded or taken offline.
-- Existing v1.1/v1.2 rows remain readable history; all new CAS writes must be 2.0.

create or replace function public.save_teacher_database(
  p_expected_revision bigint,
  p_payload jsonb
)
returns table (
  owner_id uuid,
  payload jsonb,
  revision bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner_id uuid := auth.uid();
  v_current public.teacher_databases%rowtype;
  v_inserted public.teacher_databases%rowtype;
  v_saved public.teacher_databases%rowtype;
begin
  if v_owner_id is null then
    raise exception using errcode = '28000', message = 'authentication_required';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid_expected_revision';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;

  if octet_length(p_payload::text) > 4194304 then
    raise exception using errcode = '22023', message = 'payload_too_large';
  end if;

  if p_payload->>'version' is distinct from '2.0'
     or jsonb_typeof(p_payload->'settings') is distinct from 'object'
     or jsonb_typeof(p_payload->'settings'->'workspaceContext') is distinct from 'object'
     or jsonb_typeof(p_payload->'settings'->'onboarding') is distinct from 'object'
     or jsonb_typeof(p_payload->'semesters') is distinct from 'array'
     or jsonb_typeof(p_payload->'classes') is distinct from 'array'
     or jsonb_typeof(p_payload->'semesterRosters') is distinct from 'array'
     or jsonb_typeof(p_payload->'courses') is distinct from 'array'
     or jsonb_typeof(p_payload->'offerings') is distinct from 'array'
     or jsonb_typeof(p_payload->'attendanceSessions') is distinct from 'array'
     or jsonb_typeof(p_payload->'scoreItems') is distinct from 'array'
     or jsonb_typeof(p_payload->'performanceEvents') is distinct from 'array'
     or jsonb_typeof(p_payload->'drawHistory') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'unsupported_payload_structure';
  end if;

  select db.* into v_current
    from public.teacher_databases as db
   where db.owner_id = v_owner_id
   for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception using errcode = '40001', message = 'revision_conflict';
    end if;
    insert into public.teacher_databases as db (owner_id, payload, revision)
    values (v_owner_id, p_payload, 1)
    on conflict (owner_id) do nothing
    returning db.* into v_inserted;
    if v_inserted.owner_id is null then
      raise exception using errcode = '40001', message = 'revision_conflict';
    end if;
    return query select v_inserted.owner_id, v_inserted.payload, v_inserted.revision, v_inserted.created_at, v_inserted.updated_at;
    return;
  end if;

  if v_current.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'revision_conflict';
  end if;

  insert into public.teacher_database_history (owner_id, payload, revision)
  values (v_current.owner_id, v_current.payload, v_current.revision)
  on conflict (owner_id, revision) do nothing;

  update public.teacher_databases as db
     set payload = p_payload,
         revision = v_current.revision + 1,
         updated_at = clock_timestamp()
   where db.owner_id = v_owner_id
  returning db.* into v_saved;

  delete from public.teacher_database_history as history
   where history.owner_id = v_owner_id
     and history.id in (
       select old.id
         from public.teacher_database_history as old
        where old.owner_id = v_owner_id
        order by old.revision desc, old.id desc
       offset 20
     );

  return query select v_saved.owner_id, v_saved.payload, v_saved.revision, v_saved.created_at, v_saved.updated_at;
end;
$function$;

revoke all on function public.save_teacher_database(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_teacher_database(bigint, jsonb)
  to authenticated;
