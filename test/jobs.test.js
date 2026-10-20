// Runs purge and anonymise jobs against an in-memory fake of the Discord API, with a real
// SQLite database built from the migrations, and a small request budget per run so jobs
// have to resume across many runs, the way the cron trigger drives them.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { splitContent } from "../src/anonymise.js";
import { DiscordClient } from "../src/discord.js";
import { createJob, runJob } from "../src/jobs.js";
import { runCron } from "../src/cron.js";
import { localNow } from "../src/time.js";
import { SHIELD, isProtected, setProtected } from "../src/protect.js";
import { dividerText } from "../src/dividers.js";
import { anonymiseMessage } from "../src/anonymise-message.js";
import { compareIds, snowflakeAt } from "../src/messages.js";
import { fakeD1, json } from "./helpers.js";

const GUILD = "9";
const CHANNEL = "500";
const BOT = { id: "1", username: "simplebot", bot: true };
const ALICE = { id: "2", username: "alice" };
const BOB = { id: "3", username: "bob" };
// Bot tokens start with the bot's user ID in base64.
const BOT_TOKEN = `${btoa(BOT.id)}.x.y`;

// --- Fake Discord ------------------------------------------------------------------------------

let channels; // id -> { messages, thread?: { parent_id, name, archived, locked, private } }
let nextSeq;
let realFetch;

function newId(atMs = Date.now()) {
  return String(BigInt(snowflakeAt(atMs)) + nextSeq++);
}

function addMessage(channelId, fields, atMs) {
  const m = { type: 0, content: "", attachments: [], embeds: [], flags: 0, pinned: false, channel_id: channelId, ...fields, id: newId(atMs) };
  channels[channelId].messages.push(m);
  return m;
}

function addThread(parentId, { name, archived = false, locked = false, isPrivate = false, starter = null }, atMs) {
  const id = starter ? starter.id : newId(atMs);
  channels[id] = { messages: [], thread: { parent_id: parentId, name, archived, locked, private: isPrivate } };
  if (starter) starter.thread = threadObject(id);
  return id;
}

function threadObject(id) {
  const t = channels[id].thread;
  return { id, parent_id: t.parent_id, name: t.name, type: t.private ? 12 : 11, thread_metadata: { archived: t.archived, locked: t.locked, auto_archive_duration: 1440, archive_timestamp: "2026-01-01T00:00:00Z" } };
}

const byId = (a, b) => compareIds(a.id, b.id);
const sortedMessages = (id) => [...channels[id].messages].sort(byId);

