begin;

create table if not exists public.notification_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null check (length(event_key) between 1 and 500),
  kind text not null check (kind in ('read', 'announced')),
  created_at timestamptz not null default now(),
  primary key (user_id, event_key, kind)
);

alter table public.notification_receipts enable row level security;
revoke all on public.notification_receipts from anon, authenticated;
grant select, insert on public.notification_receipts to authenticated;

drop policy if exists "Read own notification receipts" on public.notification_receipts;
create policy "Read own notification receipts" on public.notification_receipts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Insert own notification receipts" on public.notification_receipts;
create policy "Insert own notification receipts" on public.notification_receipts
  for insert to authenticated with check ((select auth.uid()) = user_id);

commit;
