-- STAGED ONLY. Requires foundation, transport, collaboration and existing product schemas.
begin;
create table if not exists persistence_v1.domain_versions (
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null check(domain in ('settings','taxonomy')),
  revision bigint not null default 1 check(revision>0), primary key(user_id,domain)
);
alter table persistence_v1.domain_versions enable row level security;
revoke all on persistence_v1.domain_versions from public,anon,authenticated;

create or replace function persistence_v1.provision_account() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  insert into persistence_v1.accounts(user_id) values(new.id) on conflict do nothing;
  insert into persistence_v1.counters(user_id,prefix,high_water) values(new.id,'P',0),(new.id,'W',0) on conflict do nothing;
  insert into public.task_taxonomy_items(user_id,item_type,prefix,name) values(new.id,'topic','P','אישי'),(new.id,'topic','W','עבודה') on conflict do nothing;
  return new;
end $$;
drop trigger if exists persistence_provision_account on auth.users;
create trigger persistence_provision_account after insert on auth.users for each row execute function persistence_v1.provision_account();

create or replace function public.persistence_context_v1() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare actor uuid:=auth.uid(); a persistence_v1.accounts; shared jsonb; shares jsonb;
begin
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  select * into a from persistence_v1.accounts where user_id=actor;
  if not found or not a.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  select coalesce(jsonb_agg(persistence_v1.task_view(t,owner.write_epoch)||jsonb_build_object('ownerUserId',t.user_id,'shareId',s.id,
    'sharedByName',s.owner_display_name,'sharedByEmail',s.owner_email) order by t.id),'[]'::jsonb) into shared
    from (select * from public.task_shares where status='accepted' and (shared_with_user_id=actor or shared_with_email=lower(coalesce(auth.jwt()->>'email',''))) order by id limit 201) s
    join public.tasks t on t.id=s.task_id join persistence_v1.accounts owner on owner.user_id=t.user_id;
  select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('revision',s.revision::text,'task_revision',t.revision::text,'write_epoch',owner.write_epoch::text) order by s.id),'[]'::jsonb) into shares
    from public.task_shares s join public.tasks t on t.id=s.task_id join persistence_v1.accounts owner on owner.user_id=t.user_id
    where s.owner_user_id=actor or s.shared_with_user_id=actor or s.shared_with_email=lower(coalesce(auth.jwt()->>'email',''));
  return jsonb_build_object('status','context','writeEpoch',a.write_epoch::text,'readOnly',a.read_only,
    'settingsRevision',coalesce((select revision::text from persistence_v1.domain_versions where user_id=actor and domain='settings'),'1'),
    'taxonomyRevision',coalesce((select revision::text from persistence_v1.domain_versions where user_id=actor and domain='taxonomy'),'1'),
    'settings',(select to_jsonb(v) from public.user_settings v where user_id=actor),
    'taxonomy',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.task_taxonomy_items v where user_id=actor),'[]'::jsonb),
    'sharedTasks',shared,'sharedComplete',jsonb_array_length(shared)<=200,'shares',shares);
end $$;

