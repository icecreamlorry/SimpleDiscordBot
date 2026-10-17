-- purge_jobs now holds purges, anonymise jobs and thread copies.
-- None of these columns hold message content or anything about users.

-- 'purge', 'anonymise' (repost in place, then delete originals), or 'copy-thread'
-- (repost a thread's messages into a new thread, then delete the old thread).
ALTER TABLE purge_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'purge';
-- Anonymise only touches messages older than this ID (posted before the job started).
-- NULL for copy-thread, which copies everything because the old thread is deleted afterwards.
ALTER TABLE purge_jobs ADD COLUMN end_id TEXT;
-- JSON array of original message IDs that have been reposted but not yet deleted.
ALTER TABLE purge_jobs ADD COLUMN pending_deletes TEXT;
-- copy-thread: the new thread the messages are reposted into.
ALTER TABLE purge_jobs ADD COLUMN target_channel_id TEXT;
-- Set when the job's channel is a thread: the channel the thread belongs to.
ALTER TABLE purge_jobs ADD COLUMN thread_parent_id TEXT;
-- Anonymise of a channel: 'messages', then 'threads' (finding standalone threads).
ALTER TABLE purge_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'messages';
-- Thread jobs: whether the thread was archived/locked, to put it back that way afterwards.
ALTER TABLE purge_jobs ADD COLUMN restore_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purge_jobs ADD COLUMN restore_locked INTEGER NOT NULL DEFAULT 0;
