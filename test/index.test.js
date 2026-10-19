// Sends signed interactions through the Worker's fetch handler, as Discord would.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import worker from "../src/index.js";
import { fakeD1 } from "./helpers.js";

let privateKey;
let env;

before(async () => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  privateKey = keys.privateKey;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  env = { DB: fakeD1(), DISCORD_PUBLIC_KEY: publicKey, DISCORD_TOKEN: "token", BOT_TIMEZONE: "Europe/London", ADMIN_ONLY: "true" };
});

async function send(payload, { sign = true } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { "X-Signature-Timestamp": timestamp };
  if (sign) {
    const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + body));
    headers["X-Signature-Ed25519"] = Buffer.from(signature).toString("hex");
  }
  const ctx = { waitUntil: () => {} };
  const res = await worker.fetch(new Request("https://bot.example/interactions", { method: "POST", headers, body }), env, ctx);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}

const bits = (...n) => String(n.reduce((a, b) => a | (1n << BigInt(b)), 0n));
// Discord reports every permission for admins.
const ADMIN = String((1n << 50n) - 1n);
const BOT_PERMS = bits(6, 10, 11, 13, 14, 15, 16, 34, 35, 38, 51);
const base = { application_id: "1", token: "t", guild_id: "9", channel_id: "222", channel: { id: "222", type: 0 }, app_permissions: BOT_PERMS };
const command = (name, options = [], member = ADMIN) => ({ ...base, type: 2, member: { user: { id: "5" }, permissions: member }, data: { name, options } });

test("rejects requests without a valid signature, and answers Discord's ping", async () => {
  assert.equal((await send({ type: 1 }, { sign: false })).status, 401);
  assert.deepEqual((await send({ type: 1 })).body, { type: 1 });
});

test("non-admins are refused", async () => {
  const res = await send(command("purge", [], bits(10, 13)));
  assert.match(res.body.data.content, /Only server admins/);
});

test("/purge-and-anonymise asks for confirmation", async () => {
  const res = await send(command("purge-and-anonymise", [{ name: "keep_pinned", value: true }]));
  assert.match(res.body.data.content, /except protected \(🛡️\) and pinned messages/);
  const button = res.body.data.components[0].components[0];
  assert.equal(button.custom_id, "purgeanon-confirm:222:1");
});

test("/schedule add accepts the purge-and-anonymise action", async () => {
  const res = await send(
    command("schedule", [
      {
        type: 1,
        name: "add",
        options: [
          { name: "at", value: "03:00" },
          { name: "day", value: "daily" },
          { name: "action", value: "purge-anonymise" },
        ],
      },
    ]),
  );
  assert.match(res.body.data.content, /will be purged \(keeping protected messages\) then anonymised every day at 03:00/);
  const list = await send(command("schedule", [{ type: 1, name: "list" }]));
  assert.match(list.body.data.content, /purge \+ anonymise <#222>/);
});

test("every other command still routes", async () => {
  for (const name of ["purge", "anonymise"]) {
    const res = await send(command(name));
    assert.ok(res.body.data.components, `${name} shows confirm buttons`);
  }
  assert.equal((await send(command("say"))).body.type, 9, "/say opens a pop-up");
});

test("right-clicking a bot message opens the edit pop-up", async () => {
  // With no readable bot ID in the token, the bot falls back to the application ID ("1").
  const target = { id: "50", author: { id: "1" }, content: "old text" };
  const res = await send({ ...base, type: 2, member: { user: { id: "5" }, permissions: ADMIN }, data: { type: 3, name: "Edit bot message", target_id: "50", resolved: { messages: { 50: target } } } });
  assert.equal(res.body.type, 9);
  assert.equal(res.body.data.components[0].components[0].value, "old text");
});
