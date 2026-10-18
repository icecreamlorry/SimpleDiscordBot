// Reposts every message in a channel as the bot, oldest first, then deletes the originals,
// so the channel keeps the same messages in the same order without showing who wrote them.
//
// Threads are handled too:
// - A thread started from a message is rebuilt under the repost of that message by a
//   separate "copy-thread" job, which then deletes the old thread.
// - Standalone threads (public or private, active or archived) are found once the channel's
//   messages are done, and each is anonymised in place by its own job.
//
// Message content is only held in memory while a message is being reposted. Jobs store
// just a cursor and the IDs of originals that have been reposted but not yet deleted.
import { DiscordError, OutOfBudget } from "./discord.js";
import { jobInsert } from "./jobs.js";
import { JobError, compareIds, deleteMessages } from "./messages.js";
import { formatPoll } from "./poll.js";

const MAX_PAGES_PER_RUN = 3;
const MAX_CONTENT = 2000;
// Bots can upload 10 MB per file on servers without boosts. Larger files are noted instead.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Keep total attachment memory well under the Worker's 128 MB.
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
// Delete reposted originals in batches of this size.
const FLUSH_AT = 10;

const MessageType = { DEFAULT: 0, THREAD_CREATED: 18, REPLY: 19, CHAT_INPUT_COMMAND: 20, CONTEXT_MENU_COMMAND: 23 };
// Anything else (joins, boosts, "pinned a message" notices...) is a system message: it is
// deleted but not reposted.
const REPOSTABLE_TYPES = new Set([MessageType.DEFAULT, MessageType.REPLY, MessageType.CHAT_INPUT_COMMAND, MessageType.CONTEXT_MENU_COMMAND]);
const SUPPRESS_EMBEDS = 1 << 2;
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const UNKNOWN_CHANNEL = 10003;

/** Splits text into chunks Discord will accept, preferring to break at newlines, then spaces. */
export function splitContent(text, limit = MAX_CONTENT) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function threadInfo(thread) {
  return {
    id: thread.id,
    name: thread.name,
    autoArchive: thread.thread_metadata?.auto_archive_duration ?? 10080,
    archived: thread.thread_metadata?.archived === true,
    locked: thread.thread_metadata?.locked === true,
  };
}

/**
 * Works out how to repost a message. Returns null for messages that should only be deleted.
 * Throws if the message looks empty because the bot can't read message content.
 */
export function buildRepost(message) {
  const base = { files: [], embeds: [], flags: SUPPRESS_NOTIFICATIONS, pinned: false, thread: null };

  // "X started a thread": replace with a link to the thread, which names nobody.
  if (message.type === MessageType.THREAD_CREATED) {
    const threadId = message.message_reference?.channel_id ?? message.thread?.id;
    return threadId ? { ...base, chunks: [`🧵 Thread: <#${threadId}>`] } : null;
  }
  if (!REPOSTABLE_TYPES.has(message.type)) return null;

  // Forwarded messages keep their content in a snapshot.
  const source = message.message_snapshots?.[0]?.message ?? message;
  const notes = [];
  for (const sticker of source.sticker_items ?? []) notes.push(`[sticker: ${sticker.name}]`);
  if (source.poll) notes.push(formatPoll(source.poll));

  const files = [];
  let totalBytes = 0;
  for (const a of source.attachments ?? []) {
    if (a.size > MAX_FILE_BYTES || totalBytes + a.size > MAX_MESSAGE_BYTES) {
      notes.push(`[attachment too large to repost: ${a.filename}]`);
    } else {
      files.push({ url: a.url, filename: a.filename, description: a.description });
      totalBytes += a.size;
    }
  }
  // Link previews come back on their own; only bots' hand-made embeds need copying.
  const embeds = message.author?.bot ? (source.embeds ?? []).filter((e) => e.type === "rich") : [];

  const text = [source.content ?? "", ...notes].filter(Boolean).join("\n");
  if (!text && !files.length && !embeds.length) {
    if (message.author?.bot) return null; // e.g. a bot message that was only buttons
    throw new JobError(
      "I can't read message text. Turn on **Message Content Intent** for the bot in the Discord Developer Portal (Bot page), then try again. Nothing was changed.",
    );
  }

  return {
    chunks: text ? splitContent(text) : [""],
    files,
    embeds,
    flags: SUPPRESS_NOTIFICATIONS | (message.flags & SUPPRESS_EMBEDS),
    pinned: message.pinned === true,
    thread: message.thread ? threadInfo(message.thread) : null,
  };
}

