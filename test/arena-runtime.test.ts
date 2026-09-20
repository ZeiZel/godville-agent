import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClickOutcome } from "../src/browser.js";
import { AgentDatabase } from "../src/database.js";
import { LIVE_COMMANDS, type LiveAdapter } from "../src/live-godville-adapter.js";
import { parseLivePolicy } from "../src/live-policy.js";
import { planLivePolicyForRun, runSequence } from "../src/live-runner.js";
import { claimArenaTurn } from "../src/arena-turn-ledger.js";
import { OBSERVATION_VERSION, type BudgetPolicy, type ObservationV1 } from "../src/types.js";

const budget: BudgetPolicy = { reserveCharges: 100, maxChargesPerDay: 3, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 3 };
const policy = (command: keyof typeof LIVE_COMMANDS) => parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{ id: `run-${command}`, safety: "normal", priority: 1, weight: 1, when: [{ field: "mode", compare: "equals", value: "arena" }], sequence: [command] }] });
function arena(turn: number, rawShape = ["arena-ordinary-three-charge"]): ObservationV1 {
  return { version: OBSERVATION_VERSION, observedAt: `2026-09-20T10:00:${String(turn).padStart(2, "0")}.000Z`, sourceVersion: "fixture", freshness: "fresh", heroId: "arena-hero", eventId: `godville-arena-turn:/duels/log/arena:${turn}`, battleId: "/duels/log/arena", mode: "arena", capabilities: [], progressionKnown: true, health: "known_safe", healthPercent: 80, prana: { current: 100, capacity: 100 }, charges: 200, cooldowns: {}, rawShape } as ObservationV1;
}
function adapterFor(observation: ObservationV1, result: ClickOutcome = { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "fixture receipt" }) {
  let physical = 0;
  const adapter: LiveAdapter = { async observe() { return observation; }, async waitBetweenActions() {}, async execute(commandId, options) { const granted = await options.beforeClick({ command: LIVE_COMMANDS[commandId], observation }); if (granted) physical++; const outcome = granted ? result : { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: options.denialReason?.() ?? "gate denied" } as const; await options.onOutcome?.(outcome); return outcome; } };
  return { adapter, physical: () => physical };
}
async function run(db: AgentDatabase, command: keyof typeof LIVE_COMMANDS, observation: ObservationV1) {
  const fixture = adapterFor(observation);
  const result = await runSequence(fixture.adapter, db, budget, policy(command), { ruleId: `run-${command}`, commands: [command], reason: "fixture" }, false, { canIssueClick: () => true });
  return { result, physical: fixture.physical() };
}

test("ordinary arena allows one influence and one voice, rejects same-group repeats, then allows the next turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "godville-arena-runtime-")), db = new AgentDatabase(dir);
  try {
    assert.equal((await run(db, "hero.punish", arena(1))).result.state, "CONFIRMED");
    const repeat = await run(db, "hero.encourage", arena(1));
    assert.equal(repeat.result.state, "SKIPPED"); assert.equal(repeat.physical, 0);
    assert.equal((await run(db, "arena.voice.heal", arena(1))).result.state, "CONFIRMED");
    const voiceRepeat = await run(db, "arena.voice.attack", arena(1));
    assert.equal(voiceRepeat.result.state, "SKIPPED"); assert.equal(voiceRepeat.physical, 0);
    assert.equal((await run(db, "hero.encourage", arena(2))).result.state, "CONFIRMED");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unknown or frozen arena observations fail closed before physical click", async () => {
  const dir = mkdtempSync(join(tmpdir(), "godville-arena-runtime-")), db = new AgentDatabase(dir);
  try {
    for (const observation of [arena(1, []), { ...arena(1), mode: "unknown" as const }, { ...arena(1), rawShape: ["arena-ordinary-three-charge", "arena-frozen"] }, { ...arena(1), rawShape: ["arena-ordinary-three-charge", "arena-terminal"] }]) {
      const fixture = adapterFor(observation);
      const result = await runSequence(fixture.adapter, db, budget, policy("hero.punish"), { ruleId: "run-hero.punish", commands: ["hero.punish"], reason: "fixture" }, false, { canIssueClick: () => true });
      assert.equal(result.state, "SKIPPED"); assert.equal(fixture.physical(), 0);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("planner chooses voice when influence readiness is absent or already claimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "godville-arena-planner-")), db = new AgentDatabase(dir);
  try {
    const policy = parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [
      { id: "influence", safety: "normal", priority: 20, weight: 1, when: [{ field: "mode", compare: "equals", value: "arena" }, { field: "health.percent", compare: "lte", value: 35 }, { field: "readiness.arena.influence", compare: "equals", value: true }], sequence: ["hero.encourage"] },
      { id: "voice", safety: "normal", priority: 10, weight: 1, when: [{ field: "mode", compare: "equals", value: "arena" }, { field: "health.percent", compare: "lte", value: 35 }, { field: "readiness.arena.voice", compare: "equals", value: true }], sequence: ["arena.voice.heal"] },
    ] });
    const observation = { ...arena(1, ["arena-ordinary-three-charge", "arena-voice-ready"]), healthPercent: 20 };
    assert.deepEqual(planLivePolicyForRun(policy, observation, db).commands, ["arena.voice.heal"]);
    const claimed = { ...observation, rawShape: [...observation.rawShape, "arena-influence-ready"] };
    assert.equal(claimArenaTurn(db, "arena-hero", claimed.battleId, 1, "influence", "prior-influence"), true);
    assert.deepEqual(planLivePolicyForRun(policy, claimed, db).commands, ["arena.voice.heal"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("field and dungeon encourage remain available under their reviewed modes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "godville-arena-runtime-")), db = new AgentDatabase(dir);
  try {
    for (const mode of ["idle", "dungeon"] as const) {
      const observation = { ...arena(1), mode, rawShape: [], eventId: `${mode}-event` } as ObservationV1;
      const fixture = adapterFor(observation);
      const result = await runSequence(fixture.adapter, db, budget, parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{ id: mode, safety: "normal", priority: 1, weight: 1, when: [{ field: "mode", compare: "equals", value: mode }], sequence: ["hero.encourage"] }] }), { ruleId: mode, commands: ["hero.encourage"], reason: "fixture" }, false, { canIssueClick: () => true });
      assert.equal(result.state, "CONFIRMED"); assert.equal(fixture.physical(), 1);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
