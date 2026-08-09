alter table public.tasks
  add column if not exists focused boolean not null default false;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users can read own settings" on public.user_settings;
drop policy if exists "Users can create own settings" on public.user_settings;
drop policy if exists "Users can update own settings" on public.user_settings;
drop policy if exists "Users can delete own settings" on public.user_settings;

create policy "Users can read own settings"
  on public.user_settings
  for select
  using (auth.uid() = user_id);

create policy "Users can create own settings"
  on public.user_settings
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own settings"
  on public.user_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own settings"
  on public.user_settings
  for delete
  using (auth.uid() = user_id);
