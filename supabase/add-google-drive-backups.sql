create table if not exists public.drive_backup_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_email text,
  folder_id text,
  encrypted_refresh_token text,
  timezone text not null default 'Asia/Jerusalem',
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error')),
  onboarding_prompt_count integer not null default 0 check (onboarding_prompt_count between 0 and 2),
  remind_after timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.drive_backup_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_id text not null,
  file_name text not null,
  backup_kind text not null check (backup_kind in ('hourly', 'daily', 'manual', 'pre_restore')),
  local_date date,
  task_count integer not null default 0,
  size_bytes bigint not null default 0,
  checksum text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists drive_backup_runs_user_created_idx
  on public.drive_backup_runs (user_id, created_at desc);

create unique index if not exists drive_backup_daily_unique
  on public.drive_backup_runs (user_id, backup_kind, local_date)
  where backup_kind = 'daily' and deleted_at is null;

alter table public.drive_backup_connections enable row level security;
alter table public.drive_backup_runs enable row level security;

revoke all on public.drive_backup_connections from anon, authenticated;
revoke all on public.drive_backup_runs from anon, authenticated;

alter table public.user_settings
  add column if not exists notification_preferences jsonb,
  add column if not exists analytics_preferences jsonb,
  add column if not exists theme text check (theme is null or theme in ('light', 'dark'));

create or replace function public.restore_drive_backup_snapshot(p_user_id uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null
     or jsonb_typeof(p_data -> 'tasks') <> 'array'
     or jsonb_typeof(p_data -> 'taxonomy') <> 'array' then
    raise exception 'invalid backup snapshot';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_data -> 'tasks') as item
    join public.tasks on tasks.id = (item ->> 'id')::uuid
    where tasks.user_id <> p_user_id
  ) then
    raise exception 'backup contains a task owned by another user';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_data -> 'taxonomy') as item
    join public.task_taxonomy_items on task_taxonomy_items.id = (item ->> 'id')::uuid
    where task_taxonomy_items.user_id <> p_user_id
  ) then
    raise exception 'backup contains taxonomy owned by another user';
  end if;

  update public.tasks
  set status = 'cancelled',
      status_changed_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and status not in ('done', 'cancelled')
    and not exists (
      select 1
      from jsonb_array_elements(p_data -> 'tasks') as item
      where (item ->> 'id')::uuid = tasks.id
    );

  insert into public.tasks (
    id, user_id, prefix, task_number, title, category, action_type, priority,
    status, notes, due_at, completed_at, status_changed_at, subtasks, focused,
    created_at, updated_at
  )
  select
    (item ->> 'id')::uuid,
    p_user_id,
    item ->> 'prefix',
    (item ->> 'task_number')::integer,
    item ->> 'title',
    coalesce(item ->> 'category', 'אישי'),
    item ->> 'action_type',
    (item ->> 'priority')::public.task_priority,
    (item ->> 'status')::public.task_status,
    item ->> 'notes',
    (item ->> 'due_at')::timestamptz,
    (item ->> 'completed_at')::timestamptz,
    coalesce((item ->> 'status_changed_at')::timestamptz, now()),
    coalesce(item -> 'subtasks', '[]'::jsonb),
    coalesce((item ->> 'focused')::boolean, false),
    coalesce((item ->> 'created_at')::timestamptz, now()),
    now()
  from jsonb_array_elements(p_data -> 'tasks') as item
  on conflict (id) do update set
    prefix = excluded.prefix,
    task_number = excluded.task_number,
    title = excluded.title,
    category = excluded.category,
    action_type = excluded.action_type,
    priority = excluded.priority,
    status = excluded.status,
    notes = excluded.notes,
    due_at = excluded.due_at,
    completed_at = excluded.completed_at,
    status_changed_at = excluded.status_changed_at,
    subtasks = excluded.subtasks,
    focused = excluded.focused,
    created_at = excluded.created_at,
    updated_at = now();

  delete from public.task_taxonomy_items where user_id = p_user_id;

  insert into public.task_taxonomy_items (id, user_id, item_type, prefix, name, created_at, updated_at)
  select
    coalesce((item ->> 'id')::uuid, gen_random_uuid()),
    p_user_id,
    item ->> 'item_type',
    item ->> 'prefix',
    item ->> 'name',
    coalesce((item ->> 'created_at')::timestamptz, now()),
    now()
  from jsonb_array_elements(p_data -> 'taxonomy') as item;

  if jsonb_typeof(p_data -> 'settings') = 'object' then
    insert into public.user_settings (
      user_id, display_name, notification_preferences, analytics_preferences, theme, updated_at
    ) values (
      p_user_id,
      p_data #>> '{settings,display_name}',
      p_data #> '{settings,notification_preferences}',
      p_data #> '{settings,analytics_preferences}',
      p_data #>> '{settings,theme}',
      now()
    )
    on conflict (user_id) do update set
      display_name = excluded.display_name,
      notification_preferences = excluded.notification_preferences,
      analytics_preferences = excluded.analytics_preferences,
      theme = excluded.theme,
      updated_at = now();
  end if;
end;
$$;

revoke all on function public.restore_drive_backup_snapshot(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.restore_drive_backup_snapshot(uuid, jsonb) to service_role;
