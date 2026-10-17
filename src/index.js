import { DiscordClient, DiscordError, OutOfBudget, Permission, hasPermission, verifyInteraction } from "./discord.js";
import { createJob, describeFailure, getJob, runJob } from "./purge.js";
import { describeDay, isDue, localNow, parseTime, slotStarted } from "./time.js";

const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3 };
const Reply = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, UPDATE_MESSAGE: 7 };
const EPHEMERAL = 1 << 6;
const GUILD_TEXT = 0;
const MISSING_ACCESS = 50001;

// Background work after replying to Discord gets ~30 s; stop a little before that.
const BACKGROUND_TIME_MS = 25_000;
// Cron runs every minute; finish before the next one starts.
const CRON_TIME_MS = 50_000;

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

function checkTarget(target) {
  if (target.type !== GUILD_TEXT) return "That only works in text channels.";
  if (!hasPermission(target.userPermissions, Permission.MANAGE_MESSAGES)) {
    return `You need Manage Messages in <#${target.id}>.`;
  }
  // The bot's own permissions are only known for the channel the command was run in;
  // elsewhere, a missing permission is reported when the purge runs.
  if (target.appPermissions != null) {
    const needed = { "View Channel": Permission.VIEW_CHANNEL, "Read Message History": Permission.READ_MESSAGE_HISTORY, "Manage Messages": Permission.MANAGE_MESSAGES };
    const missing = Object.entries(needed).filter(([, p]) => !hasPermission(target.appPermissions, p)).map(([n]) => n);
    if (missing.length) return `I'm missing these permissions in <#${target.id}>: ${missing.join(", ")}`;
  }
  return null;
}

// --- Interaction routing -----------------------------------------------------------------------

async function handleInteraction(interaction, env, ctx) {
  if (interaction.type === InteractionType.PING) return { type: Reply.PONG };
  if (!interaction.guild_id) return message("This bot only works inside servers.");

  if (interaction.type === InteractionType.COMMAND) {
    switch (interaction.data.name) {
      case "purge":
        return purgeCommand(interaction);
      case "schedule":
        return scheduleCommand(interaction, env);
      case "export-members":
        return exportMembersCommand(interaction, env, ctx);
    }
  }
  if (interaction.type === InteractionType.COMPONENT) {
    const [action, channelId, keepPinned] = interaction.data.custom_id.split(":");
    if (action === "purge-cancel") return updateMessage("Cancelled.");
    if (action === "purge-confirm") return confirmPurge(interaction, env, ctx, channelId, keepPinned === "1");
  }
  return message("Unknown command.");
}

// --- /purge ------------------------------------------------------------------------------------

function purgeCommand(interaction) {
  const options = interaction.data.options;
  const target = resolveTargetChannel(interaction, options);
  const problem = checkTarget(target);
  if (problem) return message(problem);

  const keepPinned = getOption(options, "keep_pinned") === true;
  const pinnedNote = keepPinned ? " (pinned messages will be kept)" : "";
  return message(`This will permanently delete **all** messages in <#${target.id}>${pinnedNote}. This cannot be undone.`, {
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "Delete everything", custom_id: `purge-confirm:${target.id}:${keepPinned ? 1 : 0}` },
          { type: 2, style: 2, label: "Cancel", custom_id: "purge-cancel" },
        ],
      },
    ],
  });
}

