alter table public.assistant_threads
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_after timestamptz;

create index if not exists assistant_threads_user_deleted_idx
  on public.assistant_threads(user_id, deleted_at desc)
  where deleted_at is not null;

create index if not exists assistant_threads_user_active_idx
  on public.assistant_threads(user_id, updated_at desc)
  where deleted_at is null;
