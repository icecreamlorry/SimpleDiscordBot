-- Anonymise jobs: the real posting date of the last message left untouched at the top of
-- the channel, so the bot can skip a divider where Discord already shows the same date.
ALTER TABLE purge_jobs ADD COLUMN kept_date TEXT;
