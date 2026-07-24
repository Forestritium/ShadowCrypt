
-- Enable pg_cron extension for scheduled jobs
create extension if not exists pg_cron with schema extensions;

-- Grant usage so the cron scheduler can execute jobs
grant usage on schema cron to postgres;

-- Schedule a daily job at 02:00 UTC to delete messages older than 30 days.
-- Each user owns their own rows (owner_id), so this sweeps every account.
select cron.schedule(
  'auto-delete-messages-older-than-30-days',
  '0 2 * * *',
  $$
    delete from public.messages
    where created_at < now() - interval '30 days';
  $$
);
