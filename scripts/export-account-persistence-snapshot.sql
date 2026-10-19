-- AFTER package 7 installs the staged schema. Read-only; administrator SQL editor only.
-- Contains private account data. Download locally; never commit or upload without approval.
select public.persistence_export_account_v1(
  (select id from auth.users where lower(email)=lower('ACCOUNT_EMAIL_HERE'))
) as snapshot;
