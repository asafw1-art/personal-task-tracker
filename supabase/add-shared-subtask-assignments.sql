create table if not exists public.task_subtask_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  subtask_id text not null,
  subtask_number integer not null check (subtask_number > 0),
  share_id uuid not null references public.task_shares(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  assignee_user_id uuid references auth.users(id) on delete set null,
  assignee_email text not null,
  assignee_display_name text,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by_user_id uuid references auth.users(id) on delete set null,
  end_reason text check (end_reason is null or end_reason in ('unassigned', 'reassigned', 'share_ended', 'subtask_removed')),
  updated_at timestamptz not null default now()
);

create unique index if not exists task_subtask_assignments_active_unique
  on public.task_subtask_assignments (task_id, subtask_id)
  where ended_at is null;

create index if not exists task_subtask_assignments_task_idx
  on public.task_subtask_assignments (task_id, assigned_at desc);

create index if not exists task_subtask_assignments_share_idx
  on public.task_subtask_assignments (share_id, ended_at);

alter table public.task_subtask_assignments enable row level security;

drop policy if exists "Task participants can read subtask assignments" on public.task_subtask_assignments;
create policy "Task participants can read subtask assignments"
  on public.task_subtask_assignments
  for select
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
      from public.task_shares as viewer_share
      where viewer_share.task_id = task_subtask_assignments.task_id
        and viewer_share.status = 'accepted'
        and (
          viewer_share.shared_with_user_id = auth.uid()
          or viewer_share.shared_with_email = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
  );

create or replace function public.set_task_subtask_assignment(
  p_task_id uuid,
  p_subtask_number integer,
  p_share_id uuid default null
)
returns public.task_subtask_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.task_shares;
  v_subtask_id text;
  v_current public.task_subtask_assignments;
  v_assignment public.task_subtask_assignments;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_subtask_number is null or p_subtask_number <= 0 then
    raise exception 'Invalid subtask number';
  end if;

  select item.value ->> 'id'
  into v_subtask_id
    from public.tasks as task
    cross join lateral jsonb_array_elements(coalesce(task.subtasks, '[]'::jsonb)) as item(value)
    where task.id = p_task_id
      and task.user_id = auth.uid()
      and (item.value ->> 'number') ~ '^[0-9]+$'
      and (item.value ->> 'number')::integer = p_subtask_number
    limit 1;

  if v_subtask_id is null or v_subtask_id = '' then
    raise exception 'Task or subtask was not found';
  end if;

  select * into v_current
  from public.task_subtask_assignments
  where task_id = p_task_id
    and subtask_id = v_subtask_id
    and ended_at is null
  for update;

  if p_share_id is null then
    if v_current.id is null then
      return null;
    end if;

    update public.task_subtask_assignments
    set ended_at = now(),
        ended_by_user_id = auth.uid(),
        end_reason = 'unassigned',
        updated_at = now()
    where id = v_current.id
    returning * into v_assignment;
    return v_assignment;
  end if;

  select * into v_share
  from public.task_shares
  where id = p_share_id
    and task_id = p_task_id
    and owner_user_id = auth.uid()
    and status = 'accepted'
    and role = 'contributor';

  if not found then
    raise exception 'Accepted contributor was not found';
  end if;

  if v_current.id is not null and v_current.share_id = p_share_id then
    return v_current;
  end if;

  if v_current.id is not null then
    update public.task_subtask_assignments
    set ended_at = now(),
        ended_by_user_id = auth.uid(),
        end_reason = 'reassigned',
        updated_at = now()
    where id = v_current.id;
  end if;

  insert into public.task_subtask_assignments (
    task_id,
    subtask_id,
    subtask_number,
    share_id,
    owner_user_id,
    assignee_user_id,
    assignee_email,
    assignee_display_name
  ) values (
    p_task_id,
    v_subtask_id,
    p_subtask_number,
    v_share.id,
    auth.uid(),
    v_share.shared_with_user_id,
    v_share.shared_with_email,
    coalesce(nullif(trim(v_share.recipient_display_name), ''), split_part(v_share.shared_with_email, '@', 1))
  )
  returning * into v_assignment;

  return v_assignment;
end;
$$;

create or replace function public.end_assignments_when_share_ends()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'accepted' and new.status <> 'accepted' then
    update public.task_subtask_assignments
    set ended_at = coalesce(new.ended_at, now()),
        ended_by_user_id = new.ended_by_user_id,
        end_reason = 'share_ended',
        updated_at = now()
    where share_id = new.id
      and ended_at is null;
  end if;
  return new;
