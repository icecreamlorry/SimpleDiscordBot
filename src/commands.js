// Slash command definitions, registered with Discord by scripts/register-commands.js.
import { DAY_NAMES } from "./time.js";
import { SAY_CHANNEL_TYPES } from "./say.js";

const GUILD_TEXT = 0;
const Option = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, CHANNEL: 7, ATTACHMENT: 11 };
const MANAGE_MESSAGES = String(1 << 13);
const MANAGE_GUILD = String(1 << 5);

// Guild install only, usable only inside servers.
const guildOnly = { contexts: [0], integration_types: [0] };

const keepPinned = { type: Option.BOOLEAN, name: "keep_pinned", description: "Leave pinned messages in place" };

export const COMMANDS = [
  {
    name: "purge",
    description: "Delete all messages in a channel",
    default_member_permissions: MANAGE_MESSAGES,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Channel to clear (defaults to this one)", channel_types: [GUILD_TEXT] },
      keepPinned,
    ],
  },
  {
    name: "anonymise",
    description: "Repost every message in a channel as the bot, then delete the originals",
    default_member_permissions: MANAGE_MESSAGES,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Channel to anonymise (defaults to this one)", channel_types: [GUILD_TEXT] },
    ],
  },
  {
    name: "say",
    description: "Post a message as the bot, without your name on it",
    // Server admins can let other roles use this under Server Settings → Integrations.
    default_member_permissions: MANAGE_MESSAGES,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Where to post (defaults to this channel)", channel_types: SAY_CHANNEL_TYPES },
      { type: Option.ATTACHMENT, name: "attachment", description: "A file to include (up to 10 MB)" },
    ],
  },
  {
    name: "schedule",
    description: "Manage scheduled channel purges",
    default_member_permissions: MANAGE_MESSAGES,
    ...guildOnly,
    options: [
      {
        type: Option.SUB_COMMAND,
        name: "add",
        description: "Clear a channel automatically at a set time",
        options: [
          { type: Option.CHANNEL, name: "channel", description: "Channel to clear", required: true, channel_types: [GUILD_TEXT] },
          { type: Option.STRING, name: "at", description: "Time in 24h HH:MM (UK time)", required: true },
          {
            type: Option.STRING,
            name: "day",
            description: "Which day(s) to run",
            required: true,
            choices: [{ name: "Every day", value: "daily" }, ...DAY_NAMES.map((name, i) => ({ name, value: String(i) }))],
          },
          keepPinned,
        ],
      },
      { type: Option.SUB_COMMAND, name: "list", description: "Show scheduled purges in this server" },
      {
        type: Option.SUB_COMMAND,
        name: "remove",
        description: "Remove a scheduled purge",
        options: [{ type: Option.INTEGER, name: "schedule_id", description: "The number shown by /schedule list", required: true }],
      },
    ],
  },
  {
    name: "export-members",
    description: "Download the server's member list as a CSV",
    default_member_permissions: MANAGE_GUILD,
    ...guildOnly,
  },
];
