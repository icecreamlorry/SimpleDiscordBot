import { deleteMessages } from "./messages.js";
import { isProtected } from "./protect.js";

/** Purges keep messages the bot has shielded, and pinned ones if asked. */
export function survivesPurge(message, job) {
  return isProtected(message) || (job.keep_pinned === 1 && message.pinned === true);
}

// Each page of 100 messages costs some CPU to parse; Workers Free allows ~10 ms per run.
const MAX_PAGES_PER_RUN = 8;

/**
 * Deletes messages newest-first, one page at a time. Returns true when the channel is empty
 * (apart from protected messages, and pinned ones if keeping them).
 */
export async function purgeStep(db, discord, job, progress) {
  const channel = job.channel_id;
  let cursor = job.cursor;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const messages = await discord.request("GET", `/channels/${channel}/messages?limit=100${cursor ? `&before=${cursor}` : ""}`);
    const ids = messages.filter((m) => !survivesPurge(m, job)).map((m) => m.id);
    const total = ids.length;
    try {
      await deleteMessages(discord, channel, ids);
    } finally {
      progress.count += total - ids.length;
      await db.prepare("UPDATE purge_jobs SET deleted = ? WHERE id = ?").bind(progress.count, job.id).run();
    }

    if (messages.length < 100) return true;
    // Everything newer than the oldest message on this page has been handled
    // (deleted, or kept), so the next page starts below it.
    cursor = messages[messages.length - 1].id;
    await db.prepare("UPDATE purge_jobs SET cursor = ? WHERE id = ?").bind(cursor, job.id).run();
  }
  return false;
}
