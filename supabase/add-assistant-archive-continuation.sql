alter table public.assistant_threads
  add column if not exists continued_from_thread_id uuid references public.assistant_threads(id) on delete set null;

create index if not exists assistant_threads_user_continuation_idx
  on public.assistant_threads(user_id, continued_from_thread_id)
  where continued_from_thread_id is not null and deleted_at is null;
