import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  SQL_CLEANUP_RECAPS,
  SQL_CREATE_INVALIDATIONS,
  SQL_CREATE_RECAPS,
  SQL_CREATE_RECAPS_INDEX,
  SQL_HAS_RECAP_FOR_TURNS,
  SQL_INSERT_RECAP,
  SQL_LATEST_RECAP,
  SQL_LIST_RECAPS,
  SQL_UPSERT_INVALIDATION,
} from "../src/recap.ts";

function openRecapDb() {
  const db = new Database(":memory:");
  db.exec(SQL_CREATE_RECAPS);
  db.exec(SQL_CREATE_RECAPS_INDEX);
  db.exec(SQL_CREATE_INVALIDATIONS);
  return db;
}

function insertRecap(
  db: Database.Database,
  row: {
    id: string;
    threadId: string;
    summary: string;
    generatedAt: number;
    turns: number;
    suppressed?: number;
  },
) {
  db.prepare(SQL_INSERT_RECAP).run(
    row.id,
    row.threadId,
    row.summary,
    1,
    row.generatedAt,
    row.turns,
    "bb/test",
    row.suppressed ?? 0,
  );
}

test("list and latest recaps skip invalidated and suppressed rows", () => {
  const db = openRecapDb();
  insertRecap(db, { id: "old", threadId: "t1", summary: "old", generatedAt: 1, turns: 3 });
  insertRecap(db, { id: "fresh", threadId: "t1", summary: "fresh", generatedAt: 3, turns: 4 });
  insertRecap(db, { id: "hidden", threadId: "t2", summary: "hidden", generatedAt: 4, turns: 2 });
  insertRecap(db, { id: "suppressed", threadId: "t3", summary: "", generatedAt: 5, turns: 2, suppressed: 1 });
  db.prepare(SQL_UPSERT_INVALIDATION).run("t2", 10);

  const latest = db.prepare(SQL_LATEST_RECAP).get("t1") as { id: string };
  assert.equal(latest.id, "fresh");

  const listed = db.prepare(SQL_LIST_RECAPS).all(10) as Array<{ id: string }>;
  assert.deepEqual(listed.map((row) => row.id), ["fresh", "old"]);

  assert.equal(db.prepare(SQL_HAS_RECAP_FOR_TURNS).get("t1", 4) !== undefined, true);
  assert.equal(db.prepare(SQL_HAS_RECAP_FOR_TURNS).get("t2", 2) === undefined, true);
  db.close();
});

test("cleanup deletes suppressed and invalidated rows without selecting the mutating table directly", () => {
  const db = openRecapDb();
  insertRecap(db, { id: "keep-new", threadId: "t1", summary: "keep", generatedAt: 30, turns: 5 });
  insertRecap(db, { id: "keep-old", threadId: "t2", summary: "keep", generatedAt: 20, turns: 5 });
  insertRecap(db, { id: "drop-visible", threadId: "t3", summary: "drop", generatedAt: 10, turns: 5 });
  insertRecap(db, { id: "suppressed", threadId: "t4", summary: "", generatedAt: 40, turns: 5, suppressed: 1 });
  insertRecap(db, { id: "invalidated", threadId: "t5", summary: "gone", generatedAt: 50, turns: 5 });
  db.prepare(SQL_UPSERT_INVALIDATION).run("t5", 60);

  db.prepare(SQL_CLEANUP_RECAPS).run(2);
  const remaining = db.prepare("SELECT id FROM recaps ORDER BY id").all() as Array<{ id: string }>;
  assert.deepEqual(remaining.map((row) => row.id), ["keep-new", "keep-old"]);
  db.close();
});
