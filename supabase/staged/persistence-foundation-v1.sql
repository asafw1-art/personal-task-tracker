-- STAGED ONLY. Package 6a; NOT approved for Production execution.
-- Owner commands only. Legacy writers, sharing and cutover gates remain in 6b/7.
begin;
create schema if not exists persistence_v1;
revoke all on schema persistence_v1 from public, anon, authenticated;
grant usage on schema persistence_v1 to authenticated;

alter table public.tasks add column if not exists revision bigint not null default 1 check (revision > 0);
alter table public.tasks add column if not exists subtask_number_high_water bigint not null default 0 check (subtask_number_high_water >= 0);
update public.tasks t set subtask_number_high_water = greatest(t.subtask_number_high_water,
  coalesce((select max((s->>'number')::bigint) from jsonb_array_elements(t.subtasks) s
    where (s->>'number') ~ '^[1-9][0-9]{0,9}$'), 0));

create table if not exists persistence_v1.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  read_only boolean not null default true,
  write_epoch bigint not null default 1 check (write_epoch > 0),
  change_seq bigint not null default 0 check (change_seq >= 0)
);
create table if not exists persistence_v1.counters (
  user_id uuid not null references persistence_v1.accounts(user_id) on delete cascade,
  prefix text not null check (prefix in ('P','W')),
  high_water bigint not null default 0 check (high_water >= 0),
  primary key(user_id, prefix)
);
create table if not exists persistence_v1.receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload_hash text not null,
  target_id uuid,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id, operation_id)
);
insert into persistence_v1.accounts(user_id) select id from auth.users on conflict do nothing;
insert into persistence_v1.counters(user_id,prefix,high_water)
  select a.user_id,p.prefix,coalesce(max(t.task_number),0)
  from persistence_v1.accounts a cross join (values ('P'),('W')) p(prefix)
  left join public.tasks t on t.user_id=a.user_id and t.prefix=p.prefix
  group by a.user_id,p.prefix
  on conflict(user_id,prefix) do update set high_water=greatest(persistence_v1.counters.high_water,excluded.high_water);
alter table persistence_v1.accounts enable row level security;
alter table persistence_v1.counters enable row level security;
alter table persistence_v1.receipts enable row level security;
revoke all on all tables in schema persistence_v1 from public, anon, authenticated;

create or replace function persistence_v1.task_view(t public.tasks, epoch bigint) returns jsonb
language sql stable set search_path = pg_catalog, public as $$
  select jsonb_build_object('id',t.id,'prefix',t.prefix,'number',t.task_number,
    'revision',t.revision::text,'writeEpoch',epoch::text,'title',t.title,'category',t.category,
    'actionType',t.action_type,'priority',t.priority,'status',t.status,'notes',t.notes,
    'dueDate',to_char(t.due_at at time zone 'UTC','YYYY-MM-DD'),'completedAt',t.completed_at,
    'statusChangedAt',t.status_changed_at,'focused',t.focused,'subtasks',t.subtasks);
$$;