async function fakeDiscord(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === "cdn.discordapp.com") return new Response(new Blob([`file:${u.pathname}`]));
  const path = u.pathname.replace("/api/v10", "");
  const method = init.method ?? "GET";
  let m;

  if (method === "GET" && path === "/users/@me/guilds") return json(200, [{ id: GUILD }]);
  if (method === "GET" && path === `/guilds/${GUILD}/threads/active`) {
    const active = Object.keys(channels).filter((id) => channels[id].thread && !channels[id].thread.archived);
    return json(200, { threads: active.map(threadObject) });
  }
  if (method === "GET" && (m = path.match(/^\/channels\/(\d+)\/threads\/archived\/(public|private)$/))) {
    if (channels[m[1]].voice) return json(400, { code: 50024, message: "Cannot execute action on this channel type" });
    const archived = Object.keys(channels).filter((id) => {
      const t = channels[id].thread;
      return t && t.parent_id === m[1] && t.archived && t.private === (m[2] === "private");
    });
    return json(200, { threads: archived.map(threadObject), has_more: false });
  }
  if ((m = path.match(/^\/channels\/(\d+)$/))) {
    const thread = channels[m[1]]?.thread;
    if (!thread) return json(404, { code: 10003, message: "Unknown Channel" });
    if (method === "PATCH") {
      Object.assign(thread, JSON.parse(init.body));
      return json(200, threadObject(m[1]));
    }
    if (method === "DELETE") {
      delete channels[m[1]];
      return json(200, {});
    }
  }
  if (method === "PUT" && (m = path.match(/^\/channels\/(\d+)\/thread-members\/@me$/))) {
    if (channels[m[1]].thread.archived) return json(400, { code: 50083, message: "Thread is archived" });
    return json(204, null);
  }
  if (method === "POST" && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
    const starter = channels[m[1]].messages.find((x) => x.id === m[2]);
    const body = JSON.parse(init.body);
    const id = addThread(m[1], { name: body.name, starter });
    return json(201, threadObject(id));
  }

  if (!(m = path.match(/^\/channels\/(\d+)\/messages(?:\/(.+))?$/))) throw new Error(`Unexpected ${method} ${path}`);
  const [, channelId, rest] = m;
  const channel = channels[channelId];
  if (!channel) return json(404, { code: 10003, message: "Unknown Channel" });

  if (method === "GET" && !rest) {
    const limit = Number(u.searchParams.get("limit"));
    const after = u.searchParams.get("after");
    const before = u.searchParams.get("before");
    // Like real Discord, a channel can still list just-deleted messages for a moment.
    const all = [...channel.messages, ...(channel.ghosts ?? [])].sort(byId);
    if (channel.ghosts) channel.ghosts = [];
    const page = after ? all.filter((x) => compareIds(x.id, after) > 0).slice(0, limit) : all.filter((x) => !before || compareIds(x.id, before) < 0).slice(-limit);
    return json(200, page.reverse()); // Discord returns newest first
  }
  if (method === "GET" && rest && /^\d+$/.test(rest)) {
    const found = channel.messages.find((x) => x.id === rest);
    return found ? json(200, found) : json(404, { code: 10008, message: "Unknown Message" });
  }
  if (method === "POST" && !rest) {
    if (channel.thread?.archived || channel.thread?.locked) return json(400, { code: 50083, message: "Thread is archived" });
    let payload;
    let files = [];
    if (init.body instanceof FormData) {
      payload = JSON.parse(init.body.get("payload_json"));
      files = payload.attachments.map((a) => ({ filename: a.filename, url: `https://cdn.discordapp.com/new/${a.filename}`, size: 10 }));
    } else {
      payload = JSON.parse(init.body);
    }
    assert.deepEqual(payload.allowed_mentions, { parse: [] }, "reposts must not ping anyone");
    assert.ok(payload.content.length <= 2000);
    return json(200, addMessage(channelId, { author: BOT, content: payload.content, attachments: files, embeds: payload.embeds ?? [] }));
  }
  if ((m = rest?.match(/^(\d+)\/reactions\/([^/]+)\/@me$/))) {
    const target = channel.messages.find((x) => x.id === m[1]);
    const name = decodeURIComponent(m[2]);
    target.reactions = (target.reactions ?? []).filter((r) => !(r.me && r.emoji.name === name));
    if (method === "PUT") target.reactions.push({ emoji: { id: null, name }, me: true, count: 1 });
    return json(204, null);
  }
  if (method === "PUT" && (m = rest?.match(/^pins\/(\d+)$/))) {
    channel.messages.find((x) => x.id === m[1]).pinned = true;
    return json(204, null);
  }
  if (method === "POST" && rest === "bulk-delete") {
    const ids = JSON.parse(init.body).messages;
    if (ids.some((id) => !channel.messages.some((x) => x.id === id))) return json(404, { code: 10008, message: "Unknown Message" });
    if (channel.lagging) channel.ghosts = channel.messages.filter((x) => ids.includes(x.id));
    channel.messages = channel.messages.filter((x) => !ids.includes(x.id));
    return json(204, null);
  }
  if (method === "DELETE" && rest) {
    const target = channel.messages.find((x) => x.id === rest);
    if (!target) return json(404, { code: 10008, message: "Unknown Message" });
    if (target.type === 21) return json(400, { code: 50021, message: "Cannot execute action on a system message" });
    channel.messages = channel.messages.filter((x) => x.id !== rest);
    return json(204, null);
  }
  throw new Error(`Unexpected ${method} ${path}`);
}

