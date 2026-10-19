-- STAGED ONLY. Requires persistence-foundation-v1.sql; NOT approved for Production.
-- Owner-only transport. Sharing/AI/bulk commands are not connected by this file.
begin;
create or replace function public.persistence_command_v1(p_command jsonb) returns jsonb
language sql security definer set search_path = pg_catalog as $$
  select persistence_v1.apply_task_command(p_command);
$$;

create or replace function public.persistence_receipt_v1(p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, persistence_v1 as $$
declare actor uuid := auth.uid(); account persistence_v1.accounts; receipt persistence_v1.receipts; task public.tasks;
begin
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  select * into account from persistence_v1.accounts where user_id=actor for share;
  if not found or not account.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  select * into receipt from persistence_v1.receipts where actor_id=actor and operation_id=p_operation_id;
  if not found then
    -- Missing is not proof that the original transaction failed or never ran.
    return jsonb_build_object('status','unknown','operationId',p_operation_id);
  end if;
  if receipt.target_id is null then return receipt.result; end if;
  select * into task from public.tasks where id=receipt.target_id and user_id=actor;
  if not found then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  return receipt.result || jsonb_build_object('task',persistence_v1.task_view(task,account.write_epoch));
end;
$$;

create or replace function public.persistence_page_v1(p_limit integer default 100, p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, persistence_v1 as $$
declare
  actor uuid := auth.uid(); account persistence_v1.accounts; after_id uuid;
  page jsonb; next_id uuid; has_more boolean; cursor_seq bigint; cursor_epoch bigint;
begin
  if actor is null then return jsonb_build_object('status','not_found_or_forbidden'); end if;
  if p_limit is null or p_limit<1 or p_limit>200 then return jsonb_build_object('status','validation_failed'); end if;
  -- A writer takes this same account lock before touching task rows.
  select * into account from persistence_v1.accounts where user_id=actor for share;
  if not found or not account.enabled then return jsonb_build_object('status','client_upgrade_required'); end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor)<>'object' then return jsonb_build_object('status','validation_failed'); end if;
    if p_cursor->>'owner' is distinct from actor::text
      or (select count(*) from jsonb_object_keys(p_cursor))<>4
      or not(p_cursor ?& array['owner','afterId','changeSeq','writeEpoch'])
      or jsonb_typeof(p_cursor->'changeSeq') is distinct from 'string'
      or jsonb_typeof(p_cursor->'writeEpoch') is distinct from 'string'
      or not(coalesce(p_cursor->>'changeSeq','') ~ '^(0|[1-9][0-9]{0,18})$')
      or not(coalesce(p_cursor->>'writeEpoch','') ~ '^[1-9][0-9]{0,18}$') then
      return jsonb_build_object('status','validation_failed'); end if;
    begin
      after_id:=(p_cursor->>'afterId')::uuid;
      cursor_seq:=(p_cursor->>'changeSeq')::bigint;
      cursor_epoch:=(p_cursor->>'writeEpoch')::bigint;
      if after_id is null then return jsonb_build_object('status','validation_failed'); end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return jsonb_build_object('status','validation_failed');
    end;
    if cursor_seq<>account.change_seq or cursor_epoch<>account.write_epoch then
      return jsonb_build_object('status','restart_required','changeSeq',account.change_seq::text,'writeEpoch',account.write_epoch::text);
    end if;
  end if;
  select coalesce(jsonb_agg(persistence_v1.task_view(r.task,account.write_epoch) order by (r.task).id),'[]'::jsonb)
    into page from (select t as task from public.tasks t where user_id=actor and (after_id is null or id>after_id) order by id limit p_limit) r;
  if jsonb_array_length(page)>0 then
    next_id:=(page->(jsonb_array_length(page)-1)->>'id')::uuid;
    select exists(select 1 from public.tasks where user_id=actor and id>next_id) into has_more;
  else has_more:=false; end if;
  return jsonb_build_object('status','ok','tasks',page,'complete',not has_more,
    'changeSeq',account.change_seq::text,'writeEpoch',account.write_epoch::text,
    'cursor',case when has_more then jsonb_build_object('owner',actor,'afterId',next_id,
      'changeSeq',account.change_seq::text,'writeEpoch',account.write_epoch::text) else null end);
end;
$$;
revoke all on function public.persistence_command_v1(jsonb), public.persistence_receipt_v1(uuid), public.persistence_page_v1(integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.persistence_command_v1(jsonb), public.persistence_receipt_v1(uuid), public.persistence_page_v1(integer,jsonb) to authenticated;
commit;
