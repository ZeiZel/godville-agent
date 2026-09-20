import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../src/database.js";
import type { BudgetPolicy } from "../src/types.js";

const policy: BudgetPolicy = { reserveCharges: 100, maxChargesPerDay: 100, maxChargesPerRolling7d: 200, maxChargesPerExpedition: 60 };
const at = (value: string): Date => new Date(value);

function database(): { db: AgentDatabase; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "godville-db-test-"));
  const db = new AgentDatabase(directory);
  return { db, dispose: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("reservation is atomic, cost-and-operation idempotent, and never reauthorizes a resolved decision", () => {
  const { db, dispose } = database();
  try {
    const now = at("2026-01-02T10:00:00.000Z");
    assert.equal(db.importBalance(300, "initial", now), true);
    assert.equal(db.reserveCharges("decision", "operation", 50, policy, "voyage", now), true);
    assert.equal(db.reserveCharges("decision", "operation", 50, policy, "voyage", now), true);
    assert.equal(db.reserveCharges("decision", "other-operation", 50, policy, "voyage", now), false);
    assert.equal(db.reserveCharges("decision", "operation", 51, policy, "voyage", now), false);
    assert.equal(db.reservedCharges(), 50);
    assert.equal(db.resolveReservation("decision", "operation", "CONFIRM", now), true);
    assert.equal(db.availableCharges(), 250);
    assert.equal(db.reserveCharges("decision", "operation", 50, policy, "voyage", now), false);
    assert.equal(db.resolveReservation("decision", "other-operation", "CONFIRM", now), false);
  } finally { dispose(); }
});

test("same-millisecond balances use insertion sequence and caps count active reservations", () => {
  const { db, dispose } = database();
  try {
    const now = at("2026-01-02T10:00:00.000Z");
    assert.equal(db.importBalance(260, "first", now), true);
    assert.equal(db.importBalance(200, "latest", now), true);
    assert.equal(db.currentBalance(), 200);
    assert.equal(db.reserveCharges("first", "op-1", 60, { ...policy, maxChargesPerDay: 60 }, "voyage", now), true);
    assert.equal(db.reserveCharges("second", "op-2", 1, { ...policy, maxChargesPerDay: 60 }, "voyage", now), false);
    assert.equal(db.reserveCharges("invalid", "op-3", Number.NaN, policy, undefined, now), false);
    assert.equal(db.reserveCharges("zero", "op-4", 0, policy, undefined, now), false);
    assert.equal(db.importBalance(200, "invalid date", new Date("invalid")), false);
  } finally { dispose(); }
});

test("separate connections cannot re-reserve the same decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-db-test-"));
  const first = new AgentDatabase(directory);
  const second = new AgentDatabase(directory);
  try {
    const now = at("2026-01-02T10:00:00.000Z");
    assert.equal(first.importBalance(300, "initial", now), true);
    assert.equal(first.reserveCharges("same", "operation", 50, policy, undefined, now), true);
    assert.equal(second.reserveCharges("same", "other-operation", 50, policy, undefined, now), false);
    assert.equal(second.reservedCharges(), 50);
  } finally {
    first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("only a live fenced writer recovers executed operations after restart", () => {
  const { db, dispose } = database();
  try {
    const operation = db.createOperation("fight:1", undefined, "arena.zpg.start", 1, {}, {});
    assert.equal(db.transitionOperation(operation.id, "PLANNED", "EXECUTED"), true);
    assert.equal(db.recoverUncertainOperations(), 0);
    assert.equal(db.acquireLease("daemon", "first", 1_000, at("2026-01-02T10:00:00.000Z")), true);
    const token = db.leaseToken("daemon", "first");
    assert.notEqual(token, undefined);
    assert.equal(db.recoverUncertainOperations("daemon", "second", token!, at("2026-01-02T10:00:01.000Z")), 0);
    assert.equal(db.recoverUncertainOperations("daemon", "first", token!, at("2026-01-02T10:00:00.100Z")), 1);
    assert.equal(db.renewLease("daemon", "first", token!, 1_000, at("2026-01-02T10:00:00.500Z")), true);
  } finally { dispose(); }
});

test("an ambiguous handler blocks a later event intent until manual reconciliation", () => {
  const { db, dispose } = database();
  try {
    const first = db.createOperation("zpg:2026-01-02T10", undefined, "arena.zpg.start", 1, {}, {});
    assert.equal(db.transitionOperation(first.id, "PLANNED", "EXECUTED"), true);
    assert.equal(db.transitionOperation(first.id, "EXECUTED", "AMBIGUOUS"), true);
    assert.equal(db.hasUnresolvedOperation("arena.zpg.start"), true);
    const nextHour = db.createOperation("zpg:2026-01-02T11", undefined, "arena.zpg.start", 1, {}, {});
    assert.equal(nextHour.state, "PLANNED");
    assert.equal(db.hasUnresolvedOperation("arena.zpg.start"), true, "CLI journal gate must reject this later intent");
    assert.equal(db.transitionOperation(first.id, "AMBIGUOUS", "CONFIRMED"), true);
    assert.equal(db.hasUnresolvedOperation("arena.zpg.start"), false);
  } finally { dispose(); }
});
