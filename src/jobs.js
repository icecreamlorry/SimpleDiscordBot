// Channel jobs (purge or anonymise) that run a chunk at a time across invocations.
import { DiscordError, OutOfBudget } from "./discord.js";
import { anonymiseStep, copyThreadStep } from "./anonymise.js";
import { purgeStep } from "./purge.js";
import { JobError, snowflakeAt } from "./messages.js";

export { JobError };

const LEASE_SLACK_MS = 20_000;
const UNKNOWN_CHANNEL = 10003;

const STEPS = { purge: purgeStep, anonymise: anonymiseStep, "copy-thread": copyThreadStep };

/** The INSERT for a job; ignored if a job already exists for that channel. */
export function jobInsert(
  db,
  guildId,
  channelId,
  { keepPinned = false, mode = "purge", endId = snowflakeAt(Date.now()), targetChannelId = null, threadParentId = null, restoreArchived = false, restoreLocked = false } = {},
) {
  return db
    .prepare(
      `INSERT INTO purge_jobs (guild_id, channel_id, keep_pinned, mode, end_id, target_channel_id, thread_parent_id,
                               restore_archived, restore_locked, deleted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (channel_id) DO NOTHING`,
    )
    .bind(guildId, channelId, keepPinned ? 1 : 0, mode, endId, targetChannelId, threadParentId, restoreArchived ? 1 : 0, restoreLocked ? 1 : 0, 0, Date.now());
}

/** Queues a job. Returns false if one is already running for that channel. */
export async function createJob(db, guildId, channelId, options) {
  const result = await jobInsert(db, guildId, channelId, options).run();
  return result.meta.changes > 0;
}

export async function getJob(db, channelId) {
  return db.prepare("SELECT * FROM purge_jobs WHERE channel_id = ?").bind(channelId).first();
}

/**
 * Works on one job until it finishes or this invocation runs out of requests/time.
 * Progress is saved as it goes, so the next cron run carries on.
 *
 * Returns { status: "done" | "partial" | "locked" | "failed", count, error? }, where count is
 * messages deleted (purge) or reposted (anonymise).
 */
export async function runJob(db, discord, job) {
  const now = Date.now();
  const lease = await db
    .prepare("UPDATE purge_jobs SET locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)")
    .bind(Math.min(discord.deadline, now + 15 * 60_000) + LEASE_SLACK_MS, job.id, now)
    .run();
  if (lease.meta.changes === 0) return { status: "locked", count: job.deleted };

  const progress = { count: job.deleted };
  try {
    const done = await STEPS[job.mode ?? "purge"](db, discord, job, progress);
    if (done) {
      await db.prepare("DELETE FROM purge_jobs WHERE id = ?").bind(job.id).run();
      return { status: "done", count: progress.count };
    }
  } catch (e) {
    if (e instanceof OutOfBudget) {
      // Fall through: keep the job for the next run.
    } else if (e instanceof DiscordError || e instanceof JobError) {
      // Missing channel, permissions or intent: give up rather than retrying forever.
      await db.prepare("DELETE FROM purge_jobs WHERE id = ?").bind(job.id).run();
      if (e.code === UNKNOWN_CHANNEL) {
        await db.prepare("DELETE FROM schedules WHERE channel_id = ?").bind(job.channel_id).run();
      }
      console.error(JSON.stringify({ event: "job_failed", mode: job.mode, channel_id: job.channel_id, status: e.status, code: e.code, message: e.message }));
      return { status: "failed", count: progress.count, error: e };
    } else {
      await releaseLease(db, job.id);
      throw e;
    }
  }
  await releaseLease(db, job.id);
  return { status: "partial", count: progress.count };
}

function releaseLease(db, jobId) {
  return db.prepare("UPDATE purge_jobs SET locked_until = NULL WHERE id = ?").bind(jobId).run();
}

/** Human-readable reason for a failed job. */
export function describeFailure(error) {
  if (error instanceof JobError) return error.message;
  if (error?.code === UNKNOWN_CHANNEL) return "that channel no longer exists.";
  if (error?.status === 403) return "I'm missing permissions there.";
  return error?.message ?? "something went wrong.";
}
