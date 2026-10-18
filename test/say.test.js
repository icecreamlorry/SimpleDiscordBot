import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanUpDrafts, sayCommand, sendSay } from "../src/say.js";
import { fakeD1, json } from "./helpers.js";

const SEND = 1n << 11n;
const ATTACH = 1n << 15n;
const VIEW = 1n << 10n;
const SEND_IN_THREADS = 1n << 38n;
const perms = (...bits) => String(bits.reduce((a, b) => a | b, 0n));

let posted; // requests the fake Discord received
let edits;
let realFetch;

beforeEach(() => {
  posted = [];
  edits = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "cdn.discordapp.com") return new Response(new Blob(["file bytes"]));
    if (u.pathname.includes("/webhooks/")) {
      edits.push(JSON.parse(init.body).content);
      return json(200, {});
    }
    const m = u.pathname.match(/\/channels\/(\d+)\/messages$/);
    if (init.method === "POST" && m) {
      const form = init.body instanceof FormData ? init.body : null;
      const payload = form ? JSON.parse(form.get("payload_json")) : JSON.parse(init.body);
      posted.push({ channel: m[1], payload, file: form?.get("files[0]")?.name });
      return json(200, { id: String(1000 + posted.length) });
    }
    throw new Error(`Unexpected ${init.method} ${u.pathname}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const env = (db) => ({ DB: db, DISCORD_TOKEN: "token" });
const target = (fields) => ({ id: "700", type: 0, userPermissions: perms(VIEW, SEND, ATTACH), appPermissions: perms(VIEW, SEND, ATTACH), ...fields });
const submit = (draftId, text) => ({
  application_id: "1",
  token: "tok",
  guild_id: "9",
  data: { custom_id: `say:${draftId}`, components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: text }] }] },
});

test("/say opens a pop-up, then posts the text as the bot without pings", async () => {
  const db = fakeD1();
  const { modal } = await sayCommand({ data: {} }, env(db), target(), undefined);
  assert.equal(modal.components[0].components[0].style, 2, "multi-line text box");
  const draftId = modal.custom_id.split(":")[1];

  await sendSay(submit(draftId, "Line one\nLine two <@123> @everyone"), env(db), draftId);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channel, "700");
  assert.equal(posted[0].payload.content, "Line one\nLine two <@123> @everyone");
  assert.deepEqual(posted[0].payload.allowed_mentions, { parse: [] });
  assert.equal(posted[0].payload.flags, 0, "notifies people by default");
  assert.match(edits[0], /^Sent: https:\/\/discord\.com\/channels\/9\/700\/1001$/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM say_drafts").first()).n, 0, "draft removed");
});

test("/say carries an attachment through the pop-up", async () => {
  const db = fakeD1();
  const interaction = { data: { resolved: { attachments: { a1: { url: "https://cdn.discordapp.com/x/notes.pdf", filename: "notes.pdf", size: 2000 } } } } };
  const { modal } = await sayCommand(interaction, env(db), target(), "a1");
  assert.equal(modal.components[0].components[0].required, false, "text optional with a file");
  const draftId = modal.custom_id.split(":")[1];

  await sendSay(submit(draftId, ""), env(db), draftId);
  assert.equal(posted[0].file, "notes.pdf");
});

test("long messages are split to fit Discord's limit", async () => {
  const db = fakeD1();
  const { modal } = await sayCommand({ data: {} }, env(db), target(), undefined);
  const draftId = modal.custom_id.split(":")[1];
  await sendSay(submit(draftId, `${"a".repeat(1900)}\n${"b".repeat(1900)}`), env(db), draftId);
  assert.deepEqual(posted.map((p) => p.payload.content.length), [1900, 1900]);
});

test("/say refuses channels the user can't post in, and threads need the thread permission", async () => {
  const db = fakeD1();
  assert.match((await sayCommand({ data: {} }, env(db), target({ userPermissions: perms(VIEW) }), undefined)).problem, /can't send messages/);
  assert.match((await sayCommand({ data: {} }, env(db), target({ type: 11 }), undefined)).problem, /can't send messages/);
  const ok = await sayCommand({ data: {} }, env(db), target({ type: 11, userPermissions: perms(VIEW, SEND_IN_THREADS), appPermissions: perms(VIEW, SEND_IN_THREADS) }), undefined);
  assert.ok(ok.modal);
  // Voice and stage channel chats are allowed too.
  assert.ok((await sayCommand({ data: {} }, env(db), target({ type: 2 }), undefined)).modal);
  assert.ok((await sayCommand({ data: {} }, env(db), target({ type: 13 }), undefined)).modal);
});

test("unknown or expired drafts send nothing", async () => {
  const db = fakeD1();
  await sendSay(submit("made-up", "hi"), env(db), "made-up");
  assert.equal(posted.length, 0);
  assert.match(edits[0], /nothing was sent/);

  await db.prepare("INSERT INTO say_drafts (id, channel_id, created_at) VALUES ('old', '700', ?)").bind(Date.now() - 20 * 60 * 1000).run();
  await cleanUpDrafts(db);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM say_drafts").first()).n, 0);
});

test("/say can send silently when asked", async () => {
  const db = fakeD1();
  const { modal } = await sayCommand({ data: {} }, env(db), target(), undefined, { silent: true });
  const draftId = modal.custom_id.split(":")[1];
  await sendSay(submit(draftId, "quiet one"), env(db), draftId);
  assert.equal(posted[0].payload.flags, 1 << 12, "sent as an @silent message");
});
