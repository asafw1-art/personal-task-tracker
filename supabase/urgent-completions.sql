alter table public.assistant_threads
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_after timestamptz;

create index if not exists assistant_threads_user_deleted_idx
  on public.assistant_threads(user_id, deleted_at desc)
  where deleted_at is not null;

create index if not exists assistant_threads_user_active_idx
  on public.assistant_threads(user_id, updated_at desc)
  where deleted_at is null;

drop policy if exists "Users can update own assistant messages" on public.assistant_messages;
create policy "Users can update own assistant messages"
  on public.assistant_messages
  for update
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_threads
      where assistant_threads.id = assistant_messages.thread_id
        and assistant_threads.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_threads
      where assistant_threads.id = assistant_messages.thread_id
        and assistant_threads.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own assistant actions" on public.assistant_actions;
create policy "Users can update own assistant actions"
  on public.assistant_actions
  for update
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_messages
      where assistant_messages.id = assistant_actions.message_id
        and assistant_messages.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.assistant_messages
      where assistant_messages.id = assistant_actions.message_id
        and assistant_messages.user_id = auth.uid()
    )
  );
