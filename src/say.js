// /say: post a message as the bot, so it never shows who wrote it.
//
// Slash command options can't hold line breaks, so the command opens a pop-up with a
// multi-line text box. An attachment chosen in the command is kept in say_drafts until the
// pop-up is submitted. Nothing records who sent a message.
import { ChannelType, DiscordClient, DiscordError, JOB_CHANNEL_TYPES, Permission, hasPermission } from "./discord.js";
import { splitContent } from "./anonymise.js";

export const DRAFT_TTL_MS = 15 * 60 * 1000;
const MAX_TEXT = 4000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SUPPRESS_NOTIFICATIONS = 1 << 12;
export const SAY_CHANNEL_TYPES = [...JOB_CHANNEL_TYPES, ChannelType.GUILD_ANNOUNCEMENT, ChannelType.PUBLIC_THREAD, ChannelType.PRIVATE_THREAD];
const isThread = (type) => type === ChannelType.PUBLIC_THREAD || type === ChannelType.PRIVATE_THREAD;

/** Returns a problem message, or null if the user and bot can post there. */
function checkSayTarget(target, withAttachment) {
  if (!SAY_CHANNEL_TYPES.includes(target.type)) return "I can only post in text, announcement, voice and stage channels, and threads.";
  const send = isThread(target.type) ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES;
  // You can only send as the bot where you could send yourself.
  if (!hasPermission(target.userPermissions, send)) return `You can't send messages in <#${target.id}>.`;
  if (withAttachment && !hasPermission(target.userPermissions, Permission.ATTACH_FILES)) return `You can't attach files in <#${target.id}>.`;
  // The bot's own permissions are only known for the channel the command was run in.
  if (target.appPermissions != null) {
    const needed = { "View Channel": Permission.VIEW_CHANNEL, [isThread(target.type) ? "Send Messages in Threads" : "Send Messages"]: send };
    if (withAttachment) needed["Attach Files"] = Permission.ATTACH_FILES;
    const missing = Object.entries(needed).filter(([, p]) => !hasPermission(target.appPermissions, p)).map(([n]) => n);
    if (missing.length) return `I'm missing these permissions in <#${target.id}>: ${missing.join(", ")}`;
  }
  return null;
}

/**
 * Handles /say: checks permissions, saves the draft and returns the pop-up to show.
 * Returns { problem } instead if the message can't be sent there.
 */
export async function sayCommand(interaction, env, target, attachmentId, { silent = false } = {}) {
  const attachment = attachmentId ? interaction.data.resolved?.attachments?.[attachmentId] : null;
  const problem = checkSayTarget(target, Boolean(attachment));
  if (problem) return { problem };
  if (attachment && attachment.size > MAX_FILE_BYTES) return { problem: "That file is too big; I can upload up to 10 MB." };

  const draftId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO say_drafts (id, channel_id, attachment_url, attachment_filename, attachment_size, silent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(draftId, target.id, attachment?.url ?? null, attachment?.filename ?? null, attachment?.size ?? null, silent ? 1 : 0, Date.now())
    .run();

  return {
    modal: {
      custom_id: `say:${draftId}`,
      title: "Send as the bot",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // text input
              style: 2, // paragraph
              custom_id: "text",
              label: attachment ? `Message (optional, sending ${attachment.filename})`.slice(0, 45) : "Message",
              placeholder: "Posted as the bot. Mentions won't ping anyone.",
              max_length: MAX_TEXT,
              required: !attachment,
            },
          ],
        },
      ],
    },
  };
}

/** Reads the text box value from a modal submit (works for both modal layouts Discord uses). */
function modalText(interaction) {
  for (const row of interaction.data.components ?? []) {
    for (const c of [...(row.components ?? []), row.component].filter(Boolean)) {
      if (c.custom_id === "text") return c.value ?? "";
    }
  }
  return "";
}

/** Sends the message. Runs after the pop-up is submitted and the reply has been deferred. */
export async function sendSay(interaction, env, draftId) {
  const discord = new DiscordClient(env.DISCORD_TOKEN, { deadline: Date.now() + 25_000 });
  const edit = (content) => discord.editOriginal(interaction.application_id, interaction.token, { json: { content } }).catch(() => {});

  const found = await env.DB.prepare("SELECT * FROM say_drafts WHERE id = ?").bind(draftId).first();
  await env.DB.prepare("DELETE FROM say_drafts WHERE id = ?").bind(draftId).run();
  if (!found || Date.now() - found.created_at > DRAFT_TTL_MS) {
    await edit("That took too long, so nothing was sent. Run `/say` again.");
    return;
  }
  const channelId = found.channel_id;
  const draft = found.attachment_url ? found : null;

  const text = modalText(interaction).trim();
  const chunks = text ? splitContent(text) : [""];
  try {
    let first;
    for (const [i, chunk] of chunks.entries()) {
      // Mentions never ping, so /say can't be used to mass-mention people. The message itself
      // notifies as normal unless the sender chose silent.
      const payload = { content: chunk, flags: found.silent ? SUPPRESS_NOTIFICATIONS : 0, allowed_mentions: { parse: [] } };
      let sent;
      if (i === 0 && draft) {
        payload.attachments = [{ id: 0, filename: draft.attachment_filename }];
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append("files[0]", await discord.download(draft.attachment_url), draft.attachment_filename);
        sent = await discord.request("POST", `/channels/${channelId}/messages`, { form });
      } else {
        sent = await discord.request("POST", `/channels/${channelId}/messages`, { json: payload });
      }
      first ??= sent;
    }
    await edit(`Sent: https://discord.com/channels/${interaction.guild_id}/${channelId}/${first.id}`);
  } catch (e) {
    console.error(JSON.stringify({ event: "say_failed", channel_id: channelId, status: e.status, code: e.code, message: e.message }));
    await edit(e instanceof DiscordError && e.status === 403 ? `I don't have permission to post in <#${channelId}>.` : "Sorry, that didn't send.");
  }
}

/** Removes attachment links from pop-ups that were never submitted. */
export function cleanUpDrafts(db) {
  return db.prepare("DELETE FROM say_drafts WHERE created_at < ?").bind(Date.now() - DRAFT_TTL_MS).run();
}
