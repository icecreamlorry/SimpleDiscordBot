"""SimpleDiscordBot: clears channels on demand or on a schedule, and exports member lists as CSV."""

import csv
import io
import json
import logging
import os
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import discord
from discord import app_commands
from discord.ext import tasks
from dotenv import load_dotenv

load_dotenv()

TOKEN = os.environ.get("DISCORD_TOKEN")
TIMEZONE = ZoneInfo(os.environ.get("BOT_TIMEZONE", "Europe/London"))
DATA_FILE = Path(os.environ.get("SCHEDULE_FILE", "data/schedules.json"))
# A scheduled purge only fires if the bot is running within this long after the scheduled time,
# so a bot that was offline doesn't unexpectedly clear a channel hours late.
RUN_WINDOW = timedelta(minutes=15)

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

log = logging.getLogger("simplebot")


# --- Schedule storage --------------------------------------------------------------------------
# Only server IDs, channel IDs and timing settings are stored. No user data is persisted.

class ScheduleStore:
    def __init__(self, path: Path):
        self.path = path
        self.next_id = 1
        self.schedules: list[dict] = []
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            self.next_id = data.get("next_id", 1)
            self.schedules = data.get("schedules", [])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"next_id": self.next_id, "schedules": self.schedules}, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def add(self, guild_id: int, channel_id: int, at: str, day: str, keep_pinned: bool, last_run: str | None) -> dict:
        schedule = {
            "id": self.next_id,
            "guild_id": guild_id,
            "channel_id": channel_id,
            "time": at,
            "day": day,
            "keep_pinned": keep_pinned,
            "last_run": last_run,
        }
        self.next_id += 1
        self.schedules.append(schedule)
        self.save()
        return schedule

    def for_guild(self, guild_id: int) -> list[dict]:
        return [s for s in self.schedules if s["guild_id"] == guild_id]

    def remove(self, guild_id: int, schedule_id: int) -> bool:
        before = len(self.schedules)
        self.schedules = [s for s in self.schedules if not (s["guild_id"] == guild_id and s["id"] == schedule_id)]
        if len(self.schedules) != before:
            self.save()
            return True
        return False

    def remove_where(self, predicate) -> None:
        before = len(self.schedules)
        self.schedules = [s for s in self.schedules if not predicate(s)]
        if len(self.schedules) != before:
            self.save()


def describe_day(day: str) -> str:
    return "every day" if day == "daily" else f"every {DAY_NAMES[int(day)]}"


def scheduled_datetime(schedule: dict, on: datetime) -> datetime:
    hour, minute = map(int, schedule["time"].split(":"))
    return datetime.combine(on.date(), time(hour, minute), tzinfo=TIMEZONE)


def runs_on(schedule: dict, on: datetime) -> bool:
    return schedule["day"] == "daily" or int(schedule["day"]) == on.weekday()


# --- Bot ---------------------------------------------------------------------------------------

class SimpleBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.members = True  # Privileged: needed to list every member for the CSV export.
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.store = ScheduleStore(DATA_FILE)
        self.purging: set[int] = set()

    async def setup_hook(self) -> None:
        self.tree.add_command(schedule_group)
        await self.tree.sync()
        self.schedule_loop.start()

    async def on_ready(self) -> None:
        log.info("Logged in as %s (%s) in %d servers", self.user, self.user.id, len(self.guilds))

    async def on_guild_remove(self, guild: discord.Guild) -> None:
        # Bot was kicked or the server was deleted: forget everything about it.
        self.store.remove_where(lambda s: s["guild_id"] == guild.id)

    async def on_guild_channel_delete(self, channel: discord.abc.GuildChannel) -> None:
        self.store.remove_where(lambda s: s["channel_id"] == channel.id)

    async def purge_channel(self, channel: discord.TextChannel, keep_pinned: bool) -> int:
        """Delete every message in the channel. Returns the number deleted.

        Messages under 14 days old are bulk-deleted; older ones have to be deleted one at a
        time (a Discord API limit), so very large or old channels can take a while.
        """
        if channel.id in self.purging:
            raise RuntimeError("A purge is already running in that channel.")
        self.purging.add(channel.id)
        try:
            check = (lambda m: not m.pinned) if keep_pinned else (lambda m: True)
            deleted = await channel.purge(limit=None, check=check, reason="SimpleDiscordBot purge")
            return len(deleted)
        finally:
            self.purging.discard(channel.id)

    @tasks.loop(seconds=30)
    async def schedule_loop(self) -> None:
        now = datetime.now(TIMEZONE)
        today = now.date().isoformat()
        for schedule in list(self.store.schedules):
            if schedule.get("last_run") == today or not runs_on(schedule, now):
                continue
            due = scheduled_datetime(schedule, now)
            if not (due <= now < due + RUN_WINDOW):
                continue

            schedule["last_run"] = today
            self.store.save()

            channel = self.get_channel(schedule["channel_id"])
            if not isinstance(channel, discord.TextChannel):
                log.warning("Schedule %s: channel %s not found", schedule["id"], schedule["channel_id"])
                continue
            try:
                count = await self.purge_channel(channel, schedule.get("keep_pinned", False))
                log.info("Schedule %s: deleted %d messages in #%s (%s)", schedule["id"], count, channel.name, channel.guild.name)
            except Exception:
                log.exception("Schedule %s: purge of #%s failed", schedule["id"], channel.name)

    @schedule_loop.before_loop
    async def before_schedule_loop(self) -> None:
        await self.wait_until_ready()