create or replace function persistence_v1.domain_command(c jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare actor uuid:=auth.uid(); a persistence_v1.accounts; r persistence_v1.receipts; op uuid; kind text:=c->>'kind';
  domain_name text; rev bigint; fingerprint text; outcome jsonb; item jsonb; child jsonb; idx integer:=0; digest text;
  failed jsonb; k text; patch jsonb; existing jsonb; renamed boolean; old_name text; new_name text; prefix_value text; item_type_value text; results jsonb:='[]'; ref integer;
begin
  if kind not in ('save_settings','replace_taxonomy','rename_taxonomy','import') or kind is null then return persistence_v1.collaboration_command(c); end if;
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if jsonb_typeof(c) is distinct from 'object' or octet_length(c::text)>65536 or c->'protocolVersion' is distinct from '1'::jsonb
    or jsonb_typeof(c->'operationId') is distinct from 'string' or jsonb_typeof(c->'expectedWriteEpoch') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
  for k in select jsonb_object_keys(c) loop
    if not(k=any(array['protocolVersion','operationId','kind','expectedWriteEpoch','expectedDomainRevision','patch','taxonomy','from','to','itemType','prefix','items'])) then
      return jsonb_build_object('status','validation_failed'); end if;
    if k in ('patch','taxonomy','from','to','itemType','prefix','items') and not(k=any(case kind
      when 'save_settings' then array['patch'] when 'replace_taxonomy' then array['taxonomy']
      when 'rename_taxonomy' then array['from','to','itemType','prefix'] else array['items'] end)) then return jsonb_build_object('status','validation_failed'); end if;
  end loop;
  begin op:=(c->>'operationId')::uuid; exception when invalid_text_representation then return jsonb_build_object('status','validation_failed'); end;
  fingerprint:=encode(sha256(convert_to((c-'operationId')::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||op::text,0));
  select * into a from persistence_v1.accounts where user_id=actor for update;
  if not found or not a.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  select * into r from persistence_v1.receipts where actor_id=actor and operation_id=op;
  if found then
    if r.payload_hash<>fingerprint then return jsonb_build_object('status','idempotency_mismatch'); end if;
    return r.result;
  end if;
  if a.read_only then return jsonb_build_object('status','account_read_only'); end if;
  if c->>'expectedWriteEpoch' is distinct from a.write_epoch::text then return jsonb_build_object('status','stale_epoch'); end if;
  if kind='import' then
    if jsonb_typeof(c->'items') is distinct from 'array' or jsonb_array_length(c->'items') not between 1 and 100 then return jsonb_build_object('status','validation_failed'); end if;
    begin
      for item in select value from jsonb_array_elements(c->'items') loop
        idx:=idx+1;
        if item->>'kind' not in ('create_task','patch_task','set_task_status','set_owner_focus','add_subtask','patch_subtask','remove_subtask','set_subtask_status') or item->>'kind' is null then
          failed:=jsonb_build_object('status','validation_failed','index',idx); raise exception using errcode='P1001'; end if;
        digest:=encode(sha256(convert_to(op::text||':'||idx::text,'UTF8')),'hex');
        child:=(item-array['targetFrom','subtaskFrom','revisionFrom'])||jsonb_build_object('protocolVersion',1,'operationId',(substr(digest,1,8)||'-'||substr(digest,9,4)||'-'||substr(digest,13,4)||'-'||substr(digest,17,4)||'-'||substr(digest,21,12))::uuid,'expectedWriteEpoch',a.write_epoch::text);
        if item ? 'targetFrom' then
          if coalesce(item->>'targetFrom','') !~ '^[0-9]{1,2}$' then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          ref:=(item->>'targetFrom')::integer;
          if ref>=idx-1 or ref<0 or (results->ref)->>'targetTaskUuid' is null then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          child:=child||jsonb_build_object('targetTaskUuid',results->ref->>'targetTaskUuid');
        end if;
        if item ? 'subtaskFrom' then
          if coalesce(item->>'subtaskFrom','') !~ '^[0-9]{1,2}$' then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          ref:=(item->>'subtaskFrom')::integer;
          if ref>=idx-1 or ref<0 or (results->ref)->>'subtaskId' is null then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          child:=child||jsonb_build_object('subtaskId',results->ref->>'subtaskId');
        end if;
        if item ? 'revisionFrom' then
          if coalesce(item->>'revisionFrom','') !~ '^[0-9]{1,2}$' then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          ref:=(item->>'revisionFrom')::integer;
          if ref>=idx-1 or ref<0 or (results->ref)->>'targetTaskUuid' is distinct from child->>'targetTaskUuid' then failed:=jsonb_build_object('status','validation_failed'); raise exception using errcode='P1001'; end if;
          child:=child||jsonb_build_object('expectedRevision',results->ref->>'revision');
        end if;
        outcome:=persistence_v1.apply_task_command(child);
        if outcome->>'status'<>'committed' then failed:=jsonb_build_object('status',outcome->>'status','index',idx); raise exception using errcode='P1001'; end if;
        results:=results||jsonb_build_array((outcome-'task')||jsonb_build_object('number',outcome#>'{task,number}',
          'subtaskId',case when child->>'kind'='add_subtask' then outcome#>>'{task,subtasks,-1,id}' else null end));
      end loop;
      outcome:=jsonb_build_object('status','committed','operationId',op,'writeEpoch',a.write_epoch::text,'domain','import','itemCount',idx,'items',results);
    exception when sqlstate 'P1001' then outcome:=failed||jsonb_build_object('operationId',op); end;
  else
    domain_name:=case when kind='save_settings' then 'settings' else 'taxonomy' end;
    select revision into rev from persistence_v1.domain_versions where user_id=actor and domain=domain_name;
    rev:=coalesce(rev,1);
    if jsonb_typeof(c->'expectedDomainRevision') is distinct from 'string' then return jsonb_build_object('status','validation_failed'); end if;
    if c->>'expectedDomainRevision' is distinct from rev::text then return jsonb_build_object('status','conflict','domain',domain_name,'revision',rev::text); end if;
    if kind='save_settings' then
      patch:=c->'patch';
      if jsonb_typeof(patch) is distinct from 'object' then return jsonb_build_object('status','validation_failed'); end if;
      for k in select jsonb_object_keys(patch) loop
        if not(k=any(array['display_name','notification_preferences','analytics_preferences','theme'])) then return jsonb_build_object('status','validation_failed'); end if;
      end loop;
      if (patch ? 'display_name' and patch->'display_name'<>'null'::jsonb and (jsonb_typeof(patch->'display_name')<>'string' or length(patch->>'display_name')>200))
        or (patch ? 'theme' and patch->'theme'<>'null'::jsonb and not(coalesce(patch->>'theme','')=any(array['light','dark']))) then return jsonb_build_object('status','validation_failed'); end if;
      if patch ? 'notification_preferences' and patch->'notification_preferences'<>'null'::jsonb then
        if jsonb_typeof(patch->'notification_preferences')<>'object' then return jsonb_build_object('status','validation_failed'); end if;
        if exists(select 1 from jsonb_each(patch->'notification_preferences') where jsonb_typeof(value)<>'boolean') then return jsonb_build_object('status','validation_failed'); end if;
      end if;
      if patch ? 'analytics_preferences' and patch->'analytics_preferences'<>'null'::jsonb then
        if jsonb_typeof(patch->'analytics_preferences')<>'object' or (patch->'analytics_preferences')-'stuckThresholdDays'<>'{}'::jsonb then return jsonb_build_object('status','validation_failed'); end if;
        if (patch->'analytics_preferences') ? 'stuckThresholdDays' and (jsonb_typeof(patch#>'{analytics_preferences,stuckThresholdDays}') is distinct from 'number'
          or not(coalesce(patch#>>'{analytics_preferences,stuckThresholdDays}','')~'^[1-9][0-9]{0,2}$')) then return jsonb_build_object('status','validation_failed'); end if;
      end if;
      select jsonb_build_object('display_name',display_name,'notification_preferences',notification_preferences,'analytics_preferences',analytics_preferences,'theme',theme) into existing from public.user_settings where user_id=actor;
      existing:=coalesce(existing,'{}'::jsonb);
      renamed:=exists(select 1 from jsonb_each(patch) where value is distinct from coalesce(existing->key,'null'::jsonb));
      if renamed then
        patch:=existing||patch;
        insert into public.user_settings(user_id,display_name,notification_preferences,analytics_preferences,theme) values(actor,patch->>'display_name',patch->'notification_preferences',patch->'analytics_preferences',patch->>'theme')
          on conflict(user_id) do update set display_name=excluded.display_name,notification_preferences=excluded.notification_preferences,analytics_preferences=excluded.analytics_preferences,theme=excluded.theme,updated_at=now();
      end if;
    else
      if kind='rename_taxonomy' then
        old_name:=c->>'from'; new_name:=btrim(c->>'to'); item_type_value:=c->>'itemType'; prefix_value:=c->>'prefix';
        if jsonb_typeof(c->'from') is distinct from 'string' or jsonb_typeof(c->'to') is distinct from 'string'
          or item_type_value not in ('topic','action') or item_type_value is null or length(coalesce(new_name,'')) not between 1 and 1000
          or (item_type_value='topic' and (prefix_value is null or prefix_value not in ('P','W'))) then return jsonb_build_object('status','validation_failed'); end if;
        if not exists(select 1 from public.task_taxonomy_items where user_id=actor and item_type=item_type_value and name=old_name and prefix is not distinct from prefix_value) then return jsonb_build_object('status','validation_failed'); end if;
        renamed:=old_name is distinct from new_name;
        if renamed then
          if not exists(select 1 from public.task_taxonomy_items where user_id=actor and item_type=item_type_value and name=new_name and prefix is not distinct from prefix_value) then
            insert into public.task_taxonomy_items(user_id,item_type,prefix,name) values(actor,item_type_value,prefix_value,new_name); end if;
          delete from public.task_taxonomy_items where user_id=actor and item_type=item_type_value and name=old_name and prefix is not distinct from prefix_value;
          if item_type_value='topic' then update public.tasks set category=new_name,revision=revision+1,updated_at=now() where user_id=actor and prefix=prefix_value and category=old_name;
          else update public.tasks t set action_type=case when action_type=old_name then new_name else action_type end,
            subtasks=(select coalesce(jsonb_agg(case when s->>'actionType'=old_name then s||jsonb_build_object('actionType',new_name) else s end order by ord),'[]'::jsonb) from jsonb_array_elements(t.subtasks) with ordinality v(s,ord)),
            revision=revision+1,updated_at=now() where user_id=actor and (action_type=old_name or exists(select 1 from jsonb_array_elements(t.subtasks) s where s->>'actionType'=old_name)); end if;
        end if;
      else
        patch:=c->'taxonomy';
        if jsonb_typeof(patch) is distinct from 'array' or jsonb_array_length(patch)>1000 then return jsonb_build_object('status','validation_failed'); end if;
        for item in select value from jsonb_array_elements(patch) loop
          if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'name') is distinct from 'string'
            or item-array['item_type','prefix','name']<>'{}'::jsonb or item->>'item_type' not in ('topic','action')
            or item->>'item_type' is null or length(btrim(coalesce(item->>'name',''))) not between 1 and 1000
            or (item->>'item_type'='topic' and coalesce(item->>'prefix','') not in ('P','W'))
            or (item->>'item_type'='action' and item->>'prefix' is not null) then return jsonb_build_object('status','validation_failed'); end if;
        end loop;
        if exists(select 1 from public.tasks t where t.user_id=actor and (
          not exists(select 1 from jsonb_array_elements(patch) v where v->>'item_type'='topic' and v->>'prefix'=t.prefix and v->>'name'=t.category)
          or (t.action_type is not null and not exists(select 1 from jsonb_array_elements(patch) v where v->>'item_type'='action' and v->>'name'=t.action_type))
          or exists(select 1 from jsonb_array_elements(t.subtasks) s where nullif(s->>'actionType','') is not null and not exists(select 1 from jsonb_array_elements(patch) v where v->>'item_type'='action' and v->>'name'=s->>'actionType')))) then return jsonb_build_object('status','validation_failed'); end if;
        select coalesce(jsonb_agg(jsonb_build_object('item_type',item_type,'prefix',prefix,'name',name) order by item_type,prefix,name),'[]'::jsonb) into existing from public.task_taxonomy_items where user_id=actor;
        renamed:=existing is distinct from (select coalesce(jsonb_agg(v order by v->>'item_type',v->>'prefix',v->>'name'),'[]'::jsonb) from jsonb_array_elements(patch) v);
        if renamed then
          delete from public.task_taxonomy_items where user_id=actor;
          insert into public.task_taxonomy_items(user_id,item_type,prefix,name) select actor,v->>'item_type',v->>'prefix',v->>'name' from jsonb_array_elements(patch) v;
        end if;
      end if;
    end if;
    if renamed then
      rev:=rev+1;
      insert into persistence_v1.domain_versions values(actor,domain_name,rev) on conflict(user_id,domain) do update set revision=excluded.revision;
      update persistence_v1.accounts set change_seq=change_seq+1 where user_id=actor;
    end if;
    outcome:=jsonb_build_object('status','committed','operationId',op,'domain',domain_name,'revision',rev::text,'writeEpoch',a.write_epoch::text);
  end if;
  insert into persistence_v1.receipts(actor_id,operation_id,payload_hash,result) values(actor,op,fingerprint,outcome);
  return outcome;
end $$;
create or replace function public.persistence_command_v1(p_command jsonb) returns jsonb
language sql security definer set search_path=pg_catalog as $$ select persistence_v1.domain_command(p_command); $$;
revoke all on function persistence_v1.provision_account(),persistence_v1.domain_command(jsonb) from public,anon,authenticated;
revoke all on function public.persistence_context_v1() from public,anon,authenticated;
grant execute on function public.persistence_context_v1() to authenticated;
commit;