async function confirmPurge(interaction, env, ctx, channelId, keepPinned) {
  if (!(await createJob(env.DB, interaction.guild_id, channelId, keepPinned))) {
    return updateMessage(`A purge is already running in <#${channelId}>.`);
  }
  ctx.waitUntil(
    (async () => {
      const discord = backgroundClient(env);
      const job = await getJob(env.DB, channelId);
      const result = await runJob(env.DB, discord, job);
      const content =
        result.status === "done"
          ? `Deleted ${result.deleted} messages in <#${channelId}>.`
          : result.status === "failed"
            ? `Purge of <#${channelId}> stopped after ${result.deleted} messages: ${describeFailure(result.error)}`
            : `Deleted ${result.deleted} messages so far. The rest of <#${channelId}> will be cleared in the background over the next few minutes.`;
      // A fresh client so the edit still goes through if the purge used the whole allowance.
      await new DiscordClient(env.DISCORD_TOKEN, { budget: 2 })
        .editOriginal(interaction.application_id, interaction.token, { json: { content, components: [] } })
        .catch(() => {});
    })(),
  );
  return updateMessage(`Deleting messages in <#${channelId}>...`);
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
    const problem = checkTarget(target);
    if (problem) return message(problem);

    const day = getOption(sub.options, "day");
    const keepPinned = getOption(sub.options, "keep_pinned") === true;
    const now = localNow(tz);
    const schedule = { time: at, day };
    // If today's slot has already passed, don't fire it straight away.
    const lastRun = slotStarted(schedule, now) ? now.date : null;
    const row = await env.DB.prepare(
      "INSERT INTO schedules (guild_id, channel_id, time, day, keep_pinned, last_run) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(guildId, target.id, at, day, keepPinned ? 1 : 0, lastRun)
      .first();
    return message(`Schedule #${row.id}: <#${target.id}> will be cleared ${describeDay(day)} at ${at} (${tz}).`);
  }

  if (sub.name === "list") {
    const { results } = await env.DB.prepare("SELECT * FROM schedules WHERE guild_id = ? ORDER BY id").bind(guildId).all();
    if (!results.length) return message("No scheduled purges.");
    const lines = results.map(
      (s) => `#${s.id}: <#${s.channel_id}> ${describeDay(s.day)} at ${s.time}${s.keep_pinned ? " (keeps pinned)" : ""}`,
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

function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function exportMembersCommand(interaction, env, ctx) {
  ctx.waitUntil(exportMembers(interaction, env));
  return { type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } };
}

async function exportMembers(interaction, env) {
  const discord = backgroundClient(env);
  const edit = (payload) => discord.editOriginal(interaction.application_id, interaction.token, payload);

  // Built in memory and sent straight to the requester; nothing is stored.
  const rows = ["username"];
  let after = "0";
  let complete = false;
  try {
    while (discord.remaining() > 1) {
      const page = await discord.request("GET", `/guilds/${interaction.guild_id}/members?limit=1000&after=${after}`);
      for (const member of page) rows.push(csvField(member.user.username));
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

// --- Cron: scheduled purges and continuing large purges ----------------------------------------

async function runCron(env, scheduledTime) {
  const db = env.DB;
  const discord = new DiscordClient(env.DISCORD_TOKEN, { deadline: Date.now() + CRON_TIME_MS });
  const now = localNow(env.BOT_TIMEZONE, new Date(scheduledTime));

  const { results: schedules } = await db.prepare("SELECT * FROM schedules").all();

  // Hourly: forget servers the bot has been removed from.
  if (schedules.length && new Date(scheduledTime).getUTCMinutes() === 0) {
    await forgetRemovedGuilds(db, discord).catch((e) =>
      console.error(JSON.stringify({ event: "guild_sweep_failed", message: e.message })),
    );
  }

  for (const schedule of schedules) {
    if (!isDue(schedule, now)) continue;
    await db.prepare("UPDATE schedules SET last_run = ? WHERE id = ?").bind(now.date, schedule.id).run();
    const queued = await createJob(db, schedule.guild_id, schedule.channel_id, schedule.keep_pinned === 1);
    console.log(JSON.stringify({ event: "schedule_triggered", schedule_id: schedule.id, channel_id: schedule.channel_id, queued }));
  }

  const { results: jobs } = await db.prepare("SELECT * FROM purge_jobs ORDER BY id").all();
  for (const job of jobs) {
    if (discord.remaining() < 3 || discord.timeLeft() < 5_000) break;
    const result = await runJob(db, discord, job);
    console.log(JSON.stringify({ event: "purge_progress", channel_id: job.channel_id, status: result.status, deleted: result.deleted }));
  }
}

async function forgetRemovedGuilds(db, discord) {
  const guildIds = new Set();
  let after = "0";
  for (;;) {
    const page = await discord.request("GET", `/users/@me/guilds?limit=200&after=${after}`);
    for (const g of page) guildIds.add(g.id);
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  const { results } = await db.prepare("SELECT DISTINCT guild_id FROM schedules UNION SELECT DISTINCT guild_id FROM purge_jobs").all();
  for (const { guild_id } of results) {
    if (guildIds.has(guild_id)) continue;
    await db.batch([
      db.prepare("DELETE FROM schedules WHERE guild_id = ?").bind(guild_id),
      db.prepare("DELETE FROM purge_jobs WHERE guild_id = ?").bind(guild_id),
    ]);
    console.log(JSON.stringify({ event: "guild_forgotten", guild_id }));
  }
}
