import assert from "node:assert/strict";
import { test } from "node:test";
import { isDue, localNow, parseTime, slotStarted } from "../src/time.js";

const TZ = "Europe/London";

test("localNow follows UK summer and winter time", () => {
  // 17 Oct 2026 (BST, UTC+1) is a Saturday.
  assert.deepEqual(localNow(TZ, new Date("2026-10-17T02:05:00Z")), { date: "2026-10-17", minutes: 3 * 60 + 5, weekday: 5 });
  // 1 Dec 2026 (GMT) is a Tuesday.
  assert.deepEqual(localNow(TZ, new Date("2026-12-01T03:00:00Z")), { date: "2026-12-01", minutes: 180, weekday: 1 });
});

test("parseTime accepts 24h times only", () => {
  assert.equal(parseTime("3:00"), "03:00");
  assert.equal(parseTime(" 23:59 "), "23:59");
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("3pm"), null);
});

test("isDue fires within the window, once per day, on the right day", () => {
  const daily = { time: "03:00", day: "daily", last_run: null };
  const at = (iso) => localNow(TZ, new Date(iso));
  assert.equal(isDue(daily, at("2026-10-17T01:59:00Z")), false); // 02:59 local
  assert.equal(isDue(daily, at("2026-10-17T02:00:00Z")), true); // 03:00 local
  assert.equal(isDue(daily, at("2026-10-17T02:14:00Z")), true);
  assert.equal(isDue(daily, at("2026-10-17T02:15:00Z")), false); // window over
  assert.equal(isDue({ ...daily, last_run: "2026-10-17" }, at("2026-10-17T02:01:00Z")), false);

  const saturday = { time: "03:00", day: "5", last_run: null };
  const sunday = { time: "03:00", day: "6", last_run: null };
  assert.equal(isDue(saturday, at("2026-10-17T02:00:00Z")), true);
  assert.equal(isDue(sunday, at("2026-10-17T02:00:00Z")), false);
});

test("slotStarted marks today's past slot so a new schedule doesn't fire immediately", () => {
  const now = localNow(TZ, new Date("2026-10-17T10:00:00Z"));
  assert.equal(slotStarted({ time: "03:00", day: "daily" }, now), true);
  assert.equal(slotStarted({ time: "23:00", day: "daily" }, now), false);
  assert.equal(slotStarted({ time: "03:00", day: "0" }, now), false);
});
