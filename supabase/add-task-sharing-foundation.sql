create table if not exists public.task_shares (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  shared_with_user_id uuid references auth.users(id) on delete cascade,
  shared_with_email text not null check (shared_with_email = lower(trim(shared_with_email)) and position('@' in shared_with_email) > 1),
  role text not null default 'contributor' check (role in ('viewer', 'contributor')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  check (owner_user_id <> shared_with_user_id or shared_with_user_id is null)
);

create unique index if not exists task_shares_active_unique
  on public.task_shares (task_id, shared_with_email)
  where status in ('pending', 'accepted');

create index if not exists task_shares_owner_idx
  on public.task_shares (owner_user_id, status);

create index if not exists task_shares_recipient_user_idx
  on public.task_shares (shared_with_user_id, status);

create index if not exists task_shares_recipient_email_idx
  on public.task_shares (shared_with_email, status);

alter table public.task_shares enable row level security;

drop policy if exists "Owners and recipients can read task shares" on public.task_shares;
drop policy if exists "Owners can create task shares" on public.task_shares;
drop policy if exists "Owners can update task shares" on public.task_shares;
drop policy if exists "Owners can delete task shares" on public.task_shares;

create policy "Owners and recipients can read task shares"
  on public.task_shares
  for select
  using (
    auth.uid() = owner_user_id
    or auth.uid() = shared_with_user_id
    or lower(coalesce(auth.jwt() ->> 'email', '')) = shared_with_email
  );

create policy "Owners can create task shares"
  on public.task_shares
  for insert
  with check (
    auth.uid() = owner_user_id
    and exists (
      select 1
      from public.tasks
      where tasks.id = task_shares.task_id
        and tasks.user_id = auth.uid()
    )
  );

create policy "Owners can update task shares"
  on public.task_shares
  for update
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create policy "Owners can delete task shares"
  on public.task_shares
  for delete
  using (auth.uid() = owner_user_id);

create or replace function public.accept_task_share(p_share_id uuid)
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
  set shared_with_user_id = auth.uid(),
      status = 'accepted',
      accepted_at = coalesce(accepted_at, now()),
      updated_at = now()
  where id = p_share_id
    and status = 'pending'
    and (
      shared_with_user_id = auth.uid()
      or shared_with_email = v_email
    )
  returning * into v_share;

  if not found then
    raise exception 'Task share invitation was not found or cannot be accepted';
  end if;

  return v_share;
end;
$$;

create or replace function public.decline_task_share(p_share_id uuid)
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
      status = 'declined',
      updated_at = now()
  where id = p_share_id
    and status = 'pending'
    and (
      shared_with_user_id = auth.uid()
      or shared_with_email = v_email
    )
  returning * into v_share;

  if not found then
    raise exception 'Task share invitation was not found or cannot be declined';
  end if;

  return v_share;
end;
$$;

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

  if v_task.user_id <> auth.uid() and not exists (
    select 1
    from public.task_shares
    where task_shares.task_id = p_task_id
      and task_shares.status = 'accepted'
      and task_shares.role = 'contributor'
      and (
        task_shares.shared_with_user_id = auth.uid()
        or task_shares.shared_with_email = v_email
      )
  ) then
    raise exception 'You are not allowed to update this shared task';
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

revoke all on function public.accept_task_share(uuid) from public;
revoke all on function public.decline_task_share(uuid) from public;
revoke all on function public.update_shared_task_subtask_status(uuid, integer, text) from public;

grant execute on function public.accept_task_share(uuid) to authenticated;
grant execute on function public.decline_task_share(uuid) to authenticated;
grant execute on function public.update_shared_task_subtask_status(uuid, integer, text) to authenticated;
