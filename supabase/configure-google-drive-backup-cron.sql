-- Run only after replacing both placeholders below.
-- The endpoint must be the production URL ending with /api/cron/drive-backups.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.update_secret(
  id,
  'https://personal-task-tracker-nine-vert.vercel.app/api/cron/drive-backups',
  'drive_backup_endpoint'
)
from vault.secrets
where name = 'drive_backup_endpoint';

select vault.create_secret(
  'https://personal-task-tracker-nine-vert.vercel.app/api/cron/drive-backups',
  'drive_backup_endpoint'
)
where not exists (
  select 1 from vault.secrets where name = 'drive_backup_endpoint'
);

select vault.update_secret(
  id,
  'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL',
  'drive_backup_cron_secret'
)
from vault.secrets
where name = 'drive_backup_cron_secret';

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_CRON_SECRET_USED_IN_VERCEL',
  'drive_backup_cron_secret'
)
where not exists (
  select 1 from vault.secrets where name = 'drive_backup_cron_secret'
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'personal-task-tracker-drive-backup-hourly';

select cron.schedule(
  'personal-task-tracker-drive-backup-hourly',
  '5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'drive_backup_endpoint'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'drive_backup_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    ) as request_id;
  $job$
);
