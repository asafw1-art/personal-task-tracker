-- Operational metadata only. No prompts, tasks, tokens or email addresses.
create table if not exists public.service_health (
  service_id text primary key check (service_id in ('gemini','gateway','database','drive','scheduler')),
  state text not null check (state in ('healthy','degraded','error','disabled','unconfigured','unknown')),
  reason text not null check (reason ~ '^[a-z_]{1,60}$'),
  source text not null check (source in ('request','probe','policy','scheduler')),
  checked_at timestamptz not null,
  last_success_at timestamptz,
  incident_id uuid
);
alter table public.service_health enable row level security;
revoke all on public.service_health from public, anon, authenticated;
grant select on public.service_health to authenticated;
grant all on public.service_health to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'service_health' and policyname = 'Admin can read service health') then
    create policy "Admin can read service health" on public.service_health for select to authenticated
      using (auth.uid() is not null and lower(coalesce(auth.jwt()->>'email','')) = 'asafw1@gmail.com');
  end if;
end $$;

create or replace function public.record_service_health(p_service_id text, p_state text, p_reason text, p_source text, p_checked_at timestamptz)
returns void language sql security definer set search_path = public as $$
  insert into public.service_health as old (service_id,state,reason,source,checked_at,last_success_at,incident_id)
  values (p_service_id,p_state,p_reason,p_source,p_checked_at,
    case when p_state = 'healthy' then p_checked_at end,
    case when p_state <> 'healthy' then gen_random_uuid() end)
  on conflict (service_id) do update set
    state = excluded.state, reason = excluded.reason, source = excluded.source, checked_at = excluded.checked_at,
    last_success_at = coalesce(excluded.last_success_at, old.last_success_at),
    incident_id = case when excluded.state = 'healthy' then null
      when old.state = excluded.state and old.reason = excluded.reason then old.incident_id
      else excluded.incident_id end
  where excluded.checked_at >= old.checked_at;
$$;
revoke all on function public.record_service_health(text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_service_health(text,text,text,text,timestamptz) to service_role;
