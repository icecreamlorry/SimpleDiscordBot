import { ChannelType, DiscordClient, DiscordError, JOB_CHANNEL_TYPES, OutOfBudget, Permission, hasPermission, verifyInteraction } from "./discord.js";
import { MEMBER_CSV_HEADER, memberRow, roleNameLookup } from "./csv.js";
import { createJob, describeFailure, getJob, runJob } from "./jobs.js";
import { runCron } from "./cron.js";
import { EDIT_COMMAND, editCommand, submitEdit } from "./edit.js";
import { ANONYMISE_MESSAGE_COMMAND, anonymiseMessage, anonymiseMessageCommand } from "./anonymise-message.js";
import { PROTECT_COMMAND, SHIELD, UNPROTECT_COMMAND, setProtected } from "./protect.js";
import { sayCommand, sendSay } from "./say.js";
import { describeDay, localNow, parseTime, slotStarted } from "./time.js";

const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3, MODAL_SUBMIT: 5 };
const Reply = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, UPDATE_MESSAGE: 7, MODAL: 9 };
const EPHEMERAL = 1 << 6;
const MISSING_ACCESS = 50001;

// Background work after replying to Discord gets ~30 s; stop a little before that.
const BACKGROUND_TIME_MS = 25_000;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/interactions") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.DISCORD_PUBLIC_KEY) {
      return new Response("DISCORD_PUBLIC_KEY is not configured", { status: 500 });
    }
    const body = await verifyInteraction(request, env.DISCORD_PUBLIC_KEY);
    if (body === null) return new Response("Invalid request signature", { status: 401 });

    const interaction = JSON.parse(body);
    try {
      return Response.json(await handleInteraction(interaction, env, ctx));
    } catch (e) {
      console.error(JSON.stringify({ event: "interaction_error", message: e.message, stack: e.stack }));
      return Response.json(message("Something went wrong."));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
};

// --- Helpers -----------------------------------------------------------------------------------

function message(content, extra = {}) {
  return { type: Reply.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } };
}

function updateMessage(content, components = []) {
  return { type: Reply.UPDATE_MESSAGE, data: { content, components, allowed_mentions: { parse: [] } } };
}

function getOption(options, name) {
  return options?.find((o) => o.name === name)?.value;
}

function backgroundClient(env) {
  return new DiscordClient(env.DISCORD_TOKEN, { deadline: Date.now() + BACKGROUND_TIME_MS });
}

/**
 * Works out which text channel a command targets and whether the user may manage messages
 * there. Discord includes the user's computed permissions for any channel passed as an option.
 */
function resolveTargetChannel(interaction, options) {
  const channelId = getOption(options, "channel");
  if (channelId) {
    const channel = interaction.data.resolved?.channels?.[channelId];
    return { id: channelId, type: channel?.type, userPermissions: channel?.permissions, appPermissions: null };
  }
  const channel = interaction.channel;
  return {
    id: interaction.channel_id,
    type: channel?.type,
    userPermissions: interaction.member?.permissions,
    appPermissions: interaction.app_permissions,
  };
}

const PURGE_BOT_PERMISSIONS = {
  "View Channel": Permission.VIEW_CHANNEL,
  "Read Message History": Permission.READ_MESSAGE_HISTORY,
  "Manage Messages": Permission.MANAGE_MESSAGES,
};
const ANONYMISE_CHAT_PERMISSIONS = {
  ...PURGE_BOT_PERMISSIONS,
  "Send Messages": Permission.SEND_MESSAGES,
  "Embed Links": Permission.EMBED_LINKS,
  "Attach Files": Permission.ATTACH_FILES,
  "Add Reactions": Permission.ADD_REACTIONS, // re-adding 🛡️ to protected messages
  "Pin Messages": Permission.PIN_MESSAGES, // re-pinning pinned messages
};
// Text channels can have threads, which need more permissions; voice and stage chats can't.
const ANONYMISE_BOT_PERMISSIONS = {
  ...ANONYMISE_CHAT_PERMISSIONS,
  "Create Public Threads": Permission.CREATE_PUBLIC_THREADS,
  "Send Messages in Threads": Permission.SEND_MESSAGES_IN_THREADS,
  "Manage Threads": Permission.MANAGE_THREADS,
};

