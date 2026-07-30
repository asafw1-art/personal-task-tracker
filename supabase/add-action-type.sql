alter table public.tasks
  add column if not exists action_type text;
