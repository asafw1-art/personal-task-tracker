create or replace function public.get_admin_overview()
returns table (
  total_users bigint,
  active_users_7d bigint,
  active_users_30d bigint,
  total_tasks bigint,
  active_tasks bigint,
  completed_tasks bigint,
  accepted_shares bigint,
  pending_shares bigint,
  generated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'asafw1@gmail.com' then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  return query
  select
    (select count(*) from auth.users),
    (select count(distinct user_id) from public.user_devices where last_seen_at >= now() - interval '7 days'),
    (select count(distinct user_id) from public.user_devices where last_seen_at >= now() - interval '30 days'),
    (select count(*) from public.tasks),
    (select count(*) from public.tasks where status not in ('done', 'cancelled')),
    (select count(*) from public.tasks where status = 'done'),
    (select count(*) from public.task_shares where status = 'accepted'),
    (select count(*) from public.task_shares where status = 'pending'),
    now();
end;
$$;

revoke all on function public.get_admin_overview() from public;
grant execute on function public.get_admin_overview() to authenticated;