function anonymisePermissions(target) {
  return target.type === ChannelType.GUILD_TEXT ? ANONYMISE_BOT_PERMISSIONS : ANONYMISE_CHAT_PERMISSIONS;
}

function checkTarget(target, botPermissions = PURGE_BOT_PERMISSIONS) {
  if (!JOB_CHANNEL_TYPES.includes(target.type)) return "That only works in text channels and the chat in voice and stage channels.";
  if (!hasPermission(target.userPermissions, Permission.MANAGE_MESSAGES)) {
    return `You need Manage Messages in <#${target.id}>.`;
  }
  // The bot's own permissions are only known for the channel the command was run in;
  // elsewhere, a missing permission is reported when the job runs.
  if (target.appPermissions != null) {
    const missing = Object.entries(botPermissions).filter(([, p]) => !hasPermission(target.appPermissions, p)).map(([n]) => n);
    if (missing.length) return `I'm missing these permissions in <#${target.id}>: ${missing.join(", ")}`;
  }
  return null;
}

// --- Interaction routing -----------------------------------------------------------------------

async function handleInteraction(interaction, env, ctx) {
  if (interaction.type === InteractionType.PING) return { type: Reply.PONG };
  if (!interaction.guild_id) return message("This bot only works inside servers.");
  // Admin-only unless ADMIN_ONLY is "false" in wrangler.jsonc. Checked here as well as in the
  // command defaults because server admins can open commands up to other roles in Discord.
  if (env.ADMIN_ONLY !== "false" && !hasPermission(interaction.member?.permissions, Permission.ADMINISTRATOR)) {
    return message("Only server admins can use this bot.");
  }

  if (interaction.type === InteractionType.COMMAND) {
    switch (interaction.data.name) {
      case "purge":
        return purgeCommand(interaction);
      case "purge-and-anonymise":
        return purgeAndAnonymiseCommand(interaction);
      case "anonymise":
        return anonymiseCommand(interaction);
      case "say":
        return say(interaction, env);
      case PROTECT_COMMAND:
        return protectCommand(interaction, env, true);
      case UNPROTECT_COMMAND:
        return protectCommand(interaction, env, false);
      case ANONYMISE_MESSAGE_COMMAND: {
        const botId = new DiscordClient(env.DISCORD_TOKEN).userId() ?? interaction.application_id;
        const result = anonymiseMessageCommand(interaction, botId);
        if (result.problem) return message(result.problem);
        return message(result.warning, { components: confirmButtons("Anonymise", `anonmsg-confirm:${result.messageId}`) });
      }
      case EDIT_COMMAND: {
        const botId = new DiscordClient(env.DISCORD_TOKEN).userId() ?? interaction.application_id;
        const result = editCommand(interaction, botId);
        return result.problem ? message(result.problem) : { type: Reply.MODAL, data: result.modal };
      }
      case "schedule":
        return scheduleCommand(interaction, env);
      case "export-members":
        return exportMembersCommand(interaction, env, ctx);
    }
  }
  if (interaction.type === InteractionType.COMPONENT) {
    const [action, channelId, keepPinned] = interaction.data.custom_id.split(":");
    if (action === "job-cancel" || action === "purge-cancel") return updateMessage("Cancelled.");
    if (action === "purge-confirm") return confirmJob(interaction, env, ctx, channelId, { mode: "purge", keepPinned: keepPinned === "1" });
    if (action === "anonymise-confirm") return confirmJob(interaction, env, ctx, channelId, { mode: "anonymise" });
    if (action === "anonmsg-confirm") return confirmAnonymiseMessage(interaction, env, ctx, channelId);
    if (action === "purgeanon-confirm") return confirmJob(interaction, env, ctx, channelId, { mode: "purge-anonymise", keepPinned: keepPinned === "1" });
  }
  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    const [action, id] = interaction.data.custom_id.split(":");
    if (action === "say") {
      ctx.waitUntil(sendSay(interaction, env, id));
      return { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
    }
    if (action === "edit") {
      ctx.waitUntil(submitEdit(interaction, env, id));
      return { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
    }
  }
  return message("Unknown command.");
}

// --- Anonymise message (right-click a message → Apps) --------------------------------------------

function confirmAnonymiseMessage(interaction, env, ctx, messageId) {
  ctx.waitUntil(
    (async () => {
      const content = await anonymiseMessage(env.DB, backgroundClient(env), {
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        messageId,
      }).catch((e) => {
        console.error(JSON.stringify({ event: "anonymise_message_failed", channel_id: interaction.channel_id, status: e.status, message: e.message }));
        return e.status === 403 ? "I'm missing permissions here." : "Sorry, that didn't work.";
      });
      await new DiscordClient(env.DISCORD_TOKEN, { budget: 2 })
        .editOriginal(interaction.application_id, interaction.token, { json: { content, components: [] } })
        .catch(() => {});
    })(),
  );
  return updateMessage("Anonymising the message...");
}

// --- Protect / Unprotect from purge (right-click a message → Apps) -------------------------------

async function protectCommand(interaction, env, on) {
  try {
    await setProtected(new DiscordClient(env.DISCORD_TOKEN, { budget: 3 }), interaction.channel_id, interaction.data.target_id, on);
  } catch (e) {
    console.error(JSON.stringify({ event: "protect_failed", channel_id: interaction.channel_id, status: e.status, message: e.message }));
    return message(e.status === 403 ? "I need Add Reactions and Read Message History in this channel to do that." : "Sorry, that didn't work.");
  }
  return message(
    on
      ? `${SHIELD} Protected. Purges will keep this message, and anonymising will keep it protected.`
      : "Unprotected. This message will be deleted by the next purge.",
  );
}

// --- /say --------------------------------------------------------------------------------------

async function say(interaction, env) {
  const options = interaction.data.options;
  const result = await sayCommand(interaction, env, resolveTargetChannel(interaction, options), getOption(options, "attachment"), {
    silent: getOption(options, "silent") === true,
  });
  return result.problem ? message(result.problem) : { type: Reply.MODAL, data: result.modal };
}

// --- /purge and /anonymise ---------------------------------------------------------------------

function confirmButtons(confirmLabel, confirmId) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: confirmLabel, custom_id: confirmId },
        { type: 2, style: 2, label: "Cancel", custom_id: "job-cancel" },
      ],
    },
  ];
}