/** Requests needed to repost (downloads + posts + pin + new thread). */
function repostCost(plan) {
  return plan.files.length + plan.chunks.length + (plan.pinned ? 1 : 0) + (plan.thread ? 1 : 0);
}

/** Posts the repost and returns the first message sent. */
async function repost(discord, channelId, plan) {
  let first;
  for (const [i, chunk] of plan.chunks.entries()) {
    // allowed_mentions: none, so reposting never pings anyone.
    const payload = { content: chunk, flags: plan.flags, allowed_mentions: { parse: [] } };
    if (i === 0 && plan.embeds.length) payload.embeds = plan.embeds;
    let sent;
    if (i === 0 && plan.files.length) {
      payload.attachments = plan.files.map((f, n) => ({ id: n, filename: f.filename, description: f.description }));
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      for (const [n, f] of plan.files.entries()) form.append(`files[${n}]`, await discord.download(f.url), f.filename);
      sent = await discord.request("POST", `/channels/${channelId}/messages`, { form });
    } else {
      sent = await discord.request("POST", `/channels/${channelId}/messages`, { json: payload });
    }
    first ??= sent;
  }
  if (plan.pinned) {
    // Never let a failed pin stop the repost being recorded, or it would be posted twice.
    await discord.request("PUT", `/channels/${channelId}/messages/pins/${first.id}`).catch((e) => {
      console.error(JSON.stringify({ event: "repin_failed", channel_id: channelId, message: e.message }));
    });
  }
  return first;
}

/**
 * Starts a new thread on the repost and queues a job to copy the old thread into it.
 * If that fails, the old thread is left alone and is anonymised in place later instead.
 */
async function rebuildThread(db, discord, job, channelId, repostId, thread) {
  try {
    const created = await discord.request("POST", `/channels/${channelId}/messages/${repostId}/threads`, {
      json: { name: thread.name, auto_archive_duration: thread.autoArchive },
    });
    await jobInsert(db, job.guild_id, thread.id, {
      mode: "copy-thread",
      endId: null,
      targetChannelId: created.id,
      threadParentId: channelId,
      restoreArchived: thread.archived,
      restoreLocked: thread.locked,
    }).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "thread_rebuild_failed", thread_id: thread.id, message: e.message }));
  }
}

/**
 * Reposts messages oldest-first from where the last run stopped into `target`, and deletes
 * the originals if `deleteOriginals`. Only messages with ID <= job.end_id are touched (when
 * set), so the bot never reposts its own reposts. Returns true when there's nothing left.
 */
async function repostPass(db, discord, job, progress, { target, deleteOriginals, rebuildThreads }) {
  const source = job.channel_id;
  let cursor = job.cursor ?? "0";
  const pending = JSON.parse(job.pending_deletes ?? "[]");
  const save = () =>
    db
      .prepare("UPDATE purge_jobs SET cursor = ?, deleted = ?, pending_deletes = ? WHERE id = ?")
      .bind(cursor, progress.count, JSON.stringify(pending), job.id)
      .run();
  const flush = async () => {
    try {
      await deleteMessages(discord, source, pending);
    } finally {
      await save();
    }
  };

  await flush(); // Originals left over from a run that ran out of budget.

  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const messages = (await discord.request("GET", `/channels/${source}/messages?limit=100&after=${cursor}`))
        .filter((m) => job.end_id == null || compareIds(m.id, job.end_id) <= 0)
        .sort((a, b) => compareIds(a.id, b.id));
      if (!messages.length) {
        await flush();
        return true;
      }

      // Plan the whole page first so a missing intent is caught before anything changes.
      const plans = messages.map(buildRepost);

      for (const [i, message] of messages.entries()) {
        const plan = plans[i];
        // Leave enough requests to delete the originals already reposted, plus a margin for
        // rate-limit retries, so a repost is never cut off half-way.
        const reserve = pending.length + 4;
        if (discord.remaining() < (plan ? repostCost(plan) : 0) + reserve || discord.timeLeft() < 10_000) {
          throw new OutOfBudget();
        }
        if (plan) {
          const first = await repost(discord, target, plan);
          if (plan.thread && rebuildThreads) await rebuildThread(db, discord, job, target, first.id, plan.thread);
          progress.count++;
        }
        // Record the repost straight away so it can't be posted twice.
        if (deleteOriginals) pending.push(message.id);
        cursor = message.id;
        await save();
        if (pending.length >= FLUSH_AT) await flush();
      }
    }
    await flush();
    return false;
  } catch (e) {
    // Whatever stopped us, try to delete originals that were already reposted so they
    // don't end up duplicated.
    if (pending.length) await flush().catch(() => {});
    throw e;
  }
}

