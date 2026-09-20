import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../src/database.js";
import { claimArenaTurn, isArenaTurnClaimed, releaseArenaTurnForUnclicked } from "../src/arena-turn-ledger.js";

function directory() { return mkdtempSync(join(tmpdir(), "godville-arena-turn-")); }

test("one influence and one voice claim are allowed per ordinary arena turn", () => {
  const dir = directory(), db = new AgentDatabase(dir);
  try {
    assert.equal(claimArenaTurn(db, "hero", "/duels/log/battle", 7, "influence", "op-heal"), true);
    assert.equal(claimArenaTurn(db, "hero", "/duels/log/battle", 7, "influence", "op-punish"), false);
    assert.equal(claimArenaTurn(db, "hero", "/duels/log/battle", 7, "voice", "op-miracle"), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("uncertainty holds a claim and explicit unclicked release permits a retry", () => {
  const dir = directory(), db = new AgentDatabase(dir);
  try {
    assert.equal(claimArenaTurn(db, "hero", "battle", 1, "influence", "op-1"), true);
    assert.equal(claimArenaTurn(db, "hero", "battle", 1, "influence", "op-1"), false);
    assert.equal(releaseArenaTurnForUnclicked(db, "hero", "battle", 1, "influence", "op-1", false), false);
    assert.equal(releaseArenaTurnForUnclicked(db, "hero", "battle", 1, "influence", "op-other", true), false);
    assert.equal(releaseArenaTurnForUnclicked(db, "hero", "battle", 1, "influence", "op-1", true), true);
    assert.equal(claimArenaTurn(db, "hero", "battle", 1, "influence", "op-2"), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("claims survive restart and never mix accounts or battles", () => {
  const dir = directory();
  try {
    const first = new AgentDatabase(dir);
    assert.equal(claimArenaTurn(first, "hero-a", "battle-a", 3, "voice", "op-a"), true);
    first.close();
    const restarted = new AgentDatabase(dir);
    assert.equal(isArenaTurnClaimed(restarted, "HERO-A", "battle-a", 3, "voice"), true);
    assert.equal(claimArenaTurn(restarted, "hero-a", "battle-a", 3, "voice", "op-new"), false);
    assert.equal(claimArenaTurn(restarted, "hero-b", "battle-a", 3, "voice", "op-b"), true);
    assert.equal(claimArenaTurn(restarted, "hero-a", "battle-b", 3, "voice", "op-c"), true);
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two database connections race atomically and invalid inputs fail closed", () => {
  const dir = directory(), first = new AgentDatabase(dir), second = new AgentDatabase(dir);
  try {
    const results = [
      claimArenaTurn(first, "hero", "race", 4, "influence", "op-a"),
      claimArenaTurn(second, "hero", "race", 4, "influence", "op-b"),
    ];
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(claimArenaTurn(first, "", "race", 4, "voice", "bad"), false);
    assert.equal(claimArenaTurn(first, "hero", "race", -1, "voice", "bad"), false);
    assert.equal(claimArenaTurn(first, "hero", "race", 4, "influence", "bad"), false);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});