function purgeCommand(interaction) {
  const options = interaction.data.options;
  const target = resolveTargetChannel(interaction, options);
  const problem = checkTarget(target);
  if (problem) return message(problem);

  const keepPinned = getOption(options, "keep_pinned") === true;
  const pinnedNote = keepPinned ? " (pinned messages will be kept)" : "";
  return message(`This will permanently delete **all** messages in <#${target.id}>${pinnedNote}. This cannot be undone.`, {
    components: confirmButtons("Delete everything", `purge-confirm:${target.id}:${keepPinned ? 1 : 0}`),
  });
}

function purgeAndAnonymiseCommand(interaction) {
  const options = interaction.data.options;
  const target = resolveTargetChannel(interaction, options);
  const problem = checkTarget(target, anonymisePermissions(target));
  if (problem) return message(problem);

  const keepPinned = getOption(options, "keep_pinned") === true;
  const kept = keepPinned ? `protected (${SHIELD}) and pinned messages` : `protected (${SHIELD}) messages`;
  return message(
    [
      `This will permanently delete every message in <#${target.id}> except ${kept}, then repost what's left as me, in the same order, and delete the originals.`,
      "",
      `- Reposts keep their ${SHIELD} and pins, with date dividers showing which day they were first posted. Exact times and reactions are lost.`,
      "- Threads in the channel are anonymised too, not deleted.",
      "- Ask people not to post in the channel until it finishes.",
      "",
      "This cannot be undone.",
    ].join("\n"),
    { components: confirmButtons("Purge and anonymise", `purgeanon-confirm:${target.id}:${keepPinned ? 1 : 0}`) },
  );
}

