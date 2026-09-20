import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClickOutcome } from "../src/browser.js";
import { AgentDatabase } from "../src/database.js";
import { parseLivePolicy, planLivePolicy } from "../src/live-policy.js";
import { runSequence, type LiveAdapter } from "../src/live-runner.js";
import { OBSERVATION_VERSION, type ObservationV1 } from "../src/types.js";

const observation = (rawShape: string[] = ["zpg-arena"]): ObservationV1 => ({ version: OBSERVATION_VERSION, observedAt: "2026-09-20T10:00:00.000Z", sourceVersion: "fixture", freshness: "fresh", heroId: "fixture-hero", eventId: "event-1", mode: "idle", capabilities: [], progressionKnown: true, health: "known_risk", healthPercent: 30, prana: { current: 30, capacity: 100 }, cooldowns: {}, rawShape });
const policy = parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [
  { id: "unknown-zpg", safety: "block", priority: 1000, weight: 1, when: [{ field: "readiness.zpg", compare: "missing", value: true }], sequence: [] },
  { id: "low", safety: "normal", priority: 10, weight: 1, when: [{ field: "health", compare: "equals", value: "known_risk" }], sequence: ["hero.encourage"] },
  { id: "high", safety: "normal", priority: 10, weight: 2, when: [{ field: "health", compare: "equals", value: "known_risk" }], sequence: ["hero.encourage"] },
] });

test("strict policy rejects dynamic commands and chooses safety then deterministic weight", () => {
  assert.throws(() => parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{ id: "bad", safety: "normal", priority: 1, weight: 1, when: [{ field: "mode", compare: "equals", value: "idle" }], sequence: ["eval"] }] }), /invalid/);
  assert.throws(() => parseLivePolicy({ schemaVersion: "live-policy/v1", ignored: true, rules: [{ id: "bad-extra", safety: "normal", priority: 1, weight: 1, when: [{ field: "mode", compare: "equals", value: "idle" }], sequence: [] }] }), /invalid/);
  assert.throws(() => parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{ id: "bad-number", safety: "normal", priority: 1, weight: 1, when: [{ field: "prana.current", compare: "gte", value: Infinity }], sequence: [] }] }), /invalid/);
  assert.equal(planLivePolicy(policy, observation()).ruleId, "high");
  assert.equal(planLivePolicy(policy, observation([])).ruleId, "unknown-zpg");
});
test("runner awaits a command and stops on ambiguity without retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-live-policy-")), db = new AgentDatabase(directory);
  let observed = 0, executed = 0;
  const adapter: LiveAdapter = {
    async observe() { observed++; return observation(); },
    async waitBetweenActions() { throw new Error("must not wait after ambiguity"); },
    async execute(_command, options) { executed++; assert.equal(await options.beforeClick({ command: { id: "hero.encourage", maxPrana: 25, maxCharges: 0 }, observation: observation() }), true); const outcome: ClickOutcome = { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "fixture timeout" }; await options.onOutcome?.(outcome); return outcome; },
  };
  try {
    const result = await runSequence(adapter, db, { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 }, policy, { ruleId: "high", commands: ["hero.encourage", "hero.encourage"], reason: "fixture" }, false, { canIssueClick: () => true });
    assert.equal(result.state, "AMBIGUOUS"); assert.equal(executed, 1); assert.equal(observed, 1); assert.equal(db.hasUnresolvedOperation("hero.encourage"), true);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("runner binds a click to final identity, idle mode, policy and lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-live-final-gate-"));
  const db = new AgentDatabase(directory);
  const sequence = { ruleId: "high", commands: ["hero.encourage"], reason: "fixture" };
  const budget = { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 };
  const variants: Array<{ name: string; final: ObservationV1; guard: boolean }> = [
    { name: "event changed", final: { ...observation(), eventId: "event-2" }, guard: true },
    { name: "mode changed", final: { ...observation(), mode: "arena" }, guard: true },
    { name: "lease lost", final: observation(), guard: false },
  ];

  try {
    for (const variant of variants) {
      const adapter: LiveAdapter = {
        async observe() { return observation(); },
        async waitBetweenActions() { throw new Error("a rejected gate must not wait"); },
        async execute(_command, options) {
          const granted = await options.beforeClick({
            command: { id: "hero.encourage", maxPrana: 25, maxCharges: 0 },
            observation: variant.final,
          });
          return {
            state: granted ? "CONFIRMED" : "SKIPPED",
            clicked: granted,
            confirmed: granted,
            ambiguous: false,
            reason: variant.name,
          };
        },
      };
      const result = await runSequence(adapter, db, budget, policy, sequence, false, {
        canIssueClick: () => variant.guard,
      });
      assert.equal(result.state, "SKIPPED", variant.name);
    }
    assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count, 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same command and event stays idempotent across observed time and rule rename", async () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-live-idempotency-"));
  const db = new AgentDatabase(directory);
  const budget = { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 };
  const renamed = parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [
    { id: "renamed", safety: "normal", priority: 10, weight: 1, when: [{ field: "mode", compare: "equals", value: "idle" }], sequence: ["hero.encourage"] },
  ] });
  let executeCount = 0;
  const adapter: LiveAdapter = {
    async observe() { return observation(); },
    async waitBetweenActions() {},
    async execute(_command, options) {
      executeCount++;
      const granted = await options.beforeClick({
        command: { id: "hero.encourage", maxPrana: 25, maxCharges: 0 },
        observation: { ...observation(), observedAt: `2026-09-20T10:00:0${executeCount}.000Z` },
      });
      const outcome: ClickOutcome = granted
        ? { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "fixture confirmed" }
        : { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "duplicate intent" };
      await options.onOutcome?.(outcome);
      return outcome;
    },
  };

  try {
    const first = await runSequence(adapter, db, budget, policy, { ruleId: "high", commands: ["hero.encourage"], reason: "fixture" }, false, { canIssueClick: () => true });
    assert.equal(first.state, "CONFIRMED");
    const second = await runSequence(adapter, db, budget, renamed, { ruleId: "renamed", commands: ["hero.encourage"], reason: "fixture" }, false, { canIssueClick: () => true });
    assert.equal(second.state, "SKIPPED");
    assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count, 1);
    assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM decisions").get() as { count: number }).count, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("strict policy rejects a repeated command in one sequence", () => {
  assert.throws(() => parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [
    { id: "repeat", safety: "normal", priority: 1, weight: 1, when: [{ field: "mode", compare: "equals", value: "idle" }], sequence: ["hero.encourage", "hero.encourage"] },
  ] }), /invalid/);
});
