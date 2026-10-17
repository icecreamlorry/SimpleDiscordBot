import assert from "node:assert/strict";
import { test } from "node:test";
import { csvField, memberRow } from "../src/csv.js";

const member = (username, global_name = null, nick = null) => ({ nick, user: { username, global_name } });

test("display name prefers server nickname, then global display name, then username", () => {
  assert.equal(memberRow(member("alice", "Alice", "Ally")), "alice,Ally");
  assert.equal(memberRow(member("bob", "Bobby")), "bob,Bobby");
  assert.equal(memberRow(member("carol")), "carol,carol");
});

test("fields are quoted and protected against spreadsheet formulas", () => {
  assert.equal(csvField('Say "hi", ok'), '"Say ""hi"", ok"');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("-5"), "'-5");
  assert.equal(csvField("@everyone"), "'@everyone");
  assert.equal(csvField("Zoë 🎮"), "Zoë 🎮");
});
