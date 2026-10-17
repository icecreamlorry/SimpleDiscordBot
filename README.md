# SimpleDiscordBot

A small Discord bot, hosted for free on Cloudflare Workers, that:

- **`/purge [channel] [keep_pinned]`** deletes every message in a channel (asks for confirmation first). Needs Manage Messages.
- **`/schedule add | list | remove`** clears a channel automatically every day or on a chosen weekday at a set time (UK time). Needs Manage Messages.
- **`/export-members`** sends you a CSV of the server's members (username and the display name shown in that server), visible only to you. Needs Manage Server.

All replies are ephemeral (only the person who ran the command sees them).

## How it works

There's no always-on process. Discord sends each slash command to the Worker over HTTPS (an "interactions endpoint"), and a Cloudflare cron trigger runs every minute to start scheduled purges and continue large ones. Schedules and in-progress purges are kept in a Cloudflare D1 database.

Because of this the bot always shows as **offline** in the member list. That's normal; the commands still work.

Workers Free allows about 50 Discord API calls per run, so big purges are done in chunks: up to roughly 800 recent messages a minute. Messages older than 14 days can't be bulk-deleted (a Discord limit) and go one at a time, about 40 a minute.

## Setup

You need Node.js 20+ and a Cloudflare account.

1. **Discord app.** At <https://discord.com/developers/applications>:
   - **Bot**: copy the token, and turn on **Server Members Intent** (needed for `/export-members`).
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
7. **Invite the bot** with scopes `bot` and `applications.commands` and the permissions View Channels, Read Message History and Manage Messages.

Logs: Cloudflare dashboard → Workers & Pages → simple-discord-bot → Logs, or `npx wrangler tail`.

## Development

```bash
npm test        # unit tests for the scheduling logic
npm run dev     # local Worker; trigger the cron with http://localhost:8787/__scheduled
```

## Notes

- Scheduled times use `BOT_TIMEZONE` (default `Europe/London`, so they follow BST/GMT). A purge starts within 15 minutes of its time or is skipped until the next scheduled day.
- Schedules are removed when a purge finds the channel deleted, and within an hour of the bot being removed from a server.

## Legal pages

The Terms of Service and Privacy Policy live in [`docs/`](docs/) and are served by GitHub Pages: in the repo's **Settings → Pages**, choose *Deploy from a branch*, branch `main`, folder `/docs`.

- Terms of Service: `https://icecreamlorry.github.io/SimpleDiscordBot/terms.html`
- Privacy Policy: `https://icecreamlorry.github.io/SimpleDiscordBot/privacy.html`

The contact address is assembled by `docs/contact.js` so it isn't visible to scrapers in the page source.
