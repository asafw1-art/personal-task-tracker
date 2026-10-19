-- STAGED ONLY: apply after the sharing/assistant schemas, foundation and transport.
-- No Production execution or cutover is authorized by this file.
begin;
alter table public.task_shares add column if not exists revision bigint not null default 1 check(revision>0);
alter table public.assistant_messages add column if not exists persistence_epoch bigint;
create table if not exists persistence_v1.proposals (
  message_id uuid primary key references public.assistant_messages(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  source_hash text not null,
  command jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists persistence_v1.proposal_executions (
  -- Keep the execution identity after chat retention removes its source message.
  message_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  result jsonb not null,
  foreign key(actor_id,operation_id) references persistence_v1.receipts(actor_id,operation_id) deferrable initially deferred
);
alter table persistence_v1.proposals enable row level security;
alter table persistence_v1.proposal_executions enable row level security;
revoke all on persistence_v1.proposals,persistence_v1.proposal_executions from public,anon,authenticated;

create or replace function persistence_v1.can_read_task(p_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog as $$
  select auth.uid() is not null and exists(select 1 from public.tasks t where t.id=p_id and
    (t.user_id=auth.uid() or exists(select 1 from public.task_shares s where s.task_id=t.id and s.status='accepted'
      and (s.shared_with_user_id=auth.uid() or s.shared_with_email=lower(coalesce(auth.jwt()->>'email',''))))));
$$;
create or replace function persistence_v1.read_task(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare t public.tasks; epoch bigint;
begin
  if not persistence_v1.can_read_task(p_id) then return null; end if;
  select * into t from public.tasks where id=p_id;
  select write_epoch into epoch from persistence_v1.accounts where user_id=t.user_id;
  return persistence_v1.task_view(t,epoch);
end;
$$;

create or replace function persistence_v1.prepare_proposal(c jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a persistence_v1.accounts; m public.assistant_messages; t public.tasks; p persistence_v1.proposals;
  inner_command jsonb; action jsonb; fingerprint text; message_uuid uuid; target uuid; step_id text; k text;
begin
  if auth.uid() is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if jsonb_typeof(c)<>'object' or octet_length(c::text)>65536 then return jsonb_build_object('status','validation_failed'); end if;
  for k in select jsonb_object_keys(c) loop
    if not(k=any(array['protocolVersion','operationId','kind','messageId','targetTaskUuid','expectedRevision','expectedWriteEpoch'])) then
      return jsonb_build_object('status','validation_failed'); end if;
  end loop;
  begin
    if c->'protocolVersion' is distinct from '1'::jsonb or c->>'kind'<>'prepare_ai_proposal' then return jsonb_build_object('status','validation_failed'); end if;
    perform (c->>'operationId')::uuid;
    message_uuid:=(c->>'messageId')::uuid;
    if message_uuid is null or jsonb_typeof(c->'operationId') is distinct from 'string'
      or jsonb_typeof(c->'messageId') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
  exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
  select * into a from persistence_v1.accounts where user_id=auth.uid() for update;
  if not found or not a.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  if a.read_only then return jsonb_build_object('status','account_read_only'); end if;
  if jsonb_typeof(c->'expectedWriteEpoch') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
  if c->>'expectedWriteEpoch' is distinct from a.write_epoch::text then return jsonb_build_object('status','stale_epoch'); end if;
  select msg.* into m from public.assistant_messages msg join public.assistant_threads th on th.id=msg.thread_id
    where msg.id=message_uuid and msg.user_id=auth.uid() and th.user_id=auth.uid() and msg.role='assistant'
      and th.deleted_at is null and th.archived_at is null and msg.proposed_action is not null for update of msg;
  if not found or m.action_status is distinct from 'proposed' or m.persistence_epoch is distinct from a.write_epoch then
    return jsonb_build_object('status','not_found_or_forbidden'); end if;
  action:=m.proposed_action;
  if jsonb_typeof(action)<>'object' or octet_length(action::text)>60000 then return jsonb_build_object('status','validation_failed'); end if;
  fingerprint:=encode(sha256(convert_to(action::text,'UTF8')),'hex');
  if action->>'type'='create_task' then
    if c ? 'targetTaskUuid' or c ? 'expectedRevision' then return jsonb_build_object('status','validation_failed'); end if;
    inner_command:=jsonb_build_object('protocolVersion',1,'kind','create_task','expectedWriteEpoch',a.write_epoch::text,
      'patch',jsonb_build_object('prefix',coalesce(action#>>'{task,prefix}','P'),'category',coalesce(action#>>'{task,category}','אישי')) || (action->'task'));
  else
    begin target:=(c->>'targetTaskUuid')::uuid;
    exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
    select * into t from public.tasks where id=target and user_id=auth.uid() for update;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if jsonb_typeof(c->'expectedRevision') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
    if c->>'expectedRevision' is distinct from t.revision::text then return jsonb_build_object('status','conflict','task',persistence_v1.task_view(t,a.write_epoch)); end if;
    if upper(regexp_replace(coalesce(action->>'taskId',''),'[-[:space:]]','','g')) !~ '^[PW]0*[1-9][0-9]*$'
      or regexp_replace(upper(action->>'taskId'),'^([PW])[-[:space:]]?0*([0-9]+)$','\1\2')<>t.prefix||t.task_number::text then
      return jsonb_build_object('status','validation_failed'); end if;
    inner_command:=jsonb_build_object('protocolVersion',1,'expectedWriteEpoch',a.write_epoch::text,
      'targetTaskUuid',t.id,'expectedRevision',t.revision::text);
    if action->>'type'='update_task_status' then inner_command:=inner_command||jsonb_build_object('kind','set_task_status','status',action->'status');
    elsif action->>'type'='add_subtask' then inner_command:=inner_command||jsonb_build_object('kind','add_subtask','patch',action->'subtask');
    elsif action->>'type'='update_subtask_status' then
      select s->>'id' into step_id from jsonb_array_elements(t.subtasks) s where s->'number'=action->'subtaskNumber';
      if not found then return jsonb_build_object('status','validation_failed'); end if;
      inner_command:=inner_command||jsonb_build_object('kind','set_subtask_status','subtaskId',step_id,'status',action->'status');
    else return jsonb_build_object('status','validation_failed'); end if;
  end if;
  if inner_command->>'kind'='create_task' and (not persistence_v1.valid_patch(inner_command->'patch',array['prefix','title','category','actionType','priority','notes','dueDate'])
    or not((inner_command->'patch') ?& array['title','category','prefix'])) then return jsonb_build_object('status','validation_failed'); end if;
  if inner_command->>'kind'='add_subtask' and (not persistence_v1.valid_patch(inner_command->'patch',array['title','actionType'])
    or not(coalesce(inner_command->'patch','{}'::jsonb) ? 'title')) then return jsonb_build_object('status','validation_failed'); end if;
  if inner_command->>'kind'='set_task_status' and (jsonb_typeof(inner_command->'status') is distinct from 'string'
    or not(coalesce(inner_command->>'status','')=any(array['open','in_progress','waiting','done','cancelled']))) then
    return jsonb_build_object('status','validation_failed'); end if;
  if inner_command->>'kind'='set_subtask_status' and (jsonb_typeof(inner_command->'status') is distinct from 'string'
    or not(coalesce(inner_command->>'status','')=any(array['open','done','cancelled']))) then
    return jsonb_build_object('status','validation_failed'); end if;
  select * into p from persistence_v1.proposals where message_id=m.id;
  if found and (p.source_hash<>fingerprint or p.command<>inner_command) then return jsonb_build_object('status','conflict'); end if;
  insert into persistence_v1.proposals(message_id,actor_id,source_hash,command) values(m.id,auth.uid(),fingerprint,inner_command) on conflict do nothing;
  return jsonb_build_object('status','prepared','operationId',c->>'operationId','proposalId',m.id,'commandPreview',inner_command);
end;
$$;

create or replace function persistence_v1.collaboration_command(c jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare
  actor uuid:=auth.uid(); op uuid; target uuid; owner_id uuid; k text; kind text; fingerprint text;
  t public.tasks; a persistence_v1.accounts; r persistence_v1.receipts; s public.task_shares;
  proposal persistence_v1.proposals; execution persistence_v1.proposal_executions; m public.assistant_messages;
  outcome jsonb; step jsonb; idx integer; expected_revision bigint; expected_epoch bigint;
  changed boolean:=true; step_status public.task_status; allowed text[];
begin
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if c is null or jsonb_typeof(c)<>'object' or octet_length(c::text)>65536 then return jsonb_build_object('status','validation_failed'); end if;
  kind:=c->>'kind';
  if kind='prepare_ai_proposal' then return persistence_v1.prepare_proposal(c); end if;
  if kind not in ('apply_ai_proposal','invite_share','accept_share','decline_share','revoke_share','leave_share',
    'assign_subtask','unassign_subtask','set_shared_focus','set_subtask_status') or kind is null then
    return persistence_v1.apply_task_command(c);
  end if;
  if kind='set_subtask_status' and exists(select 1 from public.tasks where id::text=lower(c->>'targetTaskUuid') and user_id=actor) then
    return persistence_v1.apply_task_command(c); end if;
  if c->'protocolVersion' is distinct from '1'::jsonb then return jsonb_build_object('status','client_upgrade_required'); end if;
  allowed:=array['protocolVersion','operationId','kind','expectedWriteEpoch','expectedRevision','targetTaskUuid'];
  if kind='apply_ai_proposal' then allowed:=allowed||array['proposalId'];
  elsif kind='invite_share' then allowed:=allowed||array['email','role'];
  elsif kind in ('assign_subtask','unassign_subtask') then allowed:=allowed||array['shareId','subtaskId'];
  elsif kind='set_subtask_status' then allowed:=allowed||array['subtaskId','status'];
  else allowed:=allowed||array['shareId']; end if;
  if kind='set_shared_focus' then allowed:=allowed||array['focused','expectedShareRevision']; end if;
  for k in select jsonb_object_keys(c) loop if not(k=any(allowed)) then return jsonb_build_object('status','validation_failed'); end if; end loop;
  begin
    if jsonb_typeof(c->'operationId') is distinct from 'string' or jsonb_typeof(c->'expectedWriteEpoch') is distinct from 'string'
      or not(coalesce(c->>'expectedWriteEpoch','')~'^[1-9][0-9]{0,18}$') then return jsonb_build_object('status','validation_failed'); end if;
    op:=(c->>'operationId')::uuid; expected_epoch:=(c->>'expectedWriteEpoch')::bigint;
    if kind<>'apply_ai_proposal' or c ? 'targetTaskUuid' then
      if jsonb_typeof(c->'targetTaskUuid') is distinct from 'string' or jsonb_typeof(c->'expectedRevision') is distinct from 'string'
        or not(coalesce(c->>'expectedRevision','')~'^[1-9][0-9]{0,18}$') then return jsonb_build_object('status','validation_failed'); end if;
      target:=(c->>'targetTaskUuid')::uuid; expected_revision:=(c->>'expectedRevision')::bigint;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('status','validation_failed'); end;
  fingerprint:=encode(sha256(convert_to((c-'operationId')::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||op::text,0));
  if kind='apply_ai_proposal' then
    owner_id:=actor;
  else
    select user_id into owner_id from public.tasks where id=target;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if owner_id<>actor and not exists(select 1 from public.task_shares where task_id=target
      and (shared_with_user_id=actor or shared_with_email=lower(coalesce(auth.jwt()->>'email','')))
      and (status='accepted' or (kind in ('accept_share','decline_share') and status='pending' and id::text=c->>'shareId'))) then
      return jsonb_build_object('status','not_found_or_forbidden'); end if;
  end if;
  select * into a from persistence_v1.accounts where user_id=owner_id for update;
  if not found or not a.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  if kind<>'apply_ai_proposal' then
    select * into t from public.tasks where id=target and user_id=owner_id for update;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if owner_id<>actor and not exists(select 1 from public.task_shares where task_id=target
      and (shared_with_user_id=actor or shared_with_email=lower(coalesce(auth.jwt()->>'email','')))
      and (status='accepted' or (kind in ('accept_share','decline_share') and status='pending' and id::text=c->>'shareId'))) then
      return jsonb_build_object('status','not_found_or_forbidden'); end if;
  end if;
  select * into r from persistence_v1.receipts where actor_id=actor and operation_id=op;
  if found then
    if r.payload_hash<>fingerprint then return jsonb_build_object('status','idempotency_mismatch'); end if;
    if r.target_id is null then return r.result; end if;
    if not persistence_v1.can_read_task(r.target_id) then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    return r.result||jsonb_build_object('task',persistence_v1.read_task(r.target_id));
  end if;
  if a.read_only then return jsonb_build_object('status','account_read_only'); end if;
  if a.write_epoch<>expected_epoch then return jsonb_build_object('status','stale_epoch'); end if;
  if kind='apply_ai_proposal' then
    begin
      select * into proposal from persistence_v1.proposals where message_id=(c->>'proposalId')::uuid and actor_id=actor for update;
    exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    select msg.* into m from public.assistant_messages msg join public.assistant_threads th on th.id=msg.thread_id
      where msg.id=proposal.message_id and msg.user_id=actor and th.user_id=actor and th.archived_at is null and th.deleted_at is null for update of msg;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if proposal.command->>'expectedWriteEpoch' is distinct from expected_epoch::text
      or proposal.command->>'targetTaskUuid' is distinct from c->>'targetTaskUuid'
      or proposal.command->>'expectedRevision' is distinct from c->>'expectedRevision' then
      return jsonb_build_object('status','validation_failed'); end if;
    select * into execution from persistence_v1.proposal_executions where message_id=proposal.message_id;
    if found then
      if not persistence_v1.can_read_task((execution.result->>'targetTaskUuid')::uuid) then return jsonb_build_object('status','not_found_or_forbidden'); end if;
      outcome:=execution.result||jsonb_build_object('operationId',op);
      insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,target_id,result)
        values(actor,op,fingerprint,(outcome->>'targetTaskUuid')::uuid,outcome);
      return outcome||jsonb_build_object('task',persistence_v1.read_task((outcome->>'targetTaskUuid')::uuid));
    end if;
    if m.action_status is distinct from 'proposed' or m.persistence_epoch is distinct from a.write_epoch then
      return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if encode(sha256(convert_to(m.proposed_action::text,'UTF8')),'hex') is distinct from proposal.source_hash
      or proposal.command->>'expectedWriteEpoch' is distinct from expected_epoch::text
      or proposal.command->>'targetTaskUuid' is distinct from c->>'targetTaskUuid'
      or proposal.command->>'expectedRevision' is distinct from c->>'expectedRevision' then
      return jsonb_build_object('status','validation_failed'); end if;
    outcome:=persistence_v1.apply_task_command(proposal.command||jsonb_build_object('operationId',op));
    update persistence_v1.receipts set payload_hash=fingerprint where actor_id=actor and operation_id=op;
    if outcome->>'status'='committed' then
      insert into persistence_v1.proposal_executions(message_id,actor_id,operation_id,result) values(proposal.message_id,actor,op,outcome-'task');
      update public.assistant_messages set action_status='done' where id=m.id;
      update public.assistant_actions set status='done',updated_at=now() where message_id=m.id and user_id=actor;
    end if;
    return outcome;
  end if;
  if t.revision<>expected_revision then
    outcome:=jsonb_build_object('status','conflict','operationId',op,'targetTaskUuid',target,'revision',t.revision::text,'writeEpoch',a.write_epoch::text);
    insert into persistence_v1.receipts values(actor,op,fingerprint,target,outcome,now());
    return outcome||jsonb_build_object('task',persistence_v1.read_task(target));
  end if;
  if kind='set_subtask_status' then
    if jsonb_typeof(c->'status') is distinct from 'string' or not(coalesce(c->>'status','')=any(array['open','done','cancelled']))
      or jsonb_typeof(c->'subtaskId') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
    select * into s from public.task_shares where task_id=target and status='accepted' and role='contributor'
      and (shared_with_user_id=actor or shared_with_email=lower(coalesce(auth.jwt()->>'email',''))) limit 1;
    if not found or exists(select 1 from public.task_subtask_assignments where task_id=target and subtask_id=c->>'subtaskId' and ended_at is null and share_id<>s.id) then
      return jsonb_build_object('status','not_found_or_forbidden'); end if;
    select value,(ordinality-1)::integer into step,idx from jsonb_array_elements(t.subtasks) with ordinality where value->>'id'=c->>'subtaskId';
    if not found then return jsonb_build_object('status','validation_failed'); end if;
    changed:=step->>'status' is distinct from c->>'status';
    if changed then
      t.subtasks:=jsonb_set(t.subtasks,array[idx::text],step||jsonb_build_object('status',c->>'status','statusChangedAt',now()));
      step_status:=case when t.status='open' and c->>'status'='done' then 'in_progress'::public.task_status else t.status end;
      update public.tasks set subtasks=t.subtasks,status=step_status,status_changed_at=case when step_status<>t.status then now() else status_changed_at end where id=target;
    end if;
  elsif kind='invite_share' then
    if owner_id<>actor then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if jsonb_typeof(c->'email') is distinct from 'string' or length(c->>'email')>320 or position('@' in c->>'email')<2
      or (c ? 'role' and jsonb_typeof(c->'role') is distinct from 'string')
      or not(coalesce(c->>'role','contributor')=any(array['viewer','contributor'])) then return jsonb_build_object('status','validation_failed'); end if;
    if lower(btrim(c->>'email'))=lower(coalesce(auth.jwt()->>'email','')) then return jsonb_build_object('status','validation_failed'); end if;
    if exists(select 1 from public.task_shares where task_id=target and shared_with_email=lower(btrim(c->>'email')) and status in ('pending','accepted')) then
      return jsonb_build_object('status','validation_failed'); end if;
    insert into public.task_shares(task_id,owner_user_id,shared_with_email,role,owner_email,task_title,task_prefix,task_number)
      values(target,actor,lower(btrim(c->>'email')),coalesce(c->>'role','contributor'),auth.jwt()->>'email',t.title,t.prefix,t.task_number) returning * into s;
  elsif kind in ('assign_subtask','unassign_subtask') then
    if owner_id<>actor then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    select value into step from jsonb_array_elements(t.subtasks) where value->>'id'=c->>'subtaskId';
    if not found then return jsonb_build_object('status','validation_failed'); end if;
    begin
      if kind='assign_subtask' then
        select * into s from public.task_shares where id=(c->>'shareId')::uuid and task_id=target and status='accepted' and role='contributor';
        if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
      end if;
    exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
    changed:=case when kind='assign_subtask' then not exists(select 1 from public.task_subtask_assignments
      where task_id=target and subtask_id=step->>'id' and ended_at is null and share_id=s.id)
      else exists(select 1 from public.task_subtask_assignments where task_id=target and subtask_id=step->>'id' and ended_at is null) end;
    if changed then perform public.set_task_subtask_assignment(target,(step->>'number')::integer,case when kind='assign_subtask' then s.id else null end); end if;
  else
    begin select * into s from public.task_shares where id=(c->>'shareId')::uuid and task_id=target for update;
    exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
    if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if (kind='revoke_share' and (s.owner_user_id<>actor or s.status not in ('pending','accepted')))
      or (kind in ('accept_share','decline_share') and (s.status<>'pending' or not coalesce(s.shared_with_user_id=actor or s.shared_with_email=lower(coalesce(auth.jwt()->>'email','')) ,false)))
      or (kind in ('leave_share','set_shared_focus') and (s.status<>'accepted' or not coalesce(s.shared_with_user_id=actor or s.shared_with_email=lower(coalesce(auth.jwt()->>'email','')) ,false))) then
      return jsonb_build_object('status','not_found_or_forbidden'); end if;
    if kind='revoke_share' then perform public.revoke_task_share(s.id);
    elsif kind='accept_share' then perform public.accept_task_share(s.id);
    elsif kind='decline_share' then perform public.decline_task_share(s.id);
    elsif kind='leave_share' then perform public.leave_task_share(s.id);
    elsif kind='set_shared_focus' then
      if jsonb_typeof(c->'focused') is distinct from 'boolean' or jsonb_typeof(c->'expectedShareRevision') is distinct from 'string'
        or c->>'expectedShareRevision' is distinct from s.revision::text then return jsonb_build_object('status','validation_failed'); end if;
      if s.focused is distinct from (c->>'focused')::boolean then
        perform public.set_shared_task_focus(s.id,(c->>'focused')::boolean);
        update public.task_shares set revision=revision+1 where id=s.id;
      end if;
      changed:=false;
    end if;
    if kind<>'set_shared_focus' then update public.task_shares set revision=revision+1 where id=s.id; end if;
  end if;
  if changed then
    update public.tasks set revision=revision+1,updated_at=now() where id=target returning * into t;
    update persistence_v1.accounts set change_seq=change_seq+1 where user_id=owner_id;
  end if;
  outcome:=jsonb_build_object('status','committed','operationId',op,'targetTaskUuid',target,'revision',t.revision::text,'writeEpoch',a.write_epoch::text);
  if s.id is not null then outcome:=outcome||jsonb_build_object('shareId',s.id,
    'shareRevision',(select revision::text from public.task_shares where id=s.id)); end if;
  insert into persistence_v1.receipts values(actor,op,fingerprint,target,outcome,now());
  if persistence_v1.can_read_task(target) then outcome:=outcome||jsonb_build_object('task',persistence_v1.read_task(target)); end if;
  return outcome;
end;
$$;
create or replace function public.persistence_command_v1(p_command jsonb) returns jsonb
language sql security definer set search_path=pg_catalog as $$ select persistence_v1.collaboration_command(p_command); $$;
create or replace function public.persistence_receipt_v1(p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare r persistence_v1.receipts;
begin
  if auth.uid() is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  select * into r from persistence_v1.receipts where actor_id=auth.uid() and operation_id=p_operation_id;
  if not found then return jsonb_build_object('status','unknown','operationId',p_operation_id); end if;
  if r.target_id is null then return r.result; end if;
  if not persistence_v1.can_read_task(r.target_id) then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  return r.result||jsonb_build_object('task',persistence_v1.read_task(r.target_id));
end;
$$;
revoke all on function persistence_v1.can_read_task(uuid),persistence_v1.prepare_proposal(jsonb),persistence_v1.collaboration_command(jsonb) from public,anon,authenticated;
revoke all on function public.persistence_command_v1(jsonb),public.persistence_receipt_v1(uuid) from public,anon,authenticated;
grant execute on function public.persistence_command_v1(jsonb),public.persistence_receipt_v1(uuid) to authenticated;
commit;