// --- Driver ------------------------------------------------------------------------------------

/** Runs every queued job like the cron would, with a small budget per job per run. */
async function runAllJobs(db, budget) {
  for (let round = 1; round <= 500; round++) {
    const { results: jobs } = await db.prepare("SELECT * FROM purge_jobs ORDER BY id").all();
    if (!jobs.length) return round;
    for (const job of jobs) {
      const result = await runJob(db, new DiscordClient(BOT_TOKEN, { budget }), job);
      if (result.status === "failed") return { failed: result };
    }
  }
  throw new Error("jobs never finished");
}

beforeEach(() => {
  channels = { [CHANNEL]: { messages: [] } };
  nextSeq = 0n;
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeDiscord;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const isDivider = (m) => /^── \d{1,2} \w+ \d{4} ──$/.test(m.content);
// Message text in order, leaving out date dividers (tests for those use rawContents).
const contents = (id) => sortedMessages(id).filter((m) => !isDivider(m)).map((m) => m.content);
const rawContents = (id) => sortedMessages(id).map((m) => m.content);
const posts = (id) => sortedMessages(id).filter((m) => !isDivider(m));
const allFromBot = (id) => sortedMessages(id).every((m) => m.author.bot);

// --- Tests -------------------------------------------------------------------------------------

test("anonymise reposts the channel in order as the bot and removes the originals", async () => {
  const day = 24 * 60 * 60 * 1000;
  const old = Date.now() - 30 * day; // too old to bulk delete
  addMessage(CHANNEL, { author: ALICE, content: "old message from alice" }, old);
  addMessage(CHANNEL, { author: BOB, content: "old message from bob", pinned: true }, old + 1000);
  addMessage(CHANNEL, { author: BOB, type: 7 }); // "bob joined" system message
  addMessage(CHANNEL, { author: ALICE, content: "look", attachments: [{ filename: "cat.png", url: "https://cdn.discordapp.com/a/cat.png", size: 1000 }] });
  addMessage(CHANNEL, { author: BOT, content: "an earlier bot message" });
  addMessage(CHANNEL, { author: ALICE, content: "x".repeat(2500) }); // Nitro-length message
  addMessage(CHANNEL, { author: BOB, type: 19, content: "a reply <@2>" });
  for (let i = 0; i < 25; i++) addMessage(CHANNEL, { author: i % 2 ? ALICE : BOB, content: `message ${i}` });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  const rounds = await runAllJobs(db, 20);
  assert.ok(rounds > 2, "should have needed several runs");

  assert.deepEqual(contents(CHANNEL), [
    "old message from alice",
    "old message from bob",
    "look",
    "an earlier bot message",
    ...splitContent("x".repeat(2500)),
    "a reply <@2>",
    ...Array.from({ length: 25 }, (_, i) => `message ${i}`),
  ]);
  assert.ok(allFromBot(CHANNEL));
  const after = posts(CHANNEL);
  assert.equal(after.find((m) => m.content === "look").attachments[0].filename, "cat.png");
  assert.equal(after.find((m) => m.content === "old message from bob").pinned, true);
});

test("threads started from messages are rebuilt under the repost and the old thread is deleted", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "before" });
  const starter = addMessage(CHANNEL, { author: BOB, content: "let's discuss" });
  const oldThread = addThread(CHANNEL, { name: "Discussion", starter, archived: true });
  addMessage(oldThread, { author: BOB, type: 21 }); // the thread's link back to its starter
  for (let i = 0; i < 15; i++) addMessage(oldThread, { author: i % 2 ? ALICE : BOB, content: `reply ${i}` });
  addMessage(CHANNEL, { author: ALICE, content: "after" });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  const rounds = await runAllJobs(db, 15);
  assert.equal(typeof rounds, "number", JSON.stringify(rounds));

  assert.deepEqual(contents(CHANNEL), ["before", "let's discuss", "after"]);
  assert.ok(allFromBot(CHANNEL));
  assert.equal(channels[oldThread], undefined, "old thread deleted");

  const repost = posts(CHANNEL)[1];
  const newThread = channels[repost.id];
  assert.ok(newThread?.thread, "repost has a thread");
  assert.equal(newThread.thread.name, "Discussion");
  assert.equal(newThread.thread.archived, true, "archive state copied");
  assert.deepEqual(contents(repost.id), Array.from({ length: 15 }, (_, i) => `reply ${i}`));
  assert.ok(allFromBot(repost.id));
});

