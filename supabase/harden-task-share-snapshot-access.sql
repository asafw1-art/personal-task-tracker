-- Internal helper: callers must use the authorized sharing RPCs instead.
-- Explicit role grants survive a revoke from PUBLIC alone.
begin;

revoke all on function public.task_share_snapshot(uuid) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.task_share_snapshot(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.task_share_snapshot(uuid)', 'EXECUTE') then
    raise exception 'Snapshot helper still has client execution privileges';
  end if;
end;
$$;

commit;
