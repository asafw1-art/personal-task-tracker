alter table public.assistant_threads
  add column if not exists archived_at timestamptz;

create index if not exists assistant_threads_user_archived_idx
  on public.assistant_threads(user_id, archived_at desc)
  where archived_at is not null and deleted_at is null;

create index if not exists assistant_threads_user_current_idx
  on public.assistant_threads(user_id, updated_at desc)
  where archived_at is null and deleted_at is null;
