create type public.task_status as enum ('open', 'in_progress', 'waiting', 'done', 'cancelled');
create type public.task_priority as enum ('high', 'important', 'normal', 'low');

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prefix text not null check (prefix in ('P', 'W')),
  task_number integer not null check (task_number > 0),
  title text not null,
  category text not null default 'אישי',
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
create policy "Users can update own tasks" on public.tasks for update using (auth.uid() = user_id);
create policy "Users can delete own tasks" on public.tasks for delete using (auth.uid() = user_id);
