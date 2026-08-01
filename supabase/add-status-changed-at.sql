alter table public.tasks
  add column if not exists status_changed_at timestamptz;

update public.tasks
set status_changed_at = coalesce(completed_at, created_at, now())
where status_changed_at is null;

alter table public.tasks
  alter column status_changed_at set default now(),
  alter column status_changed_at set not null;
