// Protecting messages from purges. An admin right-clicks a message → Apps → "Protect from
// purge", and the bot adds its own 🛡️ reaction. Purges keep any message that has the bot's
// shield on it. Members adding a 🛡️ themselves doesn't count: Discord tells us whether a
// reaction is the bot's own ("me") when listing messages, so no extra requests are needed.

export const SHIELD = "🛡️";
export const PROTECT_COMMAND = "Protect from purge";
export const UNPROTECT_COMMAND = "Unprotect from purge";

// Emoji may come back with or without the variation selector.
const bare = (text) => text.replace(/️/g, "");

export function isProtected(message) {
  return (message.reactions ?? []).some((r) => r.me && !r.emoji?.id && bare(r.emoji?.name ?? "") === bare(SHIELD));
}

/** Adds (on = true) or removes the bot's shield on a message. */
export function setProtected(discord, channelId, messageId, on) {
  return discord.request(on ? "PUT" : "DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(SHIELD)}/@me`);
}