test("standalone threads, including private archived locked ones, are anonymised in place", async () => {
  const publicThread = addThread(CHANNEL, { name: "Public" });
  addMessage(CHANNEL, { author: ALICE, type: 18, content: "Public", message_reference: { channel_id: publicThread } });
  addMessage(CHANNEL, { author: BOB, content: "hello" });
  const privateThread = addThread(CHANNEL, { name: "Private", isPrivate: true, archived: true, locked: true });
  for (let i = 0; i < 12; i++) addMessage(publicThread, { author: ALICE, content: `pub ${i}` });
  for (let i = 0; i < 12; i++) addMessage(privateThread, { author: BOB, content: `priv ${i}` });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  const rounds = await runAllJobs(db, 15);
  assert.equal(typeof rounds, "number", JSON.stringify(rounds));

  assert.deepEqual(contents(CHANNEL), [`🧵 Thread: <#${publicThread}>`, "hello"], "thread notice replaced by a link");
  assert.deepEqual(contents(publicThread), Array.from({ length: 12 }, (_, i) => `pub ${i}`));
  assert.deepEqual(contents(privateThread), Array.from({ length: 12 }, (_, i) => `priv ${i}`));
  assert.ok(allFromBot(CHANNEL) && allFromBot(publicThread) && allFromBot(privateThread));
  assert.equal(channels[privateThread].thread.archived, true, "re-archived");
  assert.equal(channels[privateThread].thread.locked, true, "re-locked");
});

test("the bot's own messages at the start of a channel stay where they are", async () => {
  const keptA = addMessage(CHANNEL, { author: BOT, content: "rules", pinned: true });
  addMessage(CHANNEL, { author: BOB, type: 7 }); // a join message in between doesn't matter
  const keptB = addMessage(CHANNEL, { author: BOT, content: "welcome" });
  const keptThread = addThread(CHANNEL, { name: "Questions", starter: keptB });
  addMessage(keptThread, { author: ALICE, content: "a question" });
  addMessage(CHANNEL, { author: ALICE, content: "hi" });
  addMessage(CHANNEL, { author: BOT, content: "bot message after someone else's" });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 20);

  const after = posts(CHANNEL);
  assert.deepEqual(after.map((m) => m.content), ["rules", "welcome", "hi", "bot message after someone else's"]);
  assert.equal(after[0].id, keptA.id, "first bot message untouched");
  assert.equal(after[1].id, keptB.id, "second bot message untouched");
  assert.ok(after[0].pinned);
  assert.notEqual(after[3].id, keptA.id);
  assert.ok(allFromBot(CHANNEL));
  // The kept message's thread stays attached and is anonymised in place.
  assert.deepEqual(contents(keptThread), ["a question"]);
  assert.ok(allFromBot(keptThread));
});

test("anonymise leaves messages posted after it started alone", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "before" });
  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  const late = addMessage(CHANNEL, { author: BOB, content: "during" }, Date.now() + 5000);

  await runAllJobs(db, 45);
  assert.ok(channels[CHANNEL].messages.some((m) => m.id === late.id), "late message untouched");
  assert.deepEqual(contents(CHANNEL), ["before", "during"]);
});

test("anonymise stops without changing anything if message text can't be read", async () => {
  addMessage(CHANNEL, { author: ALICE }); // what messages look like without Message Content Intent
  addMessage(CHANNEL, { author: BOB });
  const before = structuredClone(channels);

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  const outcome = await runAllJobs(db, 45);
  assert.match(outcome.failed.error.message, /Message Content Intent/);
  assert.deepEqual(channels, before);
});

