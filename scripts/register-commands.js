// Registers the bot's slash commands with Discord. Run with `npm run register` after
// changing src/commands.js. Reads DISCORD_TOKEN from .dev.vars.
import { COMMANDS } from "../src/commands.js";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is not set. Copy .dev.vars.example to .dev.vars and add your bot token.");
  process.exit(1);
}

const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
const app = await fetch("https://discord.com/api/v10/applications/@me", { headers }).then((r) => r.json());
if (!app.id) {
  console.error("Could not look up the application:", app);
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${app.id}/commands`, {
  method: "PUT",
  headers,
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) {
  console.error(`Failed (${res.status}):`, JSON.stringify(await res.json(), null, 2));
  process.exit(1);
}
console.log(`Registered ${COMMANDS.length} commands for ${app.name}.`);
