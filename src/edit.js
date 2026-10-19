// "Edit bot message": right-click one of the bot's messages → Apps, fix the text in a pop-up,
// and the bot edits the message in place. Attachments, reactions and pins are untouched.
import { DiscordClient, DiscordError } from "./discord.js";

export const EDIT_COMMAND = "Edit bot message";
// A single Discord message can hold up to 2,000 characters.
const MAX_CONTENT = 2000;

/**
 * Handles the right-click: returns { modal } pre-filled with the message's text, or
 * { problem } if it isn't one of the bot's messages.
 */
export function editCommand(interaction, botId) {
  const messageId = interaction.data.target_id;
  const target = interaction.data.resolved?.messages?.[messageId];
  if (!target || target.author?.id !== botId) return { problem: "I can only edit my own messages." };

  const hasOtherContent = (target.attachments?.length ?? 0) > 0 || (target.embeds?.length ?? 0) > 0;
  return {
    modal: {
      custom_id: `edit:${messageId}`,
      title: "Edit bot message",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4, // text input
              style: 2, // paragraph
              custom_id: "text",
              label: "Message",
              value: (target.content ?? "").slice(0, MAX_CONTENT),
              max_length: MAX_CONTENT,
              // A message must have something in it; text can only be empty if a file or embed remains.
              required: !hasOtherContent,
            },
          ],
        },
      ],
    },
  };
}

function modalText(interaction) {
  for (const row of interaction.data.components ?? []) {
    for (const c of [...(row.components ?? []), row.component].filter(Boolean)) {
      if (c.custom_id === "text") return c.value ?? "";
    }
  }
  return "";
}

/** Applies the edit after the pop-up is submitted, then reports back privately. */
export async function submitEdit(interaction, env, messageId) {
  const discord = new DiscordClient(env.DISCORD_TOKEN, { deadline: Date.now() + 25_000 });
  const reply = (content) => discord.editOriginal(interaction.application_id, interaction.token, { json: { content } }).catch(() => {});
  const channelId = interaction.channel_id;
  try {
    // allowed_mentions: none, so an edit never pings anyone.
    await discord.request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
      json: { content: modalText(interaction), allowed_mentions: { parse: [] } },
    });
    await reply(`Updated: https://discord.com/channels/${interaction.guild_id}/${channelId}/${messageId}`);
  } catch (e) {
    console.error(JSON.stringify({ event: "edit_failed", channel_id: channelId, status: e.status, code: e.code, message: e.message }));
    await reply(e instanceof DiscordError && e.status === 403 ? "I can only edit my own messages." : "Sorry, that edit didn't go through.");
  }
}
