// Runs every minute: starts due schedules (purge or anonymise), continues jobs that are
// in progress, and tidies up.
import { DiscordClient } from "./discord.js";
import { createJob, runJob } from "./jobs.js";
import { cleanUpDrafts } from "./say.js";
import { isDue, localNow } from "./time.js";

// Cron runs every minute; finish before the next one starts.
const CRON_TIME_MS = 50_000;

export async function runCron(env, scheduledTime) {
  const db = env.DB;
  const discord = new DiscordClient(env.DISCORD_TOKEN, { deadline: Date.now() + CRON_TIME_MS });
  const now = localNow(env.BOT_TIMEZONE, new Date(scheduledTime));

  await cleanUpDrafts(db);
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
    const queued = await createJob(db, schedule.guild_id, schedule.channel_id, { mode: schedule.action, keepPinned: schedule.keep_pinned === 1 });
    console.log(JSON.stringify({ event: "schedule_triggered", schedule_id: schedule.id, action: schedule.action, channel_id: schedule.channel_id, queued }));
  }

  const { results: jobs } = await db.prepare("SELECT * FROM purge_jobs ORDER BY id").all();
  for (const job of jobs) {
    if (discord.remaining() < 3 || discord.timeLeft() < 5_000) break;
    const result = await runJob(db, discord, job);
    console.log(JSON.stringify({ event: "job_progress", mode: job.mode, channel_id: job.channel_id, status: result.status, count: result.count }));
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
