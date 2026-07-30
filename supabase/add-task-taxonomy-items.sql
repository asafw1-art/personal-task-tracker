create table if not exists public.task_taxonomy_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('topic', 'action')),
  prefix text check (prefix in ('P', 'W')),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (item_type = 'topic' and prefix is not null)
    or (item_type = 'action' and prefix is null)
  ),
  unique (user_id, item_type, prefix, name)
);

alter table public.task_taxonomy_items enable row level security;

drop policy if exists "Users can read own taxonomy items" on public.task_taxonomy_items;
drop policy if exists "Users can create own taxonomy items" on public.task_taxonomy_items;
drop policy if exists "Users can update own taxonomy items" on public.task_taxonomy_items;
drop policy if exists "Users can delete own taxonomy items" on public.task_taxonomy_items;

create policy "Users can read own taxonomy items"
  on public.task_taxonomy_items
  for select
  using (auth.uid() = user_id);

create policy "Users can create own taxonomy items"
  on public.task_taxonomy_items
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own taxonomy items"
  on public.task_taxonomy_items
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own taxonomy items"
  on public.task_taxonomy_items
  for delete
  using (auth.uid() = user_id);
