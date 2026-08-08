alter table public.tasks
  add column if not exists subtasks jsonb;

update public.tasks
set subtasks = '[]'::jsonb
where subtasks is null;

alter table public.tasks
  alter column subtasks set default '[]'::jsonb,
  alter column subtasks set not null;
