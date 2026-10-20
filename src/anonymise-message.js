// "Anonymise message": right-click one message → Apps. After a warning that the repost will
// land at the bottom of the channel, the bot reposts it as itself and deletes the original.
import { DiscordError, Permission, hasPermission } from "./discord.js";
import { buildRepost, rebuildThread, repost } from "./anonymise.js";
import { JobError, deleteMessage } from "./messages.js";

export const ANONYMISE_MESSAGE_COMMAND = "Anonymise message";
const THREAD_TYPES = [11, 12];

/** Checks the right-clicked message and returns { problem } or { warning, messageId }. */
export function anonymiseMessageCommand(interaction, botId) {
  const messageId = interaction.data.target_id;
  const target = interaction.data.resolved?.messages?.[messageId];
  if (target?.author?.id === botId) return { problem: "That message is already from me, so it's already anonymous." };

  // The bot's own permissions in this channel (or thread).
  const inThread = THREAD_TYPES.includes(interaction.channel?.type);
  const needed = {
    "View Channel": Permission.VIEW_CHANNEL,
    "Read Message History": Permission.READ_MESSAGE_HISTORY,
    "Manage Messages": Permission.MANAGE_MESSAGES,
    [inThread ? "Send Messages in Threads" : "Send Messages"]: inThread ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES,
    "Embed Links": Permission.EMBED_LINKS,
    "Attach Files": Permission.ATTACH_FILES,
  };
  const missing = Object.entries(needed).filter(([, p]) => !hasPermission(interaction.app_permissions, p)).map(([n]) => n);
  if (missing.length) return { problem: `I'm missing these permissions here: ${missing.join(", ")}` };

  return {
    messageId,
    warning: [
      "This will repost the message as me and delete the original, so it no longer shows who wrote it.",
      "",
      "- **It will move to the bottom of the channel**, below everything posted since, and show as posted now.",
      "- Reactions and any reply link are lost. Attachments (up to 10 MB each), pins and 🛡️ are kept, and a thread on it is rebuilt under the repost.",
      "",
      "This cannot be undone.",
    ].join("\n"),
  };
}

/**
 * Reposts the message and deletes the original. Returns a message to show the admin.
 * The message is fetched again here, since the button press doesn't include it.
 */
export async function anonymiseMessage(db, discord, { guildId, channelId, messageId }) {
  let message;
  try {
    message = await discord.request("GET", `/channels/${channelId}/messages/${messageId}`);
  } catch (e) {
    if (e instanceof DiscordError && e.status === 404) return "That message has already been deleted.";
    throw e;
  }
  if (message.author?.id === discord.userId()) return "That message is already from me, so it's already anonymous.";

  let plan;
  try {
    plan = buildRepost(message);
  } catch (e) {
    if (e instanceof JobError) return e.message;
    throw e;
  }
  if (!plan) return "That's a system message, so there's nothing to repost.";

  const first = await repost(discord, channelId, plan);
  if (plan.thread) await rebuildThread(db, discord, { guild_id: guildId }, channelId, first.id, plan.thread);
  await deleteMessage(discord, channelId, messageId);
  const thread = plan.thread ? " Its thread is being rebuilt in the background." : "";
  return `Anonymised: https://discord.com/channels/${guildId}/${channelId}/${first.id}${thread}`;
}
