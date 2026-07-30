drop policy if exists "Users can update own tasks" on public.tasks;
create policy "Users can update own tasks"
  on public.tasks
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own devices" on public.user_devices;
create policy "Users can update own devices"
  on public.user_devices
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
