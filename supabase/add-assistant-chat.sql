create table if not exists public.assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'שיחה פעילה',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.assistant_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  proposed_action jsonb,
  action_status text check (action_status in ('proposed', 'approved', 'done', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.assistant_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'done', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assistant_threads_user_updated_idx
  on public.assistant_threads(user_id, updated_at desc);

create index if not exists assistant_messages_thread_created_idx
  on public.assistant_messages(thread_id, created_at);

create index if not exists assistant_actions_message_idx
  on public.assistant_actions(message_id);

alter table public.assistant_threads enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_actions enable row level security;

drop policy if exists "Users can read own assistant threads" on public.assistant_threads;
drop policy if exists "Users can create own assistant threads" on public.assistant_threads;
drop policy if exists "Users can update own assistant threads" on public.assistant_threads;
drop policy if exists "Users can delete own assistant threads" on public.assistant_threads;

create policy "Users can read own assistant threads"
  on public.assistant_threads
  for select
  using (auth.uid() = user_id);

create policy "Users can create own assistant threads"
  on public.assistant_threads
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own assistant threads"
  on public.assistant_threads
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own assistant threads"
  on public.assistant_threads
  for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own assistant messages" on public.assistant_messages;
drop policy if exists "Users can create own assistant messages" on public.assistant_messages;
drop policy if exists "Users can update own assistant messages" on public.assistant_messages;
drop policy if exists "Users can delete own assistant messages" on public.assistant_messages;

create policy "Users can read own assistant messages"
  on public.assistant_messages
  for select
  using (auth.uid() = user_id);

create policy "Users can create own assistant messages"
  on public.assistant_messages
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_threads
      where assistant_threads.id = assistant_messages.thread_id
        and assistant_threads.user_id = auth.uid()
    )
  );

create policy "Users can update own assistant messages"
  on public.assistant_messages
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own assistant messages"
  on public.assistant_messages
  for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own assistant actions" on public.assistant_actions;
drop policy if exists "Users can create own assistant actions" on public.assistant_actions;
drop policy if exists "Users can update own assistant actions" on public.assistant_actions;
drop policy if exists "Users can delete own assistant actions" on public.assistant_actions;

create policy "Users can read own assistant actions"
  on public.assistant_actions
  for select
  using (auth.uid() = user_id);

create policy "Users can create own assistant actions"
  on public.assistant_actions
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_messages
      where assistant_messages.id = assistant_actions.message_id
        and assistant_messages.user_id = auth.uid()
    )
  );

create policy "Users can update own assistant actions"
  on public.assistant_actions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own assistant actions"
  on public.assistant_actions
  for delete
  using (auth.uid() = user_id);
