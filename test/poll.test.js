import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPoll } from "../src/poll.js";

const poll = (results, extra = {}) => ({
  question: { text: "Where should we meet?" },
  answers: [
    { answer_id: 1, poll_media: { text: "Pizza place", emoji: { name: "🍕" } } },
    { answer_id: 2, poll_media: { text: "Café", emoji: { name: "☕" } } },
    { answer_id: 3, poll_media: { text: "Park", emoji: { id: "123", name: "tree" } } },
  ],
  expiry: "2099-01-01T00:00:00Z",
  results,
  ...extra,
});

test("closed poll shows final results", () => {
  const text = formatPoll(poll({ is_finalized: true, answer_counts: [{ id: 1, count: 7 }, { id: 2, count: 4 }, { id: 3, count: 2 }] }));
  assert.equal(
    text,
    [
      "📊 Poll: Where should we meet?",
      "🍕 Pizza place: 7 votes (54%)",
      "☕ Café: 4 votes (31%)",
      "<:tree:123> Park: 2 votes (15%)",
      "13 votes in total (poll closed, final results)",
    ].join("\n"),
  );
});

test("open poll says it was still open, and answers with no votes show 0", () => {
  const text = formatPoll(poll({ is_finalized: false, answer_counts: [{ id: 1, count: 1 }] }));
  assert.match(text, /☕ Café: 0 votes \(0%\)/);
  assert.match(text, /🍕 Pizza place: 1 vote \(100%\)/);
  assert.match(text, /1 vote in total \(poll still open when this channel was anonymised\)$/);
});

test("a poll past its end time counts as closed even before Discord finalises it", () => {
  const text = formatPoll(poll({ is_finalized: false, answer_counts: [] }, { expiry: "2020-01-01T00:00:00Z" }));
  assert.match(text, /0 votes in total \(poll closed, final results\)$/);
});

test("multiple-choice polls and missing results are explained", () => {
  assert.match(formatPoll(poll({ is_finalized: true, answer_counts: [] }, { allow_multiselect: true })), /people could pick more than one answer/);
  assert.match(formatPoll(poll(undefined)), /results unavailable/);
});

test("anonymise reposts a poll as its results summary", async () => {
  const { buildRepost } = await import("../src/anonymise.js");
  const plan = buildRepost({ type: 0, content: "", author: { id: "2" }, poll: poll({ is_finalized: true, answer_counts: [{ id: 2, count: 3 }] }) });
  assert.match(plan.chunks[0], /^📊 Poll: Where should we meet\?\n/);
  assert.match(plan.chunks[0], /3 votes in total \(poll closed, final results\)$/);
});
