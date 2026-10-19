-- STAGED ONLY. Operational restore remains a maintenance operation, never client DML.
begin;
create or replace function public.persistence_export_account_v1(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare payload jsonb:='{}'; controls jsonb:='{}'; rows jsonb; name text; owner_column text;
begin
  if not exists(select 1 from auth.users where id=p_user_id) then raise exception 'Unknown account'; end if;
  foreach name in array array['tasks','task_taxonomy_items','user_settings','task_shares','task_subtask_assignments','assistant_threads','assistant_messages','assistant_actions','notification_receipts','user_devices'] loop
    owner_column:=case when name in ('task_shares','task_subtask_assignments') then 'owner_user_id' else 'user_id' end;
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t where %I=$1',name,owner_column) into rows using p_user_id;
    payload:=payload||jsonb_build_object(name,rows);
  end loop;
  payload:=jsonb_set(payload,'{tasks}',(select coalesce(jsonb_agg(v||jsonb_build_object('revision',v->>'revision','subtask_number_high_water',v->>'subtask_number_high_water')),'[]'::jsonb) from jsonb_array_elements(payload->'tasks') v));
  payload:=jsonb_set(payload,'{task_shares}',(select coalesce(jsonb_agg(v||jsonb_build_object('revision',v->>'revision')),'[]'::jsonb) from jsonb_array_elements(payload->'task_shares') v));
  foreach name in array array['accounts','counters','receipts','proposals','proposal_executions','domain_versions'] loop
    owner_column:=case when name in ('receipts','proposals','proposal_executions') then 'actor_id' else 'user_id' end;
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from persistence_v1.%I t where %I=$1',name,owner_column) into rows using p_user_id;
    if name='accounts' then rows:=(select coalesce(jsonb_agg(v||jsonb_build_object('write_epoch',v->>'write_epoch','change_seq',v->>'change_seq')),'[]'::jsonb) from jsonb_array_elements(rows) v);
    elsif name='counters' then rows:=(select coalesce(jsonb_agg(v||jsonb_build_object('high_water',v->>'high_water')),'[]'::jsonb) from jsonb_array_elements(rows) v);
    elsif name='domain_versions' then rows:=(select coalesce(jsonb_agg(v||jsonb_build_object('revision',v->>'revision')),'[]'::jsonb) from jsonb_array_elements(rows) v); end if;
    controls:=controls||jsonb_build_object(name,rows);
  end loop;
  return jsonb_build_object('format','task-tracker-account-recovery','version',2,'owner_user_id',p_user_id,
    'captured_at',statement_timestamp(),'data',payload,'persistence',controls,
    'columns',(select jsonb_object_agg(table_schema||'.'||table_name,cols) from
      (select table_schema,table_name,jsonb_agg(column_name order by ordinal_position) cols from information_schema.columns
       where (table_schema='public' and payload ? table_name) or (table_schema='persistence_v1' and controls ? table_name) group by table_schema,table_name) c));
end $$;

create or replace function public.persistence_restore_account_v1(p_user_id uuid,p_snapshot jsonb,p_operation_id uuid,p_expected_epoch text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a persistence_v1.accounts; r persistence_v1.receipts; item jsonb; task public.tasks; previous public.tasks;
  fingerprint text; result jsonb; prefix_value text; floor_value bigint; rev bigint;
begin
  if p_operation_id is null or p_snapshot->>'owner_user_id' is distinct from p_user_id::text
    or p_snapshot->>'format' is distinct from 'task-tracker-account-recovery' or p_snapshot->'version' is distinct from '2'::jsonb
    or jsonb_typeof(p_snapshot#>'{data,tasks}') is distinct from 'array'
    or jsonb_typeof(p_snapshot#>'{persistence,counters}') is distinct from 'array' then raise exception 'Incompatible recovery snapshot'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('kind','maintenance_restore','snapshot',p_snapshot)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_operation_id::text,0));
  select * into a from persistence_v1.accounts where user_id=p_user_id for update;
  if not found or not a.enabled then raise exception 'Restore requires an enabled account'; end if;
  select * into r from persistence_v1.receipts where actor_id=p_user_id and operation_id=p_operation_id;
  if found then
    if r.payload_hash<>fingerprint then raise exception 'Restore operation mismatch'; end if;
    return r.result;
  end if;
  if not a.read_only then raise exception 'Restore requires maintenance'; end if;
  if a.write_epoch::text is distinct from p_expected_epoch then raise exception 'Stale restore epoch'; end if;
  if (public.persistence_export_account_v1(p_user_id)->'columns') is distinct from p_snapshot->'columns' then raise exception 'Recovery schema drift'; end if;
  -- No deleted share/assignment is recreated. Existing history not in the snapshot is cancelled, not erased.
  update public.tasks t set status='cancelled',completed_at=null,status_changed_at=now(),revision=revision+1,updated_at=now()
    where user_id=p_user_id and not exists(select 1 from jsonb_array_elements(p_snapshot#>'{data,tasks}') v where v->>'id'=t.id::text);
  for item in select value from jsonb_array_elements(p_snapshot#>'{data,tasks}') loop
    if item-(select array_agg(v) from jsonb_array_elements_text(p_snapshot#>'{columns,public.tasks}') v)<>'{}'::jsonb then raise exception 'Unknown recovery column'; end if;
    select * into task from jsonb_populate_record(null::public.tasks,item);
    if task.user_id is distinct from p_user_id then raise exception 'Foreign recovery row'; end if;
    select * into previous from public.tasks where id=task.id for update;
    if found and (previous.user_id<>p_user_id or previous.prefix<>task.prefix or previous.task_number<>task.task_number) then raise exception 'Recovery identity mismatch'; end if;
    rev:=greatest(coalesce(previous.revision,0),coalesce(task.revision,0),coalesce((select max((receipt.result->>'revision')::bigint) from persistence_v1.receipts receipt where receipt.target_id=task.id and receipt.result->>'revision'~'^[0-9]+$'),0))+1;
    task.subtask_number_high_water:=greatest(coalesce(previous.subtask_number_high_water,0),coalesce(task.subtask_number_high_water,0),coalesce((select max((s->>'number')::integer) from jsonb_array_elements(task.subtasks) s),0));
    insert into public.tasks(id,user_id,prefix,task_number,title,category,action_type,priority,status,notes,due_at,created_at,completed_at,status_changed_at,focused,subtasks,revision,subtask_number_high_water)
      values(task.id,p_user_id,task.prefix,task.task_number,task.title,task.category,task.action_type,task.priority,task.status,task.notes,task.due_at,task.created_at,task.completed_at,task.status_changed_at,task.focused,task.subtasks,rev,task.subtask_number_high_water)
      on conflict(id) do update set title=excluded.title,category=excluded.category,action_type=excluded.action_type,priority=excluded.priority,status=excluded.status,notes=excluded.notes,
      due_at=excluded.due_at,completed_at=excluded.completed_at,status_changed_at=excluded.status_changed_at,focused=excluded.focused,subtasks=excluded.subtasks,revision=excluded.revision,
      subtask_number_high_water=excluded.subtask_number_high_water,updated_at=now();
  end loop;
  delete from public.task_taxonomy_items where user_id=p_user_id;
  insert into public.task_taxonomy_items(user_id,item_type,prefix,name)
    select p_user_id,v->>'item_type',v->>'prefix',v->>'name' from jsonb_array_elements(p_snapshot#>'{data,task_taxonomy_items}') v;
  insert into public.task_taxonomy_items(user_id,item_type,prefix,name)
    select p_user_id,'topic',prefix,category from public.tasks where user_id=p_user_id group by prefix,category on conflict do nothing;
  insert into public.task_taxonomy_items(user_id,item_type,prefix,name)
    select distinct p_user_id,'action',null,name from (
      select action_type name from public.tasks where user_id=p_user_id union select s->>'actionType' from public.tasks t cross join jsonb_array_elements(t.subtasks) s where t.user_id=p_user_id
    ) names where nullif(name,'') is not null on conflict do nothing;
  item:=p_snapshot#>'{data,user_settings,0}';
  if item is not null then
    insert into public.user_settings(user_id,display_name,notification_preferences,analytics_preferences,theme)
      values(p_user_id,item->>'display_name',item->'notification_preferences',item->'analytics_preferences',item->>'theme')
      on conflict(user_id) do update set display_name=excluded.display_name,notification_preferences=excluded.notification_preferences,analytics_preferences=excluded.analytics_preferences,theme=excluded.theme,updated_at=now();
  end if;
  foreach prefix_value in array array['P','W'] loop
    select max((v->>'high_water')::bigint) into floor_value from jsonb_array_elements(p_snapshot#>'{persistence,counters}') v where v->>'prefix'=prefix_value and v->>'user_id'=p_user_id::text;
    if floor_value is null then raise exception 'Missing historical numbering floor'; end if;
    floor_value:=greatest(floor_value,coalesce((select max(task_number) from public.tasks where user_id=p_user_id and prefix=prefix_value),0));
    insert into persistence_v1.counters(user_id,prefix,high_water) values(p_user_id,prefix_value,floor_value)
      on conflict(user_id,prefix) do update set high_water=greatest(persistence_v1.counters.high_water,excluded.high_water);
  end loop;
  insert into persistence_v1.domain_versions(user_id,domain,revision) values(p_user_id,'settings',2),(p_user_id,'taxonomy',2)
    on conflict(user_id,domain) do update set revision=persistence_v1.domain_versions.revision+1;
  update persistence_v1.accounts set write_epoch=write_epoch+1,change_seq=change_seq+1 where user_id=p_user_id returning * into a;
  result:=jsonb_build_object('status','committed','domain','restore','operationId',p_operation_id,'writeEpoch',a.write_epoch::text,'taskCount',jsonb_array_length(p_snapshot#>'{data,tasks}'));
  insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,result) values(p_user_id,p_operation_id,fingerprint,result);
  return result;
end $$;
create or replace function public.persistence_export_self_v1() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if auth.uid() is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if not exists(select 1 from persistence_v1.accounts where user_id=auth.uid() and enabled) then return jsonb_build_object('status','client_upgrade_required'); end if;
  return jsonb_build_object('status','backup','snapshot',public.persistence_export_account_v1(auth.uid()));
end $$;
revoke all on function public.persistence_export_account_v1(uuid),public.persistence_restore_account_v1(uuid,jsonb,uuid,text),public.persistence_export_self_v1() from public,anon,authenticated;
grant execute on function public.persistence_export_self_v1() to authenticated;
grant execute on function public.persistence_export_account_v1(uuid),public.persistence_restore_account_v1(uuid,jsonb,uuid,text) to service_role;
commit;