function anonymiseCommand(interaction) {
  const target = resolveTargetChannel(interaction, interaction.data.options);
  const problem = checkTarget(target, anonymisePermissions(target));
  if (problem) return message(problem);

  return message(
    [
      `This will repost every message in <#${target.id}> as me, oldest first, then delete the originals, so the channel keeps the same messages in the same order without showing who wrote them.`,
      "",
      "- Threads are anonymised too. Threads started from a message are rebuilt under the reposted message (so their links change); other threads, including private and archived ones, are anonymised where they are.",
      "- Date dividers show which day messages were first posted; exact times, reactions and reply links are lost. Pins, attachments (up to 10 MB each), stickers and polls (as text notes) are kept.",
      "- It runs at roughly 20–30 messages a minute. Ask people not to post in the channel until it finishes, or new messages will end up in the middle.",
      "- It removes names, not identities: what people wrote may still identify them, and Discord's audit log can show admins whose older messages were deleted.",
      "",
      "This cannot be undone.",
    ].join("\n"),
    { components: confirmButtons("Anonymise channel", `anonymise-confirm:${target.id}`) },
  );
}

function describeResult(mode, result, channelId) {
  const threadsNote = "Any threads are being anonymised separately in the background and may take a few more minutes.";
  if (mode === "purge-anonymise") {
    const soFar = `deleted ${result.purged} messages and reposted ${result.count} protected ones`;
    if (result.status === "done") return `Finished <#${channelId}>: ${soFar}. ${threadsNote}`;
    if (result.status === "failed") return `Stopped after I ${soFar}: ${describeFailure(result.error)}`;
    return `So far I've ${soFar}. The rest of <#${channelId}> will be done in the background over the next few minutes.`;
  }
  const verb = mode === "anonymise" ? "Reposted" : "Deleted";
  if (result.status === "done") {
    return mode === "anonymise"
      ? `Finished anonymising <#${channelId}>: reposted ${result.count} messages. ${threadsNote}`
      : `Deleted ${result.count} messages in <#${channelId}>.`;
  }
  if (result.status === "failed") return `Stopped after ${result.count} messages: ${describeFailure(result.error)}`;
  return `${verb} ${result.count} messages so far. The rest of <#${channelId}> will be done in the background over the next few minutes.`;
}

async function confirmJob(interaction, env, ctx, channelId, { mode, keepPinned = false }) {
  if (!(await createJob(env.DB, interaction.guild_id, channelId, { mode, keepPinned }))) {
    return updateMessage(`A purge or anonymise is already running in <#${channelId}>.`);
  }
  ctx.waitUntil(
    (async () => {
      const discord = backgroundClient(env);
      const job = await getJob(env.DB, channelId);
      const result = await runJob(env.DB, discord, job, { timeZone: env.BOT_TIMEZONE });
      // A fresh client so the edit still goes through if the job used the whole allowance.
      await new DiscordClient(env.DISCORD_TOKEN, { budget: 2 })
        .editOriginal(interaction.application_id, interaction.token, { json: { content: describeResult(mode, result, channelId), components: [] } })
        .catch(() => {});
    })(),
  );
  const starting = { anonymise: "Anonymising", "purge-anonymise": "Purging and anonymising" }[mode] ?? "Deleting messages in";
  return updateMessage(`${starting} <#${channelId}>...`);
}

// --- /schedule ---------------------------------------------------------------------------------

