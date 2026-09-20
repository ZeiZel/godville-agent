import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClickOutcome } from "../src/browser.js";
import { AgentDatabase } from "../src/database.js";
import { LIVE_COMMANDS, type LiveCommandId } from "../src/live-godville-adapter.js";
import { parseLivePolicy, planLivePolicy, type LivePolicy } from "../src/live-policy.js";
import { runSequence, type LiveAdapter } from "../src/live-runner.js";
import { OBSERVATION_VERSION, type BudgetPolicy, type ObservationV1 } from "../src/types.js";

const budget: BudgetPolicy = { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 };

function policyFor(command: LiveCommandId, mode: ObservationV1["mode"] = "idle"): LivePolicy {
  return parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{
    id: `run-${command.replaceAll(".", "-")}`,
    safety: "normal",
    priority: 1,
    weight: 1,
    when: [{ field: "mode", compare: "equals", value: mode }],
    sequence: [command],
  }] });
}

function observation(charges: number, mode: ObservationV1["mode"] = "idle", eventId = "event-1", prana = 30): ObservationV1 {
  return {
    version: OBSERVATION_VERSION, observedAt: "2026-09-20T10:00:00.000Z", sourceVersion: "fixture",
    freshness: "fresh", heroId: "fixture-hero", eventId, mode, capabilities: [], progressionKnown: true,
    health: "known_safe", healthPercent: 100, prana: { current: prana, capacity: 100 }, charges,
    cooldowns: {}, rawShape: [],
  };
}

function fixtureAdapter(initial: ObservationV1, final: ObservationV1, outcome: ClickOutcome = { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "fixture confirmed" }) {
  let executes = 0;
  const adapter: LiveAdapter = {
    async observe() { return initial; },
    async waitBetweenActions() {},
    async execute(commandId, options) {
      executes++;
      const command = LIVE_COMMANDS[commandId];
      const granted = await options.beforeClick({ command, observation: final });
      const result = granted ? outcome : { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fixture gate rejected" } as const;
      await options.onOutcome?.(result);
      return result;
    },
  };
  return { adapter, executes: () => executes };
}

async function runRestore(charges: number, options: { final?: ObservationV1; policy?: LivePolicy; budget?: BudgetPolicy; outcome?: ClickOutcome } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "godville-gameplay-safety-"));
  const db = new AgentDatabase(directory);
  db.importBalance(charges, "fixture balance");
  const initial = observation(charges);
  const fixture = fixtureAdapter(initial, options.final ?? initial, options.outcome);
  const result = await runSequence(fixture.adapter, db, options.budget ?? budget, options.policy ?? policyFor("hero.restore_prana"), { ruleId: "run-hero-restore_prana", commands: ["hero.restore_prana"], reason: "fixture" }, false, { canIssueClick: () => true });
  return { directory, db, result, executes: fixture.executes() };
}

test("restore requires 101 charges, preserving the 100 charge floor", async () => {
  const insufficient = await runRestore(100);
  try { assert.equal(insufficient.result.state, "SKIPPED"); assert.equal(insufficient.executes, 0); assert.equal(insufficient.db.availableCharges(), 100); }
  finally { insufficient.db.close(); rmSync(insufficient.directory, { recursive: true, force: true }); }

  const enough = await runRestore(101);
  try { assert.equal(enough.result.state, "CONFIRMED"); assert.equal(enough.executes, 1); assert.equal(enough.db.currentBalance(), 101); assert.equal(enough.db.availableCharges(), 100); }
  finally { enough.db.close(); rmSync(enough.directory, { recursive: true, force: true }); }
});

test("configured reserve above the default floor is honored", async () => {
  const policyBudget = { ...budget, reserveCharges: 150 };
  const below = await runRestore(101, { budget: policyBudget });
  try { assert.equal(below.result.state, "SKIPPED"); assert.equal(below.db.reservedCharges(), 0); }
  finally { below.db.close(); rmSync(below.directory, { recursive: true, force: true }); }
  const at = await runRestore(151, { budget: policyBudget });
  try { assert.equal(at.result.state, "CONFIRMED"); assert.equal(at.db.availableCharges(), 150); }
  finally { at.db.close(); rmSync(at.directory, { recursive: true, force: true }); }
});

test("daily and rolling weekly limits reject a restore reservation", async () => {
  for (const limitedBudget of [{ ...budget, maxChargesPerDay: 0 }, { ...budget, maxChargesPerRolling7d: 0 }]) {
    const attempt = await runRestore(101, { budget: limitedBudget });
    try { assert.equal(attempt.result.state, "SKIPPED"); assert.equal(attempt.executes, 1); assert.equal(attempt.db.reservedCharges(), 0); assert.equal(attempt.db.availableCharges(), 101); }
    finally { attempt.db.close(); rmSync(attempt.directory, { recursive: true, force: true }); }
  }
});

test("ambiguous restore keeps its reservation and blocks a retry after an event change", async () => {
  const ambiguous = await runRestore(101, { outcome: { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "fixture timeout" } });
  try {
    assert.equal(ambiguous.result.state, "AMBIGUOUS");
    assert.equal(ambiguous.db.reservedCharges(), 1);
    const retry = fixtureAdapter(observation(101, "idle", "event-2"), observation(101, "idle", "event-2"));
    const retried = await runSequence(retry.adapter, ambiguous.db, budget, policyFor("hero.restore_prana"), { ruleId: "run-hero-restore_prana", commands: ["hero.restore_prana"], reason: "retry" }, false, { canIssueClick: () => true });
    assert.equal(retried.state, "SKIPPED");
    assert.equal(ambiguous.db.reservedCharges(), 1);
  } finally { ambiguous.db.close(); rmSync(ambiguous.directory, { recursive: true, force: true }); }
});

test("confirmed restore resolves its reservation and reports the post debit balance", async () => {
  const attempt = await runRestore(101);
  try { assert.equal(attempt.result.state, "CONFIRMED"); assert.equal(attempt.db.reservedCharges(), 0); assert.equal(attempt.db.availableCharges(), 100); }
  finally { attempt.db.close(); rmSync(attempt.directory, { recursive: true, force: true }); }
});

test("restore and encourage are unavailable in ZPG and arena modes", async () => {
  for (const command of ["hero.restore_prana", "hero.encourage"] as const) {
    for (const mode of ["arena", "polygon"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "godville-gameplay-mode-"));
      const db = new AgentDatabase(directory); db.importBalance(101, "fixture balance");
      const current = observation(101, mode);
      const fixture = fixtureAdapter(current, current);
      try {
        assert.deepEqual(planLivePolicy(policyFor(command), current).commands, []);
        const result = await runSequence(fixture.adapter, db, budget, policyFor(command), { ruleId: `run-${command.replaceAll(".", "-")}`, commands: [command], reason: "fixture" }, false, { canIssueClick: () => true });
        assert.equal(result.state, "SKIPPED"); assert.equal(fixture.executes(), 0); assert.equal(db.reservedCharges(), 0);
      } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  }
});

test("final mode or identity changes receive no grant and create no ledger entry", async () => {
  for (const final of [observation(101, "dungeon"), observation(101, "idle", "event-2")]) {
    const attempt = await runRestore(101, { final });
    try { assert.equal(attempt.result.state, "SKIPPED"); assert.equal(attempt.db.reservedCharges(), 0); assert.equal(attempt.db.availableCharges(), 101); }
    finally { attempt.db.close(); rmSync(attempt.directory, { recursive: true, force: true }); }
  }
});
