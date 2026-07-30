create type public.task_status as enum ('open', 'in_progress', 'waiting', 'done', 'cancelled');
create type public.task_priority as enum ('high', 'important', 'normal', 'low');

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prefix text not null check (prefix in ('P', 'W')),
  task_number integer not null check (task_number > 0),
  title text not null,
  category text not null default 'אישי',
  action_type text,
  priority public.task_priority not null default 'normal',
  status public.task_status not null default 'open',
  notes text,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, prefix, task_number)
);

alter table public.tasks enable row level security;
create policy "Users can read own tasks" on public.tasks for select using (auth.uid() = user_id);
create policy "Users can create own tasks" on public.tasks for insert with check (auth.uid() = user_id);
create policy "Users can update own tasks" on public.tasks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own tasks" on public.tasks for delete using (auth.uid() = user_id);

create table public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_name text not null,
  device_type text not null check (device_type in ('mobile', 'tablet', 'desktop', 'unknown')),
  browser_name text not null default 'unknown',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id)
);

alter table public.user_devices enable row level security;
create policy "Users can read own devices" on public.user_devices for select using (auth.uid() = user_id);
create policy "Users can create own devices" on public.user_devices for insert with check (auth.uid() = user_id);
create policy "Users can update own devices" on public.user_devices for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own devices" on public.user_devices for delete using (auth.uid() = user_id);