async function scheduleCommand(interaction, env) {
  const sub = interaction.data.options[0];
  const guildId = interaction.guild_id;
  const tz = env.BOT_TIMEZONE;

  if (sub.name === "add") {
    const at = parseTime(String(getOption(sub.options, "at")));
    if (!at) return message("Time must be in 24-hour HH:MM format, e.g. `03:00`.");
    const target = resolveTargetChannel(interaction, sub.options);
    const action = getOption(sub.options, "action") ?? "purge";
    const problem = checkTarget(target, action === "purge" ? PURGE_BOT_PERMISSIONS : anonymisePermissions(target));
    if (problem) return message(problem);

    const day = getOption(sub.options, "day");
    // Anonymising keeps pins anyway, so keep_pinned only applies when deleting.
    const keepPinned = action !== "anonymise" && getOption(sub.options, "keep_pinned") === true;
    const now = localNow(tz);
    const schedule = { time: at, day };
    // If today's slot has already passed, don't fire it straight away.
    const lastRun = slotStarted(schedule, now) ? now.date : null;
    const row = await env.DB.prepare(
      "INSERT INTO schedules (guild_id, channel_id, time, day, keep_pinned, last_run, action) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(guildId, target.id, at, day, keepPinned ? 1 : 0, lastRun, action)
      .first();
    const verb = { anonymise: "anonymised", "purge-anonymise": "purged (keeping protected messages) then anonymised" }[action] ?? "cleared";
    return message(`Schedule #${row.id}: <#${target.id}> will be ${verb} ${describeDay(day)} at ${at} (${tz}).`);
  }

  if (sub.name === "list") {
    const { results } = await env.DB.prepare("SELECT * FROM schedules WHERE guild_id = ? ORDER BY id").bind(guildId).all();
    if (!results.length) return message("No schedules.");
    const lines = results.map(
      (s) =>
        `#${s.id}: ${{ anonymise: "anonymise", "purge-anonymise": "purge + anonymise" }[s.action] ?? "clear"} <#${s.channel_id}> ${describeDay(s.day)} at ${s.time}${s.keep_pinned ? " (keeps pinned)" : ""}`,
    );
    return message(`Times are ${tz}.\n${lines.join("\n")}`);
  }

  if (sub.name === "remove") {
    const id = getOption(sub.options, "schedule_id");
    const result = await env.DB.prepare("DELETE FROM schedules WHERE guild_id = ? AND id = ?").bind(guildId, id).run();
    return message(result.meta.changes ? `Removed schedule #${id}.` : `No schedule #${id} in this server.`);
  }

  return message("Unknown subcommand.");
}

// --- /export-members ---------------------------------------------------------------------------

function exportMembersCommand(interaction, env, ctx) {
  ctx.waitUntil(exportMembers(interaction, env));
  return { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
}

async function exportMembers(interaction, env) {
  const discord = backgroundClient(env);
  const edit = (payload) => discord.editOriginal(interaction.application_id, interaction.token, payload);

  // Built in memory and sent straight to the requester; nothing is stored.
  const rows = [MEMBER_CSV_HEADER];
  let after = "0";
  let complete = false;
  try {
    const roles = await discord.request("GET", `/guilds/${interaction.guild_id}/roles`);
    const roleNames = roleNameLookup(roles, interaction.guild_id);
    while (discord.remaining() > 1) {
      const page = await discord.request("GET", `/guilds/${interaction.guild_id}/members?limit=1000&after=${after}`);
      for (const member of page) rows.push(memberRow(member, roleNames));
      if (page.length < 1000) {
        complete = true;
        break;
      }
      after = page[page.length - 1].user.id;
    }
  } catch (e) {
    if (!(e instanceof OutOfBudget)) {
      const reason =
        e instanceof DiscordError && e.code === MISSING_ACCESS
          ? "Discord refused the member list. Make sure Server Members Intent is turned on for the bot in the Developer Portal."
          : "Something went wrong fetching the member list.";
      console.error(JSON.stringify({ event: "export_failed", message: e.message }));
      await edit({ json: { content: reason } }).catch(() => {});
      return;
    }
  }

  const count = rows.length - 1;
  const filename = `members-${localNow(env.BOT_TIMEZONE).date}.csv`;
  const note = complete ? "" : " (the server is too large to export in one go, so this list is incomplete)";
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: `${count} members${note}.`, attachments: [{ id: 0, filename }] }));
  // BOM so Excel opens it as UTF-8.
  form.append("files[0]", new Blob(["﻿" + rows.join("\r\n") + "\r\n"], { type: "text/csv" }), filename);
  await edit({ form }).catch((e) => console.error(JSON.stringify({ event: "export_send_failed", message: e.message })));
}
