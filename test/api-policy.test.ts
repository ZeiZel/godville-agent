import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiPayload } from "../src/api.js";
import { decide, zpgDecision } from "../src/policy.js";
import { loadConfig } from "../src/config.js";
import type { ObservationV1 } from "../src/types.js";

const privateIdle = (extra: Record<string, unknown> = {}): ObservationV1 => normalizeApiPayload({ godname: "Demo", name: "Hero", health: 100, max_health: 100, godpower: 90, arena_fight: false, temple_completed_at: "2020-01-01", ark_completed_at: "2021-01-01", ark_m: 1000, ark_f: 1000, boss_name: "Synthetic Boss", words: 1000, savings: "9183 тысячи", ...extra }, "Demo", true, "2026-09-20T00:00:00.000Z");

test("API uses documented fields, never mistakes partial savings for pension, and fails private auth closed", () => {
  const observation = privateIdle();
  assert.equal(observation.freshness, "fresh");
  assert.equal(observation.mode, "idle");
  assert.ok(observation.capabilities.includes("personal_boss"));
  assert.ok(!observation.capabilities.includes("pension"));
  assert.equal(normalizeApiPayload({ godname: "Demo", name: "Hero" }, "Demo", true).freshness, "auth_degraded");
  assert.equal(normalizeApiPayload({ godname: "Other", health: 1, godpower: 1 }, "Demo", true).freshness, "auth_degraded");
});

test("unknown state observes instead of guessing and stage DAG honors personal-boss book gate", () => {
  assert.equal(decide({ ...privateIdle(), mode: "unknown" }).kind, "Observe");
  const next = decide({ ...privateIdle(), capabilities: ["temple", "ark", "pairs", "laboratory", "personal_boss"], progressionKnown: true });
  assert.equal(next.action, "progress:book");
});

test("ZPG schedules once inside safe window and has no ordinary-arena fallback", () => {
  const config = loadConfig({ GODVILLE_ZPG_ENABLED: "true", GODVILLE_ZPG_CONFIRMATION: "true", GODVILLE_ZPG_MIN_OFFSET_SECONDS: "10", GODVILLE_ZPG_MAX_OFFSET_SECONDS: "10" });
  const observation = privateIdle();
  const early = zpgDecision(observation, config, new Date("2026-09-20T10:00:00.000Z"), false, () => 0);
  assert.equal(early.kind, "ScheduleZpg");
  assert.equal(early.scheduleAt, "2026-09-20T10:00:10.000Z");
  assert.equal(zpgDecision(observation, config, new Date("2026-09-20T10:02:51.000Z")).kind, "NoOp");
  assert.equal(zpgDecision(observation, config, new Date("2026-09-20T10:00:00.000Z"), true).kind, "NoOp");
});
