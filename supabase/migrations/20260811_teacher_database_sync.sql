-- WorkBuddy classroom manager v1.2
-- One authenticated teacher owns one revisioned JSON document.
-- Safe to run repeatedly in a Supabase project.

begin;

create table if not exists public.teacher_databases (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teacher_databases_payload_is_object
    check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.teacher_database_history (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  revision bigint not null check (revision >= 0),
  archived_at timestamptz not null default now(),
  constraint teacher_database_history_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint teacher_database_history_owner_revision_key
    unique (owner_id, revision)
);

create index if not exists teacher_database_history_owner_archived_idx
  on public.teacher_database_history (owner_id, archived_at desc);

alter table public.teacher_databases enable row level security;
alter table public.teacher_database_history enable row level security;
alter table public.teacher_databases force row level security;
alter table public.teacher_database_history force row level security;
alter table public.teacher_databases replica identity full;

drop policy if exists teacher_databases_select_own on public.teacher_databases;
create policy teacher_databases_select_own
  on public.teacher_databases
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists teacher_database_history_select_own
  on public.teacher_database_history;
create policy teacher_database_history_select_own
  on public.teacher_database_history
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

-- There are deliberately no INSERT, UPDATE, or DELETE policies. Browser writes
-- can only pass through the authenticated CAS function below.
revoke all on table public.teacher_databases from public, anon, authenticated;
revoke all on table public.teacher_database_history from public, anon, authenticated;
grant select on table public.teacher_databases to authenticated;
grant select on table public.teacher_database_history to authenticated;

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
    raise exception using
      errcode = '28000',
      message = 'authentication_required';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_expected_revision';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'invalid_payload';
  end if;

  -- Reject oversized or obviously incompatible documents before acquiring the
  -- row lock. The browser still performs the complete validateDatabase check.
  if octet_length(p_payload::text) > 4194304 then
    raise exception using
      errcode = '22023',
      message = 'payload_too_large';
  end if;

  if p_payload->>'version' is distinct from '1.1'
     or jsonb_typeof(p_payload->'settings') is distinct from 'object'
     or jsonb_typeof(p_payload->'semesters') is distinct from 'array'
     or jsonb_typeof(p_payload->'classes') is distinct from 'array'
     or jsonb_typeof(p_payload->'semesterRosters') is distinct from 'array'
     or jsonb_typeof(p_payload->'courses') is distinct from 'array'
     or jsonb_typeof(p_payload->'offerings') is distinct from 'array'
     or jsonb_typeof(p_payload->'attendanceSessions') is distinct from 'array'
     or jsonb_typeof(p_payload->'scoreItems') is distinct from 'array'
     or jsonb_typeof(p_payload->'performanceEvents') is distinct from 'array'
     or jsonb_typeof(p_payload->'drawHistory') is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'unsupported_payload_structure';
  end if;

  select db.*
    into v_current
    from public.teacher_databases as db
   where db.owner_id = v_owner_id
   for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception using
        errcode = '40001',
        message = 'revision_conflict';
    end if;

    insert into public.teacher_databases as db (
      owner_id,
      payload,
      revision
    )
    values (
      v_owner_id,
      p_payload,
      1
    )
    on conflict (owner_id) do nothing
    returning db.* into v_inserted;

    if v_inserted.owner_id is null then
      raise exception using
        errcode = '40001',
        message = 'revision_conflict';
    end if;

    return query
      select
        v_inserted.owner_id,
        v_inserted.payload,
        v_inserted.revision,
        v_inserted.created_at,
        v_inserted.updated_at;
    return;
  end if;

  if v_current.revision <> p_expected_revision then
    raise exception using
      errcode = '40001',
      message = 'revision_conflict';
  end if;

  -- Archive the last valid state in the same transaction, before overwriting it.
  insert into public.teacher_database_history (
    owner_id,
    payload,
    revision
  )
  values (
    v_current.owner_id,
    v_current.payload,
    v_current.revision
  )
  on conflict (owner_id, revision) do nothing;

  update public.teacher_databases as db
     set payload = p_payload,
         revision = v_current.revision + 1,
         updated_at = clock_timestamp()
   where db.owner_id = v_owner_id
  returning db.* into v_saved;

  -- Retain the latest 20 archived versions per teacher. The current version is
  -- stored only in teacher_databases and is therefore not counted here.
  delete from public.teacher_database_history as history
   where history.owner_id = v_owner_id
     and history.id in (
       select old.id
         from public.teacher_database_history as old
        where old.owner_id = v_owner_id
        order by old.revision desc, old.id desc
       offset 20
     );

  return query
    select
      v_saved.owner_id,
      v_saved.payload,
      v_saved.revision,
      v_saved.created_at,
      v_saved.updated_at;
end;
$function$;

revoke all on function public.save_teacher_database(bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_teacher_database(bigint, jsonb)
  to authenticated;

-- Supabase Realtime listens only to the current document. History is excluded.
do $block$
begin
  if exists (
    select 1
      from pg_catalog.pg_publication
     where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
      from pg_catalog.pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'teacher_databases'
  ) then
    alter publication supabase_realtime add table public.teacher_databases;
  end if;
end;
$block$;

commit;
