-- What a schedule does: 'purge' (delete everything) or 'anonymise' (repost as the bot).
ALTER TABLE schedules ADD COLUMN action TEXT NOT NULL DEFAULT 'purge';
