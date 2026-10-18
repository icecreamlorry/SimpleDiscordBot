// Slash command definitions, registered with Discord by scripts/register-commands.js.
import { DAY_NAMES } from "./time.js";
import { JOB_CHANNEL_TYPES } from "./discord.js";
import { SAY_CHANNEL_TYPES } from "./say.js";

const Option = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, CHANNEL: 7, ATTACHMENT: 11 };
// Every command is admin-only by default. Server admins can open a command up to other roles
// under Server Settings → Integrations, but the bot also refuses non-admins unless ADMIN_ONLY
// is set to "false" in wrangler.jsonc.
const ADMINISTRATOR = String(1 << 3);

// Guild install only, usable only inside servers.
const guildOnly = { contexts: [0], integration_types: [0] };

const keepPinned = { type: Option.BOOLEAN, name: "keep_pinned", description: "Leave pinned messages in place" };

export const COMMANDS = [
  {
    name: "purge",
    description: "Delete all messages in a channel",
    default_member_permissions: ADMINISTRATOR,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Channel to clear (defaults to this one)", channel_types: JOB_CHANNEL_TYPES },
      keepPinned,
    ],
  },
  {
    name: "anonymise",
    description: "Repost every message in a channel as the bot, then delete the originals",
    default_member_permissions: ADMINISTRATOR,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Channel to anonymise (defaults to this one)", channel_types: JOB_CHANNEL_TYPES },
    ],
  },
  {
    name: "say",
    description: "Post a message as the bot, without your name on it",
    default_member_permissions: ADMINISTRATOR,
    ...guildOnly,
    options: [
      { type: Option.CHANNEL, name: "channel", description: "Where to post (defaults to this channel)", channel_types: SAY_CHANNEL_TYPES },
      { type: Option.ATTACHMENT, name: "attachment", description: "A file to include (up to 10 MB)" },
    ],
  },
  {
    name: "schedule",
    description: "Clear or anonymise channels automatically on a schedule",
    default_member_permissions: ADMINISTRATOR,
    ...guildOnly,
    options: [
      {
        type: Option.SUB_COMMAND,
        name: "add",
        description: "Clear or anonymise a channel automatically at a set time",
        options: [
          { type: Option.CHANNEL, name: "channel", description: "Channel to clear or anonymise", required: true, channel_types: JOB_CHANNEL_TYPES },
          { type: Option.STRING, name: "at", description: "Time in 24h HH:MM (UK time)", required: true },
          {
            type: Option.STRING,
            name: "day",
            description: "Which day(s) to run",
            required: true,
            choices: [{ name: "Every day", value: "daily" }, ...DAY_NAMES.map((name, i) => ({ name, value: String(i) }))],
          },
          {
            type: Option.STRING,
            name: "action",
            description: "What to do (defaults to deleting all messages)",
            choices: [
              { name: "Delete all messages", value: "purge" },
              { name: "Anonymise (repost as the bot)", value: "anonymise" },
            ],
          },
          { ...keepPinned, description: "Leave pinned messages in place (deleting only)" },
        ],
      },
      { type: Option.SUB_COMMAND, name: "list", description: "Show this server's schedules" },
      {
        type: Option.SUB_COMMAND,
        name: "remove",
        description: "Remove a schedule",
        options: [{ type: Option.INTEGER, name: "schedule_id", description: "The number shown by /schedule list", required: true }],
      },
    ],
  },
  {
    name: "export-members",
    description: "Download the server's member list as a CSV",
    default_member_permissions: ADMINISTRATOR,
    ...guildOnly,
  },
];
