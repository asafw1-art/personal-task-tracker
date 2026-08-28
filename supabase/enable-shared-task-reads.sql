drop policy if exists "Users can read own tasks" on public.tasks;
drop policy if exists "Users can read own and accepted shared tasks" on public.tasks;

create policy "Users can read own and accepted shared tasks"
  on public.tasks
  for select
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.task_shares
      where task_shares.task_id = tasks.id
        and task_shares.status = 'accepted'
        and (
          task_shares.shared_with_user_id = auth.uid()
          or task_shares.shared_with_email = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
  );

drop policy if exists "Owners can update task shares" on public.task_shares;
drop policy if exists "Owners can revoke task shares" on public.task_shares;

create policy "Owners can revoke task shares"
  on public.task_shares
  for update
  using (auth.uid() = owner_user_id)
  with check (
    auth.uid() = owner_user_id
    and status in ('pending', 'accepted', 'revoked')
  );