end;
$$;

create or replace function public.end_assignments_when_subtasks_are_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.task_subtask_assignments as assignment
  set ended_at = now(),
      ended_by_user_id = auth.uid(),
      end_reason = 'subtask_removed',
      updated_at = now()
  where assignment.task_id = new.id
    and assignment.ended_at is null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(new.subtasks, '[]'::jsonb)) as item(value)
      where item.value ->> 'id' = assignment.subtask_id
    );
  return new;
end;
$$;

drop trigger if exists task_share_end_assignments on public.task_shares;
create trigger task_share_end_assignments
after update of status on public.task_shares
for each row
execute function public.end_assignments_when_share_ends();

drop trigger if exists task_subtask_removal_assignments on public.tasks;
create trigger task_subtask_removal_assignments
after update of subtasks on public.tasks
for each row
execute function public.end_assignments_when_subtasks_are_removed();

create or replace function public.update_shared_task_subtask_status(
  p_task_id uuid,
  p_subtask_number integer,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_task record;
  v_participant_share public.task_shares;
  v_assignment public.task_subtask_assignments;
  v_subtask_id text;
  v_updated_subtasks jsonb;
  v_changed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_subtask_number is null or p_subtask_number <= 0 then
    raise exception 'Invalid subtask number';
  end if;

  if p_status not in ('open', 'done', 'cancelled') then
    raise exception 'Invalid subtask status';
  end if;

  select tasks.id, tasks.user_id, tasks.subtasks
  into v_task
  from public.tasks
  where tasks.id = p_task_id;

  if not found then
    raise exception 'Task was not found';
  end if;

  select item.value ->> 'id'
  into v_subtask_id
  from jsonb_array_elements(coalesce(v_task.subtasks, '[]'::jsonb)) as item(value)
  where (item.value ->> 'number') ~ '^[0-9]+$'
    and (item.value ->> 'number')::integer = p_subtask_number
  limit 1;

  if v_subtask_id is null or v_subtask_id = '' then
    raise exception 'Subtask was not found';
  end if;

  if v_task.user_id <> auth.uid() then
    select * into v_participant_share
    from public.task_shares
    where task_id = p_task_id
      and status = 'accepted'
      and role = 'contributor'
      and (shared_with_user_id = auth.uid() or shared_with_email = v_email)
    limit 1;

    if v_participant_share.id is null then
      raise exception 'You are not allowed to update this shared task';
    end if;

    select * into v_assignment
    from public.task_subtask_assignments
    where task_id = p_task_id
      and subtask_id = v_subtask_id
      and ended_at is null;

    if v_assignment.id is not null and v_assignment.share_id <> v_participant_share.id then
      raise exception 'This subtask is assigned to another participant';
    end if;
  end if;

  select coalesce(jsonb_agg(
    case
      when (item.value ->> 'number') ~ '^[0-9]+$'
        and (item.value ->> 'number')::integer = p_subtask_number then
        jsonb_set(
          jsonb_set(item.value, '{status}', to_jsonb(p_status), true),
          '{statusChangedAt}',
          to_jsonb(now()::text),
          true
        )
      else item.value
    end
    order by item.ordinality
  ), '[]'::jsonb),
  bool_or(
    (item.value ->> 'number') ~ '^[0-9]+$'
    and (item.value ->> 'number')::integer = p_subtask_number
  )
  into v_updated_subtasks, v_changed
  from jsonb_array_elements(coalesce(v_task.subtasks, '[]'::jsonb)) with ordinality as item(value, ordinality);

  if not coalesce(v_changed, false) then
    raise exception 'Subtask was not found';
  end if;

  update public.tasks
  set subtasks = v_updated_subtasks,
      updated_at = now()
  where tasks.id = p_task_id;

  return v_updated_subtasks;
end;
$$;

revoke all on table public.task_subtask_assignments from public;
revoke all on function public.end_assignments_when_share_ends() from public;
revoke all on function public.end_assignments_when_subtasks_are_removed() from public;
revoke all on function public.set_task_subtask_assignment(uuid, integer, uuid) from public;
revoke all on function public.update_shared_task_subtask_status(uuid, integer, text) from public;
grant select on table public.task_subtask_assignments to authenticated;
grant execute on function public.set_task_subtask_assignment(uuid, integer, uuid) to authenticated;
grant execute on function public.update_shared_task_subtask_status(uuid, integer, text) to authenticated;