/** Puts a thread back to archived/locked if it was before. */
async function restoreThreadState(discord, threadId, job) {
  if (!job.restore_archived && !job.restore_locked) return;
  await discord.request("PATCH", `/channels/${threadId}`, { json: { archived: job.restore_archived === 1, locked: job.restore_locked === 1 } });
}

/** Lists every thread in a channel: active, archived public and archived private. */
async function listThreads(discord, guildId, channelId) {
  const { threads: active } = await discord.request("GET", `/guilds/${guildId}/threads/active`);
  const threads = active.filter((t) => t.parent_id === channelId);
  for (const kind of ["public", "private"]) {
    let before = null;
    try {
      for (;;) {
        const page = await discord.request(
          "GET",
          `/channels/${channelId}/threads/archived/${kind}?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`,
        );
        threads.push(...page.threads);
        if (!page.has_more || !page.threads.length) break;
        before = page.threads[page.threads.length - 1].thread_metadata.archive_timestamp;
      }
    } catch (e) {
      // Archived private threads need Manage Threads; carry on with the rest.
      if (!(e instanceof DiscordError && e.status === 403)) throw e;
      console.error(JSON.stringify({ event: "thread_list_forbidden", channel_id: channelId, kind }));
    }
  }
  return threads;
}

/**
 * Queues an in-place anonymise job for every thread in the channel that existed before the
 * job started. Threads started from messages have already been queued as copy jobs (or
 * finished and been deleted), so the ON CONFLICT in jobInsert skips them; if rebuilding one
 * failed, it gets anonymised in place here instead.
 */
async function queueThreads(db, discord, job) {
  // Collect everything before writing, so running out of budget part-way changes nothing.
  const threads = (await listThreads(discord, job.guild_id, job.channel_id)).filter((t) => compareIds(t.id, job.end_id) <= 0);
  if (threads.length) {
    await db.batch(
      threads.map((t) => {
        const info = threadInfo(t);
        return jobInsert(db, job.guild_id, t.id, {
          mode: "anonymise",
          endId: job.end_id,
          threadParentId: job.channel_id,
          restoreArchived: info.archived,
          restoreLocked: info.locked,
        });
      }),
    );
  }
  console.log(JSON.stringify({ event: "threads_queued", channel_id: job.channel_id, count: threads.length }));
}

/** Anonymises a channel or a standalone thread in place. Returns true when finished. */
export async function anonymiseStep(db, discord, job, progress) {
  const isThread = job.thread_parent_id != null;

  if (job.phase === "threads") {
    await queueThreads(db, discord, job);
    return true;
  }

  if (isThread && job.cursor == null) {
    // First run on this thread: make sure the bot can post in it.
    if (job.restore_archived || job.restore_locked) {
      await discord.request("PATCH", `/channels/${job.channel_id}`, { json: { archived: false, locked: false } });
    }
    await discord.request("PUT", `/channels/${job.channel_id}/thread-members/@me`);
  }

  const done = await repostPass(db, discord, job, progress, { target: job.channel_id, deleteOriginals: true, rebuildThreads: !isThread });
  if (!done) return false;

  if (isThread) {
    await restoreThreadState(discord, job.channel_id, job);
    return true;
  }
  await db.prepare("UPDATE purge_jobs SET phase = 'threads' WHERE id = ?").bind(job.id).run();
  await queueThreads(db, discord, job);
  return true;
}

/** Copies an old thread's messages into its replacement, then deletes the old thread. */
export async function copyThreadStep(db, discord, job, progress) {
  const done = await repostPass(db, discord, job, progress, { target: job.target_channel_id, deleteOriginals: false, rebuildThreads: false });
  if (!done) return false;

  await restoreThreadState(discord, job.target_channel_id, job);
  try {
    await discord.request("DELETE", `/channels/${job.channel_id}`);
  } catch (e) {
    if (!(e instanceof DiscordError && e.code === UNKNOWN_CHANNEL)) throw e;
  }
  return true;
}
