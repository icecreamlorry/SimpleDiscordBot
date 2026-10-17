# SimpleDiscordBot

A small Discord bot that:

- **`/purge [channel] [keep_pinned]`** deletes every message in a channel (asks for confirmation first). Needs Manage Messages.
- **`/schedule add | list | remove`** clears a channel automatically every day or on a chosen weekday at a set time. Needs Manage Messages.
- **`/export-members`** sends you a CSV of the server's member usernames, visible only to you. Needs Manage Server.

All replies are ephemeral (only the person who ran the command sees them).

## Setup

1. Create an application at <https://discord.com/developers/applications>.
2. Under **Bot**:
   - Copy the token.
   - Turn on **Server Members Intent** (needed for `/export-members`). Message Content Intent is *not* needed.
3. Under **General Information**, set:
   - Terms of Service URL: `https://icecreamlorry.github.io/SimpleDiscordBot/terms.html`
   - Privacy Policy URL: `https://icecreamlorry.github.io/SimpleDiscordBot/privacy.html`
4. Invite the bot using **OAuth2 → URL Generator** with scopes `bot` and `applications.commands`, and bot permissions **View Channels**, **Read Message History** and **Manage Messages**.
5. Install and run:

   ```bash
   python -m venv .venv
   .venv\Scripts\activate          # Windows; use `source .venv/bin/activate` elsewhere
   pip install -r requirements.txt
   copy .env.example .env          # then put your token in .env
   python bot.py
   ```

Slash commands are registered globally on startup and can take a few minutes to appear the first time.

## Notes

- Scheduled times use `BOT_TIMEZONE` (default `Europe/London`, so they follow BST/GMT). If the bot is offline when a purge is due, it runs if the bot comes back within 15 minutes; otherwise that run is skipped.
- Discord only allows bulk deletion of messages under 14 days old. Older messages are deleted one at a time, so clearing a large, old channel can take a long time.
- Schedules are saved to `data/schedules.json` (server/channel IDs and times only) and are removed automatically if the channel is deleted or the bot leaves the server.

## Legal pages

The Terms of Service and Privacy Policy live in [`docs/`](docs/) and are served by GitHub Pages: in the repo's **Settings → Pages**, choose *Deploy from a branch*, branch `main`, folder `/docs`. The contact address is assembled by `docs/contact.js` so it isn't visible to scrapers in the page source.