test("purge deletes everything except pinned messages when asked", async () => {
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 5; i++) addMessage(CHANNEL, { author: ALICE, content: `old ${i}` }, old + i);
  for (let i = 0; i < 150; i++) addMessage(CHANNEL, { author: BOB, content: `new ${i}`, pinned: i === 3 });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { keepPinned: true });
  await runAllJobs(db, 4);
  assert.deepEqual(contents(CHANNEL), ["new 3"]);
});

test("splitContent breaks long text at natural points", () => {
  const text = `${"a".repeat(1500)}\n${"b".repeat(1000)}`;
  assert.deepEqual(splitContent(text), ["a".repeat(1500), "b".repeat(1000)]);
  assert.deepEqual(splitContent("c".repeat(4000)).map((c) => c.length), [2000, 2000]);
});

test("the cron starts scheduled anonymise and purge jobs", async () => {
  const OTHER = "501";
  channels[OTHER] = { messages: [] };
  addMessage(CHANNEL, { author: ALICE, content: "keep me, anonymously" });
  addMessage(OTHER, { author: BOB, content: "delete me" });

  const db = fakeD1();
  const now = localNow("Europe/London");
  const time = `${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`;
  const add = (channel, action) =>
    db.prepare("INSERT INTO schedules (guild_id, channel_id, time, day, keep_pinned, action) VALUES (?, ?, ?, 'daily', 0, ?)").bind(GUILD, channel, time, action).run();
  await add(CHANNEL, "anonymise");
  await add(OTHER, "purge");

  await runCron({ DB: db, DISCORD_TOKEN: BOT_TOKEN, BOT_TIMEZONE: "Europe/London" }, Date.now());
  await runAllJobs(db, 45);

  assert.deepEqual(contents(CHANNEL), ["keep me, anonymously"]);
  assert.ok(allFromBot(CHANNEL));
  assert.deepEqual(contents(OTHER), []);
  const { results } = await db.prepare("SELECT last_run FROM schedules").all();
  assert.ok(results.every((r) => r.last_run === now.date), "each schedule runs once today");
});

test("voice and stage channel chats can be anonymised (they have no threads)", async () => {
  const VOICE = "600";
  channels[VOICE] = { messages: [], voice: true };
  addMessage(VOICE, { author: ALICE, content: "event starting soon" });
  addMessage(VOICE, { author: BOB, content: "can't wait" });

  const db = fakeD1();
  await createJob(db, GUILD, VOICE, { mode: "anonymise" });
  const rounds = await runAllJobs(db, 20);
  assert.equal(typeof rounds, "number", JSON.stringify(rounds));
  assert.deepEqual(contents(VOICE), ["event starting soon", "can't wait"]);
  assert.ok(allFromBot(VOICE));
});

const botShield = [{ emoji: { id: null, name: SHIELD }, me: true, count: 1 }];
const memberShield = [{ emoji: { id: null, name: SHIELD }, me: false, count: 1 }];

test("purges keep messages the bot has shielded, but not ones members shielded themselves", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "keep: bot shield", reactions: botShield });
  addMessage(CHANNEL, { author: BOB, content: "delete: member shield", reactions: memberShield });
  addMessage(CHANNEL, { author: BOB, content: "delete: nothing" });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL);
  await runAllJobs(db, 45);
  assert.deepEqual(contents(CHANNEL), ["keep: bot shield"]);
});

test("anonymise reposts protected messages with the bot's shield on the repost", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "protected", reactions: botShield });
  addMessage(CHANNEL, { author: BOB, content: "member shield only", reactions: memberShield });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 45);
  const after = posts(CHANNEL);
  assert.deepEqual(after.map((m) => m.content), ["protected", "member shield only"]);
  assert.ok(allFromBot(CHANNEL));
  assert.equal(isProtected(after[0]), true, "repost is protected");
  assert.equal(isProtected(after[1]), false);

  // ...so a purge afterwards keeps it.
  await createJob(db, GUILD, CHANNEL);
  await runAllJobs(db, 45);
  assert.deepEqual(contents(CHANNEL), ["protected"]);
});

