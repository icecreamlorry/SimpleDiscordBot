// Shared test helpers.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** A D1-shaped database backed by in-memory SQLite, built from the real migrations. */
export function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

export function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
