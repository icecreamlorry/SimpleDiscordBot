-- Only server IDs, channel IDs and timing settings are stored. No user data.

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  time TEXT NOT NULL,                    -- HH:MM in BOT_TIMEZONE
  day TEXT NOT NULL,                     -- 'daily', or '0'-'6' with Monday = 0
  keep_pinned INTEGER NOT NULL DEFAULT 0,
  last_run TEXT                          -- local date of the last run, YYYY-MM-DD
);
CREATE INDEX schedules_guild ON schedules (guild_id);

-- Purges in progress. Large channels are cleared a chunk at a time across cron runs.
CREATE TABLE purge_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  keep_pinned INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,                           -- oldest message ID already handled
  deleted INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,                  -- ms timestamp; stops two runs working on one job
  created_at INTEGER NOT NULL
);
