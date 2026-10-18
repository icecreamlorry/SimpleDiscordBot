-- purge-anonymise jobs: messages deleted in the purge phase, kept for the final report
-- ("deleted" then counts reposts in the anonymise phase).
ALTER TABLE purge_jobs ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
