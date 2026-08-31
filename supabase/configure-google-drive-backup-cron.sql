-- Run only after replacing both placeholders below.
-- The endpoint must be the production URL ending with /api/cron/drive-backups.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  endpoint_secret_id uuid;
  cron_secret_id uuid;
begin
  select id into endpoint_secret_id from vault.secrets where name = 'drive_backup_endpoint';
  if endpoint_secret_id is null then
    perform vault.create_secret(
      'https://personal-task-tracker-nine-vert.vercel.app/api/cron/drive-backups',
      'drive_backup_endpoint'
    );
  else
    perform vault.update_secret(
      endpoint_secret_id,
      'https://personal-task-tracker-nine-vert.vercel.app/api/cron/drive-backups',
      'drive_backup_endpoint'
    );
  end if;

  select id into cron_secret_id from vault.secrets where name = 'drive_backup_cron_secret';
  if cron_secret_id is null then
    perform vault.create_secret(
      'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL',
      'drive_backup_cron_secret'
    );
  else
    perform vault.update_secret(
      cron_secret_id,
      'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL',
      'drive_backup_cron_secret'
    );
  end if;
end;
$$;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'personal-task-tracker-drive-backup-hourly';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end;
$$;

select cron.schedule(
  'personal-task-tracker-drive-backup-hourly',
  '5 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'drive_backup_endpoint'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'drive_backup_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ) as request_id;
  $$
);