bot = SimpleBot()


def missing_bot_perms(channel: discord.TextChannel) -> list[str]:
    perms = channel.permissions_for(channel.guild.me)
    needed = {
        "View Channel": perms.view_channel,
        "Read Message History": perms.read_message_history,
        "Manage Messages": perms.manage_messages,
    }
    return [name for name, ok in needed.items() if not ok]


# --- /purge ------------------------------------------------------------------------------------

class ConfirmPurge(discord.ui.View):
    def __init__(self, author_id: int, channel: discord.TextChannel, keep_pinned: bool):
        super().__init__(timeout=60)
        self.author_id = author_id
        self.channel = channel
        self.keep_pinned = keep_pinned

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.author_id

    @discord.ui.button(label="Delete everything", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.stop()
        await interaction.response.edit_message(content=f"Deleting messages in {self.channel.mention}...", view=None)
        try:
            count = await bot.purge_channel(self.channel, self.keep_pinned)
            result = f"Deleted {count} messages in {self.channel.mention}."
        except discord.Forbidden:
            result = "I don't have permission to delete messages there."
        except Exception as e:
            log.exception("Manual purge failed")
            result = f"Purge failed: {e}"
        try:
            await interaction.edit_original_response(content=result)
        except discord.HTTPException:
            pass  # Interaction token expires after 15 minutes; long purges can outlive it.

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.stop()
        await interaction.response.edit_message(content="Cancelled.", view=None)


@bot.tree.command(name="purge", description="Delete all messages in a channel")
@app_commands.describe(channel="Channel to clear (defaults to this one)", keep_pinned="Leave pinned messages in place")
@app_commands.default_permissions(manage_messages=True)
@app_commands.guild_only()
async def purge(interaction: discord.Interaction, channel: discord.TextChannel | None = None, keep_pinned: bool = False) -> None:
    channel = channel or interaction.channel
    if not isinstance(channel, discord.TextChannel):
        await interaction.response.send_message("That only works in text channels.", ephemeral=True)
        return
    if not channel.permissions_for(interaction.user).manage_messages:
        await interaction.response.send_message(f"You need Manage Messages in {channel.mention}.", ephemeral=True)
        return
    if missing := missing_bot_perms(channel):
        await interaction.response.send_message(f"I'm missing these permissions in {channel.mention}: {', '.join(missing)}", ephemeral=True)
        return
    pinned_note = " (pinned messages will be kept)" if keep_pinned else ""
    await interaction.response.send_message(
        f"This will permanently delete **all** messages in {channel.mention}{pinned_note}. This cannot be undone.",
        view=ConfirmPurge(interaction.user.id, channel, keep_pinned),
        ephemeral=True,
    )


# --- /schedule ---------------------------------------------------------------------------------

schedule_group = app_commands.Group(
    name="schedule",
    description="Manage scheduled channel purges",
    guild_only=True,
    default_permissions=discord.Permissions(manage_messages=True),
)

DAY_CHOICES = [app_commands.Choice(name="Every day", value="daily")] + [
    app_commands.Choice(name=name, value=str(i)) for i, name in enumerate(DAY_NAMES)
]


@schedule_group.command(name="add", description="Clear a channel automatically at a set time")
@app_commands.describe(
    channel="Channel to clear",
    at=f"Time in 24h HH:MM ({TIMEZONE.key})",
    day="Which day(s) to run",
    keep_pinned="Leave pinned messages in place",
)
@app_commands.choices(day=DAY_CHOICES)
async def schedule_add(
    interaction: discord.Interaction,
    channel: discord.TextChannel,
    at: str,
    day: app_commands.Choice[str],
    keep_pinned: bool = False,
) -> None:
    try:
        parsed = datetime.strptime(at.strip(), "%H:%M")
    except ValueError:
        await interaction.response.send_message("Time must be in 24-hour HH:MM format, e.g. `03:00`.", ephemeral=True)
        return
    if not channel.permissions_for(interaction.user).manage_messages:
        await interaction.response.send_message(f"You need Manage Messages in {channel.mention}.", ephemeral=True)
        return
    if missing := missing_bot_perms(channel):
        await interaction.response.send_message(f"I'm missing these permissions in {channel.mention}: {', '.join(missing)}", ephemeral=True)
        return

    at_str = parsed.strftime("%H:%M")
    draft = {"time": at_str, "day": day.value}
    now = datetime.now(TIMEZONE)
    # If today's slot has already passed, don't fire it straight away.
    last_run = now.date().isoformat() if runs_on(draft, now) and scheduled_datetime(draft, now) <= now else None
    schedule = bot.store.add(interaction.guild_id, channel.id, at_str, day.value, keep_pinned, last_run)
    await interaction.response.send_message(
        f"Schedule #{schedule['id']}: {channel.mention} will be cleared {describe_day(day.value)} at {at_str} ({TIMEZONE.key}).",
        ephemeral=True,
    )


@schedule_group.command(name="list", description="Show scheduled purges in this server")
async def schedule_list(interaction: discord.Interaction) -> None:
    schedules = bot.store.for_guild(interaction.guild_id)
    if not schedules:
        await interaction.response.send_message("No scheduled purges.", ephemeral=True)
        return
    lines = [
        f"#{s['id']}: <#{s['channel_id']}> {describe_day(s['day'])} at {s['time']}" + (" (keeps pinned)" if s.get("keep_pinned") else "")
        for s in schedules
    ]
    await interaction.response.send_message(f"Times are {TIMEZONE.key}.\n" + "\n".join(lines), ephemeral=True)


@schedule_group.command(name="remove", description="Remove a scheduled purge")
@app_commands.describe(schedule_id="The number shown by /schedule list")
async def schedule_remove(interaction: discord.Interaction, schedule_id: int) -> None:
    if bot.store.remove(interaction.guild_id, schedule_id):
        await interaction.response.send_message(f"Removed schedule #{schedule_id}.", ephemeral=True)
    else:
        await interaction.response.send_message(f"No schedule #{schedule_id} in this server.", ephemeral=True)


# --- /export-members ---------------------------------------------------------------------------

@bot.tree.command(name="export-members", description="Download the server's member list as a CSV")
@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
async def export_members(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True, thinking=True)
    guild = interaction.guild

    # Built in memory and sent straight to the requester; nothing is written to disk.
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["username"])
    count = 0
    async for member in guild.fetch_members(limit=None):
        writer.writerow([member.name])
        count += 1

    data = io.BytesIO(buffer.getvalue().encode("utf-8-sig"))  # BOM so Excel opens it as UTF-8
    filename = f"members-{datetime.now(TIMEZONE):%Y-%m-%d}.csv"
    await interaction.followup.send(
        f"{count} members in {guild.name}.",
        file=discord.File(data, filename=filename),
        ephemeral=True,
    )


# --- Error handling ----------------------------------------------------------------------------

@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    log.exception("Command error", exc_info=error)
    message = "You don't have permission to do that." if isinstance(error, app_commands.MissingPermissions) else "Something went wrong."
    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.")
    bot.run(TOKEN, root_logger=True)