test("protect and unprotect add and remove the bot's shield", async () => {
  const m = addMessage(CHANNEL, { author: ALICE, content: "hello" });
  const discord = new DiscordClient(BOT_TOKEN);
  await setProtected(discord, CHANNEL, m.id, true);
  assert.equal(isProtected(m), true);
  await setProtected(discord, CHANNEL, m.id, false);
  assert.equal(isProtected(m), false);
});

test("purge-and-anonymise deletes all but protected (and pinned) messages, then anonymises them", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "delete 1" });
  addMessage(CHANNEL, { author: BOB, content: "protected", reactions: botShield });
  addMessage(CHANNEL, { author: ALICE, content: "delete: member shield", reactions: memberShield });
  addMessage(CHANNEL, { author: BOB, content: "pinned", pinned: true });
  for (let i = 0; i < 20; i++) addMessage(CHANNEL, { author: ALICE, content: `delete ${i + 2}` });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "purge-anonymise", keepPinned: true });
  // Watch the job's final result to check both counts.
  let last;
  for (let round = 0; round < 100; round++) {
    const { results: jobs } = await db.prepare("SELECT * FROM purge_jobs ORDER BY id").all();
    if (!jobs.length) break;
    for (const job of jobs) last = await runJob(db, new DiscordClient(BOT_TOKEN, { budget: 12 }), job);
  }
  assert.equal(last.status, "done");
  assert.equal(last.purged, 22);
  assert.equal(last.count, 2);

  const after = posts(CHANNEL);
  assert.deepEqual(after.map((m) => m.content), ["protected", "pinned"]);
  assert.ok(allFromBot(CHANNEL));
  assert.equal(isProtected(after[0]), true, "still protected");
  assert.equal(after[1].pinned, true, "still pinned");
});

test("purge-and-anonymise never reposts messages Discord is still deleting", async () => {
  channels[CHANNEL].lagging = true;
  for (let i = 0; i < 9; i++) addMessage(CHANNEL, { author: ALICE, content: `delete ${i}` });
  addMessage(CHANNEL, { author: BOB, content: "protected", reactions: botShield });
  addMessage(CHANNEL, { author: BOT, content: "unprotected bot message" });

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "purge-anonymise" });
  await runAllJobs(db, 45);
  assert.deepEqual(contents(CHANNEL), ["protected"]);
  assert.ok(allFromBot(CHANNEL));
});

const DAY = 24 * 60 * 60 * 1000;
// Midday UK time n days ago, so dates don't depend on when the tests run.
function middayDaysAgo(n) {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d.getTime();
}
const dateOf = (ms) => localNow("Europe/London", new Date(ms)).date;

test("anonymise adds a date divider whenever the original date changes", async () => {
  const twoDaysAgo = middayDaysAgo(2);
  const yesterday = middayDaysAgo(1);
  addMessage(CHANNEL, { author: ALICE, content: "a" }, twoDaysAgo);
  addMessage(CHANNEL, { author: BOB, content: "b" }, twoDaysAgo + 60_000);
  addMessage(CHANNEL, { author: ALICE, content: "c" }, yesterday);

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 10); // small budget: dividers must survive being cut off between runs
  assert.deepEqual(rawContents(CHANNEL), [dividerText(dateOf(twoDaysAgo)), "a", "b", dividerText(dateOf(yesterday)), "c"]);
  assert.ok(allFromBot(CHANNEL));
});

