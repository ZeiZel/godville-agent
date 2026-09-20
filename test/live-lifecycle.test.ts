import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../src/database.js";
import { reconcileLiveLifecycle } from "../src/live-lifecycle.js";
import { OBSERVATION_VERSION, type ObservationV1 } from "../src/types.js";

const base = (mode: ObservationV1["mode"], eventId: string): ObservationV1 => ({
  version: OBSERVATION_VERSION, observedAt: mode === "idle" ? "2026-09-20T10:01:00.000Z" : "2026-09-20T10:00:00.000Z", sourceVersion: "fixture", freshness: "fresh",
  heroId: "fixture-hero", eventId, mode, capabilities: [], progressionKnown: true, health: "known_safe",
  prana: { current: 50, capacity: 100 }, charges: 200, cooldowns: {}, rawShape: [],
});

test("verified field return after a persisted active arena releases the ZPG lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  try {
    const first = new AgentDatabase(directory);
    const missionBefore = first.liveMissionId("fixture-hero");
    const activeObservation = base("arena", "/duels/log/arena-1");
    const activeObservationId = first.saveObservation(activeObservation, "fixture");
    const operation = first.createOperation("zpg-intent", undefined, "arena.zpg.start", 1, { finalObservationId: activeObservationId }, {});
    assert.equal(first.transitionOperation(operation.id, "PLANNED", "AMBIGUOUS", "postcondition unavailable"), true);
    first.confirmCooldown("zpg-active", operation.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(first, activeObservation, "fixture-hero");
    first.close();

    const restarted = new AgentDatabase(directory);
    reconcileLiveLifecycle(restarted, base("idle", "field-2"), "fixture-hero");
    assert.equal(restarted.isCooldownActive("zpg-active", new Date("2026-09-20T11:00:00.000Z")), false);
    assert.equal(restarted.operation(operation.id)?.state, "CONFIRMED");
    const missionAfter = restarted.liveMissionId("fixture-hero");
    assert.notEqual(missionAfter, missionBefore);
    reconcileLiveLifecycle(restarted, { ...base("idle", "field-3"), observedAt: "2026-09-20T10:02:00.000Z" }, "fixture-hero");
    assert.equal(restarted.liveMissionId("fixture-hero"), missionAfter);
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("verified field return clears a lock for an already confirmed arena operation", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const active = base("arena", "/duels/log/confirmed");
    const observationId = db.saveObservation(active, "fixture");
    const operation = db.createOperation("confirmed-zpg", undefined, "arena.zpg.start", 1, { finalObservationId: observationId }, {});
    db.transitionOperation(operation.id, "PLANNED", "CONFIRMED", "confirmed before restart");
    db.confirmCooldown("zpg-active", operation.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, active, "fixture-hero");
    reconcileLiveLifecycle(db, { ...base("idle", "field-confirmed"), observedAt: "2026-09-20T10:01:00.000Z" }, "fixture-hero");
    assert.equal(db.isCooldownActive("zpg-active", new Date("2026-09-20T11:00:00.000Z")), false);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("idle or queue observations without a seen arena never release the lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const operation = db.createOperation("zpg-intent", undefined, "arena.zpg.start", 1, {}, {});
    db.transitionOperation(operation.id, "PLANNED", "AMBIGUOUS", "unknown");
    db.confirmCooldown("zpg-active", operation.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, base("adventure_queue", "queue-1"), "fixture-hero");
    reconcileLiveLifecycle(db, base("idle", "field-1"), "fixture-hero");
    assert.equal(db.isCooldownActive("zpg-active", new Date("2026-09-20T11:00:00.000Z")), true);
    assert.equal(db.operation(operation.id)?.state, "AMBIGUOUS");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("verified arena reconciliation does not resolve an unrelated charge reservation", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    db.importBalance(201, "fixture");
    const decisionId = db.saveDecision({ id: "decision-1", kind: "Recommend", action: "hero.restore_prana", reason: "fixture", evidence: [] }, undefined, "test", "test");
    const restore = db.createOperation("restore-intent", decisionId, "hero.restore_prana", 1, {}, {});
    db.transitionOperation(restore.id, "PLANNED", "AMBIGUOUS", "uncertain");
    assert.equal(db.reserveCharges(decisionId, restore.id, 1, { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 }), true);
    const arena = db.createOperation("zpg-intent", undefined, "arena.zpg.start", 1, {}, {});
    db.transitionOperation(arena.id, "PLANNED", "AMBIGUOUS", "unknown");
    db.confirmCooldown("zpg-active", arena.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, base("arena", "/duels/log/arena-1"), "fixture-hero");
    reconcileLiveLifecycle(db, base("idle", "field-2"), "fixture-hero");
    assert.equal(db.reservedCharges(), 1);
    assert.equal(db.operation(restore.id)?.state, "AMBIGUOUS");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("verified return expires an old zero-charge action but preserves charge operations", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const activeObservation = { ...base("arena", "/duels/log/arena-1"), observedAt: new Date(Date.now() + 1_000).toISOString() };
    const observationId = db.saveObservation(activeObservation, "fixture");
    const idleObservationId = db.saveObservation({ ...base("idle", "idle-before-arena"), observedAt: "2026-09-20T09:59:00.000Z" }, "fixture");
    const old = db.createOperation("old-encourage", undefined, "hero.encourage", 1, { finalObservationId: idleObservationId }, {});
    db.transitionOperation(old.id, "PLANNED", "AMBIGUOUS", "uncertain");
    const arena = db.createOperation("zpg-intent", undefined, "arena.zpg.start", 1, {}, {});
    db.transitionOperation(arena.id, "PLANNED", "AMBIGUOUS", "unknown");
    db.confirmCooldown("zpg-active", arena.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, activeObservation, "fixture-hero");
    reconcileLiveLifecycle(db, { ...base("idle", "field-2"), observedAt: new Date(Date.now() + 2_000).toISOString() }, "fixture-hero");
    assert.equal(db.operation(old.id)?.state, "FAILED");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("lifecycle never binds or clears another account's arena operation", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const accountA = { ...base("arena", "/duels/log/a"), heroId: "hero-a" };
    const observationId = db.saveObservation(accountA, "fixture");
    const operation = db.createOperation("zpg-a", undefined, "arena.zpg.start", 1, { finalObservationId: observationId }, {});
    db.transitionOperation(operation.id, "PLANNED", "AMBIGUOUS", "unknown");
    db.confirmCooldown("zpg-active", operation.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, { ...base("arena", "/duels/log/b"), heroId: "hero-b" }, "hero-b");
    reconcileLiveLifecycle(db, { ...base("idle", "field-b"), heroId: "hero-b" }, "hero-b");
    assert.equal(db.operation(operation.id)?.state, "AMBIGUOUS");
    assert.equal(db.isCooldownActive("zpg-active", new Date("2026-09-20T11:00:00.000Z")), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid idle timestamp cannot release a previously seen arena lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const active = base("arena", "/duels/log/a");
    const observationId = db.saveObservation(active, "fixture");
    const operation = db.createOperation("zpg-invalid-time", undefined, "arena.zpg.start", 1, { finalObservationId: observationId }, {});
    db.transitionOperation(operation.id, "PLANNED", "AMBIGUOUS", "unknown");
    db.confirmCooldown("zpg-active", operation.id, new Date("2026-09-20T14:00:00.000Z"));
    reconcileLiveLifecycle(db, active, "fixture-hero");
    reconcileLiveLifecycle(db, { ...base("idle", "field-invalid"), observedAt: "invalid" }, "fixture-hero");
    assert.equal(db.operation(operation.id)?.state, "AMBIGUOUS");
    assert.equal(db.isCooldownActive("zpg-active", new Date("2026-09-20T11:00:00.000Z")), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("expiry binds dungeon turns to the stable battle id across turn numbers", () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-lifecycle-"));
  const db = new AgentDatabase(directory);
  try {
    const oldTurn = { ...base("dungeon", "godville-dungeon-turn:/duels/log/abc:76"), observedAt: new Date(Date.now() + 1_000).toISOString() };
    const observationId = db.saveObservation(oldTurn, "fixture");
    const operation = db.createOperation("old-dungeon-move", undefined, "dungeon.move.auto", 1, { finalObservationId: observationId }, {});
    db.transitionOperation(operation.id, "PLANNED", "AMBIGUOUS", "turn postcondition unavailable");
    const latestTurn = { ...oldTurn, eventId: "godville-dungeon-turn:/duels/log/abc:100", observedAt: new Date(Date.now() + 2_000).toISOString() };
    reconcileLiveLifecycle(db, latestTurn, "fixture-hero");
    reconcileLiveLifecycle(db, { ...base("idle", "field-after-dungeon"), observedAt: new Date(Date.now() + 3_000).toISOString() }, "fixture-hero");
    assert.equal(db.operation(operation.id)?.state, "FAILED");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
