-- Anonymise jobs: the last date marked with a divider in the channel, and the date of the
-- messages being read (for the bot's earlier reposts, whose own timestamps are repost times).
ALTER TABLE purge_jobs ADD COLUMN last_date TEXT;
ALTER TABLE purge_jobs ADD COLUMN source_date TEXT;
