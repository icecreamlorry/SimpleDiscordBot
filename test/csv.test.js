import assert from "node:assert/strict";
import { test } from "node:test";
import { csvField, memberRow, roleNameLookup } from "../src/csv.js";

const member = (username, global_name = null, nick = null, roles = []) => ({ nick, roles, user: { username, global_name } });

test("display name prefers server nickname, then global display name, then username", () => {
  assert.equal(memberRow(member("alice", "Alice", "Ally")), "alice,Ally,");
  assert.equal(memberRow(member("bob", "Bobby")), "bob,Bobby,");
  assert.equal(memberRow(member("carol")), "carol,carol,");
});

test("roles are listed highest first, separated by semicolons, without @everyone", () => {
  const guildId = "100";
  const roles = roleNameLookup(
    [
      { id: "100", name: "@everyone", position: 0 },
      { id: "1", name: "Member", position: 1 },
      { id: "2", name: "Mods, Admins", position: 5 },
      { id: "3", name: "Artist", position: 3 },
    ],
    guildId,
  );
  assert.equal(memberRow(member("dave", null, null, ["1", "2", "3"]), roles), 'dave,dave,"Mods, Admins; Artist; Member"');
  assert.equal(memberRow(member("erin", null, null, ["1", "999"]), roles), "erin,erin,Member"); // unknown role ID skipped
});

test("fields are quoted and protected against spreadsheet formulas", () => {
  assert.equal(csvField('Say "hi", ok'), '"Say ""hi"", ok"');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("-5"), "'-5");
  assert.equal(csvField("@everyone"), "'@everyone");
  assert.equal(csvField("Zoë 🎮"), "Zoë 🎮");
});
