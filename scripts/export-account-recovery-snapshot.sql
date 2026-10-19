-- Read-only, single-statement MVCC snapshot for ONE account.
-- Replace ACCOUNT_EMAIL_HERE only inside the authorized SQL editor.
-- Output contains private account data. Never commit, publish, or send to an AI provider.
with owner_account as (
  select id from auth.users where lower(email) = lower('ACCOUNT_EMAIL_HERE')
), account_data as (
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.tasks t where t.user_id = o.id), '[]'::jsonb),
    'task_taxonomy_items', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.task_taxonomy_items t where t.user_id = o.id), '[]'::jsonb),
    'user_settings', coalesce((select jsonb_agg(to_jsonb(t)) from public.user_settings t where t.user_id = o.id), '[]'::jsonb),
    'task_shares', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.task_shares t where t.owner_user_id = o.id), '[]'::jsonb),
    'task_subtask_assignments', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.task_subtask_assignments t where t.owner_user_id = o.id), '[]'::jsonb),
    'assistant_threads', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.assistant_threads t where t.user_id = o.id), '[]'::jsonb),
    'assistant_messages', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.assistant_messages t where t.user_id = o.id), '[]'::jsonb),
    'assistant_actions', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.assistant_actions t where t.user_id = o.id), '[]'::jsonb),
    'notification_receipts', coalesce((select jsonb_agg(to_jsonb(t) order by t.event_key, t.kind) from public.notification_receipts t where t.user_id = o.id), '[]'::jsonb),
    'user_devices', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from public.user_devices t where t.user_id = o.id), '[]'::jsonb)
  ) as data, o.id as owner_user_id from owner_account o
)
select jsonb_build_object(
  'format', 'task-tracker-account-recovery', 'version', 1,
  'captured_at', statement_timestamp(), 'owner_user_id', a.owner_user_id,
  'data', a.data,
  'incoming_share_references', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'owner_user_id', s.owner_user_id, 'status', s.status, 'role', s.role) order by s.id)
    from public.task_shares s where s.owner_user_id <> a.owner_user_id
      and (s.shared_with_user_id = a.owner_user_id or s.shared_with_email = lower('ACCOUNT_EMAIL_HERE'))
  ), '[]'::jsonb),
  'live_columns', (
    select jsonb_object_agg(t.table_name, t.columns)
    from (
      select c.table_name, jsonb_agg(c.column_name order by c.ordinal_position) as columns
      from information_schema.columns c
      where c.table_schema = 'public' and a.data ? c.table_name group by c.table_name
    ) t
  ),
  'task_number_floor', jsonb_build_object(
    'P', coalesce((select max(t.task_number) from public.tasks t where t.user_id = a.owner_user_id and t.prefix = 'P'), 0),
    'W', coalesce((select max(t.task_number) from public.tasks t where t.user_id = a.owner_user_id and t.prefix = 'W'), 0)
  ),
  'restore_function', pg_get_functiondef('public.restore_drive_backup_snapshot(uuid,jsonb)'::regprocedure),
  'exclusions', jsonb_build_array('Auth credentials and sessions', 'OAuth refresh tokens and application secrets', 'Other accounts and their task content', 'Drive backup files', 'Browser-only unsynced data', 'Hosting and database configuration'),
  'incoming_shares_restore_policy', 'References only; never recreate access to another owner without server revalidation'
) as account_snapshot from account_data a;
