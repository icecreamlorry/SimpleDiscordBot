// Helpers for working with Discord message IDs and deletion.
import { DiscordError } from "./discord.js";

const DISCORD_EPOCH = 1420070400000n;
// Discord only bulk-deletes messages under 14 days old; leave an hour of margin.
const BULK_MAX_AGE_MS = (14 * 24 - 1) * 60 * 60 * 1000;
const UNKNOWN_MESSAGE = 10008;
// Some system messages (e.g. a thread's link back to its starter message) can't be deleted.
const SYSTEM_MESSAGE = 50021;
const ignorable = (e) => e instanceof DiscordError && (e.code === UNKNOWN_MESSAGE || e.code === SYSTEM_MESSAGE);

/** A job that can't continue for a reason the user should see. */
export class JobError extends Error {}

export function messageTime(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** The smallest possible message ID at the given time; every earlier message has a lower ID. */
export function snowflakeAt(ms) {
  return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
}

export function compareIds(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isRecent(id) {
  return messageTime(id) > Date.now() - BULK_MAX_AGE_MS;
}

export async function deleteMessage(discord, channelId, id) {
  try {
    await discord.request("DELETE", `/channels/${channelId}/messages/${id}`);
  } catch (e) {
    if (!ignorable(e)) throw e;
  }
}

/**
 * Deletes the given message IDs, removing each from the array as it goes so the caller can
 * save what's left if this runs out of budget part-way. Uses bulk delete where possible.
 */
export async function deleteMessages(discord, channelId, ids) {
  while (ids.length) {
    const recent = ids.filter(isRecent).slice(0, 100);
    if (recent.length >= 2) {
      try {
        await discord.request("POST", `/channels/${channelId}/messages/bulk-delete`, { json: { messages: recent } });
        for (const id of recent) ids.splice(ids.indexOf(id), 1);
        continue;
      } catch (e) {
        // A message in the batch was already gone or can't be deleted; go one at a time.
        if (!ignorable(e)) throw e;
      }
    }
    await deleteMessage(discord, channelId, ids[0]);
    ids.shift();
  }
}