create or replace function persistence_v1.valid_patch(p jsonb, allowed text[]) returns boolean
language plpgsql immutable set search_path = pg_catalog as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k=any(allowed)) then return false; end if;
    if k in ('title','category','actionType') then
      if k='actionType' and p->k='null'::jsonb then continue; end if;
      if jsonb_typeof(p->k)<>'string' or length(btrim(p->>k))=0 or length(p->>k)>1000 then return false; end if;
    elsif k='notes' then
      if p->k<>'null'::jsonb and (jsonb_typeof(p->k)<>'string' or length(p->>k)>32000) then return false; end if;
    elsif k='priority' then
      if jsonb_typeof(p->k)<>'string' or not ((p->>k)=any(array['high','important','normal','low'])) then return false; end if;
    elsif k='prefix' then
      if jsonb_typeof(p->k)<>'string' or not ((p->>k)=any(array['P','W'])) then return false; end if;
    elsif k='dueDate' then
      if p->k='null'::jsonb then continue; end if;
      if jsonb_typeof(p->k)<>'string' or not ((p->>k) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then return false; end if;
      begin
        if to_char((p->>k)::date,'YYYY-MM-DD')<>(p->>k) then return false; end if;
      exception when datetime_field_overflow or invalid_datetime_format then return false; end;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function persistence_v1.read_task(p_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, persistence_v1 as $$
declare t public.tasks; e bigint;
begin
  if auth.uid() is null then return null; end if;
  select * into t from public.tasks where id=p_id and user_id=auth.uid();
  if not found then return null; end if;
  select write_epoch into e from persistence_v1.accounts where user_id=t.user_id;
  return persistence_v1.task_view(t,e);
end;
$$;

create or replace function persistence_v1.apply_task_command(c jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, persistence_v1 as $$
declare
  actor uuid := auth.uid(); op uuid; target uuid; kind text; fingerprint text; key text;
  expected_revision bigint; expected_epoch bigint; account persistence_v1.accounts;
  prior persistence_v1.receipts; t public.tasks; original jsonb; patch jsonb;
  outcome jsonb; next_number bigint; step jsonb; step_id text; step_index integer;
  allowed_envelope text[]; changed boolean;
begin
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if c is null or jsonb_typeof(c)<>'object' or octet_length(c::text)>65536 then
    return jsonb_build_object('status','validation_failed'); end if;
  if c->'protocolVersion' is distinct from '1'::jsonb then return jsonb_build_object('status','client_upgrade_required'); end if;
  kind := c->>'kind';
  if kind is null or not (kind=any(array['create_task','patch_task','set_task_status','set_owner_focus',
    'add_subtask','patch_subtask','remove_subtask','set_subtask_status'])) then
    return jsonb_build_object('status','validation_failed'); end if;
  allowed_envelope := array['protocolVersion','operationId','kind','expectedWriteEpoch'];
  if kind<>'create_task' then allowed_envelope := allowed_envelope || array['targetTaskUuid','expectedRevision']; end if;
  if kind in ('create_task','patch_task','add_subtask','patch_subtask') then allowed_envelope := array_append(allowed_envelope,'patch'); end if;
  if kind in ('set_task_status','set_subtask_status') then allowed_envelope := array_append(allowed_envelope,'status'); end if;
  if kind='set_owner_focus' then allowed_envelope := array_append(allowed_envelope,'focused'); end if;
  if kind in ('patch_subtask','remove_subtask','set_subtask_status') then allowed_envelope := array_append(allowed_envelope,'subtaskId'); end if;
  for key in select jsonb_object_keys(c) loop
    if not(key=any(allowed_envelope)) then return jsonb_build_object('status','validation_failed'); end if;
  end loop;
  begin
    if jsonb_typeof(c->'operationId') is distinct from 'string'
      or jsonb_typeof(c->'expectedWriteEpoch') is distinct from 'string'
      or not(coalesce(c->>'expectedWriteEpoch','') ~ '^[1-9][0-9]{0,18}$') then
      return jsonb_build_object('status','validation_failed'); end if;
    op := (c->>'operationId')::uuid; expected_epoch := (c->>'expectedWriteEpoch')::bigint;
    if kind<>'create_task' then
      if jsonb_typeof(c->'targetTaskUuid') is distinct from 'string'
        or jsonb_typeof(c->'expectedRevision') is distinct from 'string'
        or not(coalesce(c->>'expectedRevision','') ~ '^[1-9][0-9]{0,18}$') then
        return jsonb_build_object('status','validation_failed'); end if;
      target := (c->>'targetTaskUuid')::uuid; expected_revision := (c->>'expectedRevision')::bigint;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('status','validation_failed');
  end;
  fingerprint := encode(sha256(convert_to((c-'operationId')::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text || ':' || op::text,0));
  select * into account from persistence_v1.accounts where user_id=actor for update;
  if not found then return jsonb_build_object('status','account_read_only'); end if;
  select * into prior from persistence_v1.receipts where actor_id=actor and operation_id=op;
  if found then
    if prior.payload_hash<>fingerprint then return jsonb_build_object('status','idempotency_mismatch'); end if;
    if prior.target_id is null then return prior.result; end if;
    select * into t from public.tasks where id=prior.target_id and user_id=actor;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    return prior.result || jsonb_build_object('task',persistence_v1.task_view(t,account.write_epoch));
  end if;
  if not account.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  if account.read_only then return jsonb_build_object('status','account_read_only'); end if;
  if account.write_epoch<>expected_epoch then return jsonb_build_object('status','stale_epoch'); end if;
  if kind<>'create_task' then
    select * into t from public.tasks where id=target and user_id=actor for update;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if t.revision<>expected_revision then
      outcome := jsonb_build_object('status','conflict','operationId',op,'revision',t.revision::text,'writeEpoch',account.write_epoch::text);
      insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,target_id,result) values(actor,op,fingerprint,target,outcome);
      return outcome || jsonb_build_object('task',persistence_v1.task_view(t,account.write_epoch));
    end if;
  end if;
  patch := c->'patch';
  if kind in ('create_task','patch_task') then
    if not persistence_v1.valid_patch(patch,case when kind='create_task'
      then array['prefix','title','category','actionType','priority','notes','dueDate']
      else array['title','category','actionType','priority','notes','dueDate'] end) then
      return jsonb_build_object('status','validation_failed'); end if;
    if kind='create_task' and (not(patch ? 'title') or not(patch ? 'category') or not(patch ? 'prefix')) then
      return jsonb_build_object('status','validation_failed'); end if;
    if patch ? 'category' and not exists(select 1 from public.task_taxonomy_items where user_id=actor
      and item_type='topic' and prefix=case when kind='create_task' then patch->>'prefix' else t.prefix end and name=patch->>'category') then
      outcome:=jsonb_build_object('status','validation_failed','operationId',op,'writeEpoch',account.write_epoch::text);
      insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,target_id,result) values(actor,op,fingerprint,target,outcome);
      return outcome; end if;
  elsif kind in ('add_subtask','patch_subtask') then
    if not persistence_v1.valid_patch(patch,array['title','actionType'])
      or (kind='add_subtask' and not(patch ? 'title')) then return jsonb_build_object('status','validation_failed'); end if;
  end if;
  if patch ? 'actionType' and patch->'actionType'<>'null'::jsonb and not exists(select 1 from public.task_taxonomy_items
    where user_id=actor and item_type='action' and name=patch->>'actionType') then
    outcome:=jsonb_build_object('status','validation_failed','operationId',op,'writeEpoch',account.write_epoch::text);
    insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,target_id,result) values(actor,op,fingerprint,target,outcome);
    return outcome; end if;
  if kind='set_task_status' and (jsonb_typeof(c->'status') is distinct from 'string'
    or not(coalesce(c->>'status','')=any(array['open','in_progress','waiting','done','cancelled']))) then
    return jsonb_build_object('status','validation_failed'); end if;
  if kind='set_subtask_status' and (jsonb_typeof(c->'status') is distinct from 'string'
    or not(coalesce(c->>'status','')=any(array['open','done','cancelled']))) then return jsonb_build_object('status','validation_failed'); end if;
  if kind='set_owner_focus' and jsonb_typeof(c->'focused') is distinct from 'boolean' then return jsonb_build_object('status','validation_failed'); end if;
  if kind in ('patch_subtask','remove_subtask','set_subtask_status') then
    if jsonb_typeof(c->'subtaskId') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
    select value, (ordinality-1)::integer into step,step_index from jsonb_array_elements(t.subtasks) with ordinality where value->>'id'=c->>'subtaskId';
    if not found then return jsonb_build_object('status','validation_failed'); end if;
  end if;
  if kind='create_task' then
    update persistence_v1.counters set high_water=high_water+1 where user_id=actor and prefix=patch->>'prefix' returning high_water into next_number;
    if not found or next_number>2147483647 then raise exception 'Task counter unavailable or exhausted'; end if;
    insert into public.tasks(user_id,prefix,task_number,title,category,action_type,priority,notes,due_at)
      values(actor,patch->>'prefix',next_number,btrim(patch->>'title'),patch->>'category',patch->>'actionType',
        coalesce(patch->>'priority','normal')::public.task_priority,patch->>'notes',
        case when patch->>'dueDate' is null then null else ((patch->>'dueDate') || 'T12:00:00Z')::timestamptz end)
      returning * into t;
    target := t.id;
  else
    original := to_jsonb(t);
    if kind='patch_task' then
      if patch ? 'title' then t.title:=btrim(patch->>'title'); end if;
      if patch ? 'category' then t.category:=patch->>'category'; end if;
      if patch ? 'actionType' then t.action_type:=patch->>'actionType'; end if;
      if patch ? 'priority' then t.priority:=(patch->>'priority')::public.task_priority; end if;
      if patch ? 'notes' then t.notes:=patch->>'notes'; end if;
      if patch ? 'dueDate' then t.due_at:=case when patch->>'dueDate' is null then null else ((patch->>'dueDate') || 'T12:00:00Z')::timestamptz end; end if;
    elsif kind='set_task_status' then t.status:=(c->>'status')::public.task_status;
    elsif kind='set_owner_focus' then t.focused:=(c->>'focused')::boolean;
    elsif kind='add_subtask' then
      t.subtask_number_high_water:=t.subtask_number_high_water+1;
      if t.subtask_number_high_water>2147483647 then raise exception 'Subtask counter exhausted'; end if;
      step_id:=gen_random_uuid()::text;
      t.subtasks:=t.subtasks || jsonb_build_array(jsonb_build_object('id',step_id,'number',t.subtask_number_high_water,
        'title',btrim(patch->>'title'),'status','open','createdAt',now()) || case when patch ? 'actionType' then jsonb_build_object('actionType',patch->'actionType') else '{}'::jsonb end);
    elsif kind='remove_subtask' then t.subtasks:=t.subtasks-step_index;
    elsif kind='patch_subtask' then
      if patch ? 'title' then step:=step || jsonb_build_object('title',btrim(patch->>'title')); end if;
      if patch ? 'actionType' then step:=step || jsonb_build_object('actionType',patch->'actionType'); end if;
      t.subtasks:=jsonb_set(t.subtasks,array[step_index::text],step);
    elsif kind='set_subtask_status' then
      if step->>'status'<>c->>'status' then
        step:=step || jsonb_build_object('status',c->>'status','statusChangedAt',now());
        t.subtasks:=jsonb_set(t.subtasks,array[step_index::text],step);
      end if;
    end if;
    if t.status='open' and exists(select 1 from jsonb_array_elements(t.subtasks) s where s->>'status'='done') then t.status:='in_progress'; end if;
    if t.status::text<>original->>'status' then
      t.status_changed_at:=now();
      t.completed_at:=case when t.status='done' then now() else null end;
    end if;
    changed := to_jsonb(t) is distinct from original;
    if changed then
      t.revision:=t.revision+1;
      update public.tasks set title=t.title,category=t.category,action_type=t.action_type,priority=t.priority,status=t.status,
        notes=t.notes,due_at=t.due_at,completed_at=t.completed_at,status_changed_at=t.status_changed_at,
        focused=t.focused,subtasks=t.subtasks,subtask_number_high_water=t.subtask_number_high_water,
        revision=t.revision,updated_at=now() where id=target returning * into t;
    end if;
  end if;
  if kind='create_task' or changed then update persistence_v1.accounts set change_seq=change_seq+1 where user_id=actor; end if;
  outcome:=jsonb_build_object('status','committed','operationId',op,'targetTaskUuid',target,'revision',t.revision::text,'writeEpoch',account.write_epoch::text);
  insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,target_id,result) values(actor,op,fingerprint,target,outcome);
  return outcome || jsonb_build_object('task',persistence_v1.task_view(t,account.write_epoch));
end;
$$;

revoke all on all functions in schema persistence_v1 from public, anon, authenticated;
grant execute on function persistence_v1.apply_task_command(jsonb), persistence_v1.read_task(uuid) to authenticated;
commit;
