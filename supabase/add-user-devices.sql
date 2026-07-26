create table if not exists public.user_devices (
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

drop policy if exists "Users can read own devices" on public.user_devices;
drop policy if exists "Users can create own devices" on public.user_devices;
drop policy if exists "Users can update own devices" on public.user_devices;
drop policy if exists "Users can delete own devices" on public.user_devices;

create policy "Users can read own devices" on public.user_devices for select using (auth.uid() = user_id);
create policy "Users can create own devices" on public.user_devices for insert with check (auth.uid() = user_id);
create policy "Users can update own devices" on public.user_devices for update using (auth.uid() = user_id);
create policy "Users can delete own devices" on public.user_devices for delete using (auth.uid() = user_id);
