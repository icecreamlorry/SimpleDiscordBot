import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { editCommand, submitEdit } from "../src/edit.js";
import { json } from "./helpers.js";

const BOT_ID = "1";
const rightClick = (message) => ({ data: { target_id: message.id, resolved: { messages: { [message.id]: message } } } });

test("only the bot's own messages can be edited", () => {
  const result = editCommand(rightClick({ id: "50", author: { id: "2" }, content: "hi" }), BOT_ID);
  assert.match(result.problem, /only edit my own/);
});

test("the pop-up is filled with the current text", () => {
  const { modal } = editCommand(rightClick({ id: "50", author: { id: BOT_ID }, content: "teh typo" }), BOT_ID);
  const input = modal.components[0].components[0];
  assert.equal(modal.custom_id, "edit:50");
  assert.equal(input.value, "teh typo");
  assert.equal(input.required, true);
  // Text can be cleared if the message still has a file.
  const withFile = editCommand(rightClick({ id: "51", author: { id: BOT_ID }, content: "", attachments: [{}] }), BOT_ID);
  assert.equal(withFile.modal.components[0].components[0].required, false);
});

let requests;
let realFetch;
beforeEach(() => {
  requests = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ method: init.method, path: new URL(url).pathname.replace("/api/v10", ""), body: JSON.parse(init.body) });
    return json(200, {});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("submitting edits the message without pinging anyone", async () => {
  const interaction = {
    application_id: "1",
    token: "tok",
    guild_id: "9",
    channel_id: "700",
    data: { custom_id: "edit:50", components: [{ type: 1, components: [{ type: 4, custom_id: "text", value: "the fix <@123>" }] }] },
  };
  await submitEdit(interaction, { DISCORD_TOKEN: "token" }, "50");
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].path, "/channels/700/messages/50");
  assert.deepEqual(requests[0].body, { content: "the fix <@123>", allowed_mentions: { parse: [] } });
  assert.match(requests[1].body.content, /^Updated: https:\/\/discord\.com\/channels\/9\/700\/50$/);
});
