alter table public.task_shares
  add column if not exists owner_display_name text,
  add column if not exists owner_email text,
  add column if not exists task_title text,
  add column if not exists task_prefix text,
  add column if not exists task_number integer,
  add column if not exists recipient_display_name text,
  add column if not exists focused boolean not null default false,
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists end_reason text,
  add column if not exists task_snapshot jsonb,
  add column if not exists end_seen_at timestamptz;

alter table public.task_shares drop constraint if exists task_shares_status_check;
alter table public.task_shares
  add constraint task_shares_status_check
  check (status in ('pending', 'accepted', 'declined', 'revoked', 'left'));

alter table public.task_shares drop constraint if exists task_shares_end_reason_check;
alter table public.task_shares
  add constraint task_shares_end_reason_check
  check (end_reason is null or end_reason in ('owner_revoked', 'recipient_left'));

update public.task_shares as shares
set owner_email = lower(users.email),
    owner_display_name = coalesce(nullif(trim(settings.display_name), ''), split_part(users.email, '@', 1))
from auth.users as users
left join public.user_settings as settings on settings.user_id = users.id
where shares.owner_user_id = users.id
  and (shares.owner_email is null or shares.owner_display_name is null);

update public.task_shares as shares
set recipient_display_name = coalesce(nullif(trim(settings.display_name), ''), split_part(shares.shared_with_email, '@', 1))
from public.user_settings as settings
where shares.shared_with_user_id = settings.user_id
  and shares.recipient_display_name is null;

update public.task_shares as shares
set task_title = tasks.title,
    task_prefix = tasks.prefix,
    task_number = tasks.task_number
from public.tasks as tasks
where shares.task_id = tasks.id
  and (shares.task_title is null or shares.task_prefix is null or shares.task_number is null);

create or replace function public.task_share_snapshot(p_task_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'prefix', tasks.prefix,
    'number', tasks.task_number,
    'title', tasks.title,
    'category', tasks.category,
    'actionType', tasks.action_type,
    'priority', tasks.priority,
    'status', tasks.status,
    'notes', tasks.notes,
    'dueDate', case when tasks.due_at is null then null else to_char(tasks.due_at, 'YYYY-MM-DD') end,
    'completedAt', case when tasks.completed_at is null then null else to_char(tasks.completed_at, 'YYYY-MM-DD') end,
    'statusChangedAt', tasks.status_changed_at,
    'subtasks', tasks.subtasks,
    'createdAt', tasks.created_at
  )
  from public.tasks
  where tasks.id = p_task_id;
$$;

revoke all on function public.task_share_snapshot(uuid) from public;

create or replace function public.revoke_task_share(p_share_id uuid)
returns public.task_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.task_shares;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.task_shares
  set status = 'revoked',
      ended_at = now(),
      ended_by_user_id = auth.uid(),
      end_reason = 'owner_revoked',
      task_snapshot = public.task_share_snapshot(task_id),
      end_seen_at = null,
      updated_at = now()
  where id = p_share_id
    and owner_user_id = auth.uid()
    and status in ('pending', 'accepted')
  returning * into v_share;

  if not found then
    raise exception 'Task share was not found or cannot be revoked';
  end if;

  return v_share;
end;
$$;

create or replace function public.leave_task_share(p_share_id uuid)
returns public.task_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_share public.task_shares;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.task_shares
  set shared_with_user_id = coalesce(shared_with_user_id, auth.uid()),
      status = 'left',
      ended_at = now(),
      ended_by_user_id = auth.uid(),
      end_reason = 'recipient_left',
      task_snapshot = public.task_share_snapshot(task_id),
      end_seen_at = now(),
      updated_at = now()
  where id = p_share_id
    and status = 'accepted'
    and (shared_with_user_id = auth.uid() or shared_with_email = v_email)
  returning * into v_share;

  if not found then
    raise exception 'Task share was not found or cannot be left';
  end if;

  return v_share;
end;
$$;

create or replace function public.set_shared_task_focus(p_share_id uuid, p_focused boolean)
returns public.task_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_share public.task_shares;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.task_shares
  set shared_with_user_id = coalesce(shared_with_user_id, auth.uid()),
      focused = p_focused,
      updated_at = now()
  where id = p_share_id
    and status = 'accepted'
    and (shared_with_user_id = auth.uid() or shared_with_email = v_email)
  returning * into v_share;

  if not found then
    raise exception 'Task share was not found or cannot be updated';
  end if;

  return v_share;
end;
$$;

create or replace function public.acknowledge_task_share_end(p_share_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.task_shares
  set end_seen_at = coalesce(end_seen_at, now()),
      updated_at = now()
  where id = p_share_id
    and status = 'revoked'
    and (shared_with_user_id = auth.uid() or shared_with_email = v_email);
end;
$$;

create or replace function public.accept_task_share(p_share_id uuid)
returns public.task_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_display_name text;
  v_share public.task_shares;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select nullif(trim(display_name), '') into v_display_name
  from public.user_settings
  where user_id = auth.uid();

  update public.task_shares
  set shared_with_user_id = auth.uid(),
      recipient_display_name = coalesce(v_display_name, split_part(v_email, '@', 1)),
      status = 'accepted',
      accepted_at = coalesce(accepted_at, now()),
      updated_at = now()
  where id = p_share_id
    and status = 'pending'
    and (shared_with_user_id = auth.uid() or shared_with_email = v_email)
  returning * into v_share;

  if not found then
    raise exception 'Task share invitation was not found or cannot be accepted';
  end if;

  return v_share;
end;
$$;

revoke all on function public.revoke_task_share(uuid) from public;
revoke all on function public.leave_task_share(uuid) from public;
revoke all on function public.set_shared_task_focus(uuid, boolean) from public;
revoke all on function public.acknowledge_task_share_end(uuid) from public;

grant execute on function public.revoke_task_share(uuid) to authenticated;
grant execute on function public.leave_task_share(uuid) to authenticated;
grant execute on function public.set_shared_task_focus(uuid, boolean) to authenticated;
grant execute on function public.acknowledge_task_share_end(uuid) to authenticated;

drop policy if exists "Owners can revoke task shares" on public.task_shares;
drop policy if exists "Owners can update task shares" on public.task_shares;