test("no divider where Discord's own date line already says the same thing", async () => {
  const yesterday = middayDaysAgo(1);
  const today = Date.now();
  // Left by an earlier anonymise: yesterday's divider and a repost.
  addMessage(CHANNEL, { author: BOT, content: dividerText(dateOf(yesterday)) }, yesterday + 60_000);
  addMessage(CHANNEL, { author: BOT, content: "from yesterday" }, yesterday + 120_000);
  addMessage(CHANNEL, { author: ALICE, content: "new today" }, today - 1000);

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 45);
  // No divider for today: Discord shows its own date line there, and it's correct.
  assert.deepEqual(rawContents(CHANNEL), [dividerText(dateOf(yesterday)), "from yesterday", "new today"]);

  // Running again with nothing new changes nothing.
  const before = sortedMessages(CHANNEL).map((m) => m.id);
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 45);
  assert.deepEqual(sortedMessages(CHANNEL).map((m) => m.id), before);
});

test("old dividers further down are replaced, and reposts keep their original date", async () => {
  const threeDaysAgo = middayDaysAgo(3);
  const twoDaysAgo = middayDaysAgo(2);
  addMessage(CHANNEL, { author: ALICE, content: "human first" }, threeDaysAgo);
  // An earlier divider and repost from two days ago, reposted again (they're not at the top).
  addMessage(CHANNEL, { author: BOT, content: dividerText(dateOf(twoDaysAgo)) }, twoDaysAgo);
  addMessage(CHANNEL, { author: BOT, content: "old repost" }, Date.now() - 1000);

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 45);
  assert.deepEqual(rawContents(CHANNEL), [dividerText(dateOf(threeDaysAgo)), "human first", dividerText(dateOf(twoDaysAgo)), "old repost"]);
});

test("a divider is still added when Discord's own date line would show the wrong day", async () => {
  const twoDaysAgo = middayDaysAgo(2);
  const yesterday = middayDaysAgo(1);
  addMessage(CHANNEL, { author: BOT, content: "kept from two days ago" }, twoDaysAgo);
  // Written yesterday, anonymised today: Discord's line above the repost would say today.
  addMessage(CHANNEL, { author: ALICE, content: "written yesterday" }, yesterday);
  addMessage(CHANNEL, { author: BOB, content: "written today" }, Date.now() - 1000);

  const db = fakeD1();
  await createJob(db, GUILD, CHANNEL, { mode: "anonymise" });
  await runAllJobs(db, 45);
  assert.deepEqual(rawContents(CHANNEL), [
    "kept from two days ago",
    dividerText(dateOf(yesterday)),
    "written yesterday",
    dividerText(dateOf(Date.now())),
    "written today",
  ]);
});

test("Anonymise message reposts one message at the bottom and deletes the original", async () => {
  addMessage(CHANNEL, { author: ALICE, content: "first" });
  const target = addMessage(CHANNEL, { author: BOB, content: "make me anonymous", reactions: botShield, pinned: true });
  addMessage(CHANNEL, { author: ALICE, content: "last" });

  const db = fakeD1();
  const discord = new DiscordClient(BOT_TOKEN);
  const reply = await anonymiseMessage(db, discord, { guildId: GUILD, channelId: CHANNEL, messageId: target.id });
  assert.match(reply, /^Anonymised: https:\/\/discord\.com\/channels\//);

  const after = posts(CHANNEL);
  assert.deepEqual(after.map((m) => m.content), ["first", "last", "make me anonymous"]);
  assert.ok(after[2].author.bot);
  assert.equal(isProtected(after[2]), true, "keeps its shield");
  assert.equal(after[2].pinned, true, "keeps its pin");
  assert.ok(!channels[CHANNEL].messages.some((m) => m.id === target.id), "original deleted");
});

test("Anonymise message leaves the bot's own and already-deleted messages alone", async () => {
  const mine = addMessage(CHANNEL, { author: BOT, content: "already anonymous" });
  const db = fakeD1();
  const discord = new DiscordClient(BOT_TOKEN);
  assert.match(await anonymiseMessage(db, discord, { guildId: GUILD, channelId: CHANNEL, messageId: mine.id }), /already from me/);
  assert.match(await anonymiseMessage(db, discord, { guildId: GUILD, channelId: CHANNEL, messageId: "123" }), /already been deleted/);
  assert.deepEqual(contents(CHANNEL), ["already anonymous"]);
});
