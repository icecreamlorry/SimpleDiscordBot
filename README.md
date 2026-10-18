# SimpleDiscordBot

A small Discord bot, hosted for free on Cloudflare Workers, that:

- **`/purge [channel] [keep_pinned]`** deletes every message in a channel (asks for confirmation first).
- **`/anonymise [channel]`** reposts every message in a channel as the bot, oldest first, then deletes the originals, so the channel keeps the same messages in the same order without showing who wrote them (asks for confirmation first).
- **`/say [channel] [attachment]`** opens a pop-up where you write a message (multi-line, up to 4,000 characters), which the bot then posts as itself, so it's anonymous from the start. Mentions in it never ping anyone. You can only post where you could post yourself.
- **`/schedule add | list | remove`** clears or anonymises a channel automatically every day or on a chosen weekday at a set time (UK time). Pick the `action` when adding (deleting is the default). After the first anonymise run, the bot's earlier messages stay in place, so each later run only reposts what's been posted since.
- **`/export-members`** sends you a CSV of the server's members (username, the display name shown in that server, and their roles), visible only to you.

All replies are ephemeral (only the person who ran the command sees them).

`/purge`, `/anonymise`, `/schedule` and `/say` work in text channels and in the chat built into voice and stage channels (where Discord events take place). `/say` also works in announcement channels and threads.

**Admin-only.** Every command needs the Administrator permission, and the bot itself refuses anyone else (including button presses and pop-ups), even if a command is opened up under Server Settings → Integrations. To relax this later, set `ADMIN_ONLY` to `"false"` in [wrangler.jsonc](wrangler.jsonc) and redeploy. The commands then follow Discord's Integrations settings, plus the bot's own checks (e.g. Manage Messages in the channel for `/purge`). To change which permission a command needs by default, edit `default_member_permissions` in [src/commands.js](src/commands.js) and run `npm run register`.

## How it works

There's no always-on process. Discord sends each slash command to the Worker over HTTPS (an "interactions endpoint"), and a Cloudflare cron trigger runs every minute to start scheduled purges and continue large purges and anonymise jobs. Schedules and in-progress jobs are kept in a Cloudflare D1 database.

Because of this the bot always shows as **offline** in the member list. That's normal; the commands still work.

Workers Free allows about 50 Discord API calls per run, so big purges are done in chunks: up to roughly 800 recent messages a minute. Messages older than 14 days can't be bulk-deleted (a Discord limit) and go one at a time, about 40 a minute.

Anonymising runs at roughly 20–30 messages a minute, since each message has to be reposted (Discord also rate-limits bots posting in one channel). Message content is only held in memory while a message is reposted; the database stores just a cursor and the IDs of originals waiting to be deleted.

What `/anonymise` keeps and loses:
- Kept: text (long Nitro messages are split in two), attachments up to 10 MB each, pins, bots' rich embeds, stickers as text notes, forwarded messages' content.
- Polls become a text summary of the results: each answer indented with its vote count and percentage, then the total, then on its own line whether the poll had closed (final results) or was still open when the channel was anonymised. Only totals are copied, never who voted.
- Threads: a thread started from a message is rebuilt under the reposted message (same name, messages copied in order, archive/lock state kept), then the old thread is deleted, so links to it change. Every other thread in the channel, including private and archived ones, is anonymised in place and then re-archived/re-locked as it was. "X started a thread" notices become a bot message linking to the thread. Each thread runs as its own background job.
- Lost: original timestamps, reactions, reply links. Other system messages ("X joined", boosts) are deleted, not reposted.
- Reposts are sent as silent messages and never ping anyone.
- Only messages that existed when it started are touched. Anything posted while it runs stays put, so ask people not to post until it finishes.

## Setup

You need Node.js 20+ and a Cloudflare account.

1. **Discord app.** At <https://discord.com/developers/applications>:
   - **Bot**: copy the token, and turn on **Server Members Intent** (needed for `/export-members`) and **Message Content Intent** (needed for `/anonymise`; without it the bot stops before changing anything).
   - **General Information**: copy the **Public Key** into `DISCORD_PUBLIC_KEY` in [wrangler.jsonc](wrangler.jsonc). Set the Terms of Service and Privacy Policy URLs (see below).
2. **Install and log in to Cloudflare:**
   ```bash
   npm install
   npx wrangler login
   ```
3. **Database and token.** The D1 database ID is already in `wrangler.jsonc`. Create the tables, then store the bot token as a secret (it will prompt you to paste it):
   ```bash
   npm run db:migrate
   npx wrangler secret put DISCORD_TOKEN
   ```
4. **Deploy:**
   ```bash
   npm run deploy
   ```
   Note the URL it prints, e.g. `https://simple-discord-bot.<you>.workers.dev`.
5. **Connect Discord.** In **General Information**, set **Interactions Endpoint URL** to that URL plus `/interactions` and save. Discord sends a test request, so this only saves once the Worker is deployed with the right public key.
6. **Register the slash commands.** Copy `.dev.vars.example` to `.dev.vars`, put your token in it, then:
   ```bash
   npm run register
   ```
   Re-run this whenever you change [src/commands.js](src/commands.js).
7. **Invite the bot** with scopes `bot` and `applications.commands` and the permissions in the table below. If the bot is already in your server, you can add them to its role instead of re-inviting it.

### Permissions

| Permission | Used by |
| --- | --- |
| View Channels | everything |
| Read Message History | `/purge`, `/anonymise` |
| Manage Messages | `/purge`, `/anonymise` (deleting messages) |
| Send Messages | `/anonymise` (reposting), `/say` |
| Embed Links | `/anonymise` (copying bots' embeds) |
| Attach Files | `/anonymise` (re-uploading attachments), `/say` |
| Create Public Threads | `/anonymise` (rebuilding threads under reposts) |
| Send Messages in Threads | `/anonymise` (reposting inside threads), `/say` in threads |
| Manage Threads | `/anonymise` (seeing private threads, unarchiving/unlocking and re-locking threads, deleting rebuilt threads' originals) |

Permissions integer for an invite link: `326417640448`.

Privileged intents (Bot page): **Server Members Intent** for `/export-members`, **Message Content Intent** for `/anonymise`.

Logs: Cloudflare dashboard → Workers & Pages → simple-discord-bot → Logs, or `npx wrangler tail`.

## Development

```bash
npm test        # unit tests, including purge/anonymise against a simulated channel
npm run dev     # local Worker; trigger the cron with http://localhost:8787/__scheduled
```

## Notes

- Scheduled times use `BOT_TIMEZONE` (default `Europe/London`, so they follow BST/GMT). A scheduled purge or anonymise starts within 15 minutes of its time or is skipped until the next scheduled day.
- Schedules are removed when a job finds the channel deleted, and within an hour of the bot being removed from a server.

## Legal pages

The Terms of Service and Privacy Policy live in [`docs/`](docs/) and are served by GitHub Pages: in the repo's **Settings → Pages**, choose *Deploy from a branch*, branch `main`, folder `/docs`.

- Terms of Service: `https://icecreamlorry.github.io/SimpleDiscordBot/terms.html`
- Privacy Policy: `https://icecreamlorry.github.io/SimpleDiscordBot/privacy.html`

The contact address is assembled by `docs/contact.js` so it isn't visible to scrapers in the page source.
