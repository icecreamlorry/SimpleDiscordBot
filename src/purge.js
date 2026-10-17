import { DiscordError, OutOfBudget } from "./discord.js";

const DISCORD_EPOCH = 1420070400000n;
// Discord only bulk-deletes messages under 14 days old; leave an hour of margin.
const BULK_MAX_AGE_MS = (14 * 24 - 1) * 60 * 60 * 1000;
// Each page of 100 messages costs some CPU to parse; Workers Free allows ~10 ms per run.
const MAX_PAGES_PER_RUN = 8;
const LEASE_SLACK_MS = 20_000;

// Discord error codes
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

function messageTime(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Queues a purge. Returns false if one is already running for that channel. */
export async function createJob(db, guildId, channelId, keepPinned) {
  const result = await db
    .prepare(
      `INSERT INTO purge_jobs (guild_id, channel_id, keep_pinned, deleted, created_at)
       VALUES (?, ?, ?, 0, ?) ON CONFLICT (channel_id) DO NOTHING`,
    )
    .bind(guildId, channelId, keepPinned ? 1 : 0, Date.now())
    .run();
  return result.meta.changes > 0;
}

export async function getJob(db, channelId) {
  return db.prepare("SELECT * FROM purge_jobs WHERE channel_id = ?").bind(channelId).first();
}

/**
 * Deletes messages for one job until the channel is empty or this invocation runs out of
 * requests/time. Progress is saved after every page, so the next cron run carries on.
 *
 * Returns { status: "done" | "partial" | "locked" | "failed", deleted, error? }.
 */
export async function runJob(db, discord, job) {
  const now = Date.now();
  const lease = await db
    .prepare("UPDATE purge_jobs SET locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)")
    .bind(Math.min(discord.deadline, now + 15 * 60_000) + LEASE_SLACK_MS, job.id, now)
    .run();
  if (lease.meta.changes === 0) return { status: "locked", deleted: job.deleted };

  let { cursor, deleted } = job;
  const channel = job.channel_id;
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const messages = await discord.request("GET", `/channels/${channel}/messages?limit=100${cursor ? `&before=${cursor}` : ""}`);
      const targets = job.keep_pinned ? messages.filter((m) => !m.pinned) : messages;
      const cutoff = Date.now() - BULK_MAX_AGE_MS;
      const recent = targets.filter((m) => messageTime(m.id) > cutoff).map((m) => m.id);
      const old = targets.filter((m) => messageTime(m.id) <= cutoff).map((m) => m.id);

      if (recent.length >= 2) {
        await discord.request("POST", `/channels/${channel}/messages/bulk-delete`, { json: { messages: recent } });
      } else {
        old.unshift(...recent); // Bulk delete needs at least 2 messages.
      }
      deleted += recent.length >= 2 ? recent.length : 0;

      for (const id of old) {
        try {
          await discord.request("DELETE", `/channels/${channel}/messages/${id}`);
        } catch (e) {
          if (!(e instanceof DiscordError && e.code === UNKNOWN_MESSAGE)) throw e;
        }
        deleted++;
        await db.prepare("UPDATE purge_jobs SET deleted = ? WHERE id = ?").bind(deleted, job.id).run();
      }

      if (messages.length < 100) {
        await db.prepare("DELETE FROM purge_jobs WHERE id = ?").bind(job.id).run();
        return { status: "done", deleted };
      }
      // Everything newer than the oldest message on this page has been handled
      // (deleted, or pinned and kept), so the next page starts below it.
      cursor = messages[messages.length - 1].id;
      await db.prepare("UPDATE purge_jobs SET cursor = ?, deleted = ? WHERE id = ?").bind(cursor, deleted, job.id).run();
    }
  } catch (e) {
    if (!(e instanceof DiscordError)) {
      await releaseLease(db, job.id);
      if (e instanceof OutOfBudget) return { status: "partial", deleted };
      throw e;
    }
    // Missing channel or permissions: give up on this job rather than retrying forever.
    await db.prepare("DELETE FROM purge_jobs WHERE id = ?").bind(job.id).run();
    if (e.code === UNKNOWN_CHANNEL) {
      await db.prepare("DELETE FROM schedules WHERE channel_id = ?").bind(channel).run();
    }
    console.error(JSON.stringify({ event: "purge_failed", channel_id: channel, status: e.status, code: e.code, message: e.message }));
    return { status: "failed", deleted, error: e };
  }
  await releaseLease(db, job.id);
  return { status: "partial", deleted };
}

function releaseLease(db, jobId) {
  return db.prepare("UPDATE purge_jobs SET locked_until = NULL WHERE id = ?").bind(jobId).run();
}

/** Human-readable reason for a failed purge. */
export function describeFailure(error) {
  if (error?.code === UNKNOWN_CHANNEL) return "that channel no longer exists.";
  if (error?.status === 403) return "I'm missing permissions there (I need View Channel, Read Message History and Manage Messages).";
  return error?.message ?? "something went wrong.";
}
