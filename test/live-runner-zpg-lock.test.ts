import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../src/database.js";
import { LIVE_COMMANDS, type LiveAdapter } from "../src/live-godville-adapter.js";
import { parseLivePolicy } from "../src/live-policy.js";
import { runSequence } from "../src/live-runner.js";
import { OBSERVATION_VERSION, type BudgetPolicy, type ObservationV1 } from "../src/types.js";

const budget: BudgetPolicy = { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 };
const observation: ObservationV1 = {
  version: OBSERVATION_VERSION,
  observedAt: "2026-09-20T10:00:00.000Z",
  sourceVersion: "fixture",
  freshness: "fresh",
  heroId: "synthetic-hero",
  eventId: "field-event-1",
  mode: "idle",
  capabilities: [],
  progressionKnown: true,
  health: "known_safe",
  healthPercent: 100,
  prana: { current: 50, capacity: 100 },
  charges: 200,
  cooldowns: {},
  rawShape: [],
};

test("persistent ZPG lock suppresses a non-ZPG live click", async () => {
  const directory = mkdtempSync(join(tmpdir(), "godville-live-zpg-lock-"));
  const db = new AgentDatabase(directory);
  let executeCalls = 0;
  let beforeClickCalls = 0;
  const adapter: LiveAdapter = {
    async observe() { return observation; },
    async waitBetweenActions() {},
    async execute(commandId, options) {
      executeCalls++;
      const granted = await options.beforeClick({ command: LIVE_COMMANDS[commandId], observation });
      beforeClickCalls++;
      const result = granted
        ? { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "unexpected fixture click" } as const
        : { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: options.denialReason?.() ?? "fixture gate rejected" } as const;
      await options.onOutcome?.(result);
      return result;
    },
  };
  const policy = parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{
    id: "encourage-while-idle", safety: "normal", priority: 1, weight: 1,
    when: [{ field: "mode", compare: "equals", value: "idle" }], sequence: ["hero.encourage"],
  }] });

  try {
    db.confirmCooldown("zpg-active", "zpg-operation", new Date(Date.now() + 60_000));
    const result = await runSequence(adapter, db, budget, policy, {
      ruleId: "encourage-while-idle", commands: ["hero.encourage"], reason: "fixture",
    }, false, { canIssueClick: () => true });
    assert.equal(result.state, "SKIPPED");
    assert.match(result.reason, /ZPG intervention lock/);
    assert.equal(executeCalls, 1);
    assert.equal(beforeClickCalls, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
