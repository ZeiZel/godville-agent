import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeApiPayload } from "../src/api.js";
import { AgentDatabase } from "../src/database.js";
import { getProgressionProfile } from "../src/progression-cache.js";

const payload = (extra: Record<string, unknown> = {}) => ({ godname: "Synthetic", name: "Api Hero", health: 10, max_health: 100, godpower: 70, arena_fight: false, temple_completed_at: "2020-01-01", ark_completed_at: "2021-01-01", ark_m: 1000, ark_f: 1000, boss_name: "Boss", words: 500, savings: "1000 тысячи", ...extra });
function database() { const dir = mkdtempSync(join(tmpdir(), "godville-progression-")); return { dir, db: new AgentDatabase(dir) }; }

test("public API enrichment preserves identity/mode/resources and records book stage metrics", () => {
  const observation = normalizeApiPayload(payload(), "Synthetic", false, "2026-09-20T00:00:00.000Z");
  assert.equal(observation.heroId, "Api Hero");
  assert.equal(observation.mode, "idle");
  assert.equal(observation.health, "known_risk");
  assert.equal(observation.progression?.stage, "book");
  assert.equal(observation.progression?.words, 500);
  assert.equal(observation.progressionKnown, true);
  assert.deepEqual(observation.progression?.capabilities, ["temple", "ark", "pairs", "personal_boss", "laboratory"]);
});

test("book and pension completion does not infer reliquary without observed souls/shop prerequisites", () => {
  const observation = normalizeApiPayload(payload({ words: 2_000, savings: "30000000" }), "Synthetic", false);
  assert.equal(observation.progression?.stage, "souls");
  assert.equal(observation.progression?.stage === "reliquary", false);
  assert.equal(observation.progression?.capabilities.includes("book"), true);
  assert.equal(observation.progression?.capabilities.includes("pension"), true);
});

test("progression cache refreshes once per TTL and never sends a token", async () => {
  const { dir, db } = database(); let calls = 0; let now = new Date("2026-09-20T00:00:00.000Z");
  const fetchImpl: typeof fetch = async (input, init) => { calls++; assert.equal(String(input), "https://godville.net/gods/api/Synthetic"); assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, undefined); return new Response(JSON.stringify(payload({ words: 2_000 })), { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    const first = await getProgressionProfile(db, "Synthetic", { fetchImpl, now: () => now });
    const second = await getProgressionProfile(db, "Synthetic", { fetchImpl, now: () => now });
    assert.equal(first?.stage, "pension"); assert.deepEqual(second, first); assert.equal(calls, 1);
    now = new Date(now.getTime() + 15 * 60_000 + 1);
    const refreshed = await getProgressionProfile(db, "Synthetic", { fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload({ words: 500 })), { status: 200 }); }, now: () => now });
    assert.equal(calls, 2); assert.equal(refreshed?.stage, "book");
    const fromUpdatedCache = await getProgressionProfile(db, "Synthetic", { fetchImpl, now: () => now }); assert.equal(fromUpdatedCache?.stage, "book"); assert.equal(calls, 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("incomplete or failed public API data does not poison cache", async () => {
  const { dir, db } = database();
  try {
    const result = await getProgressionProfile(db, "Synthetic", { fetchImpl: async () => new Response(JSON.stringify({ godname: "Synthetic" }), { status: 200 }) });
    assert.equal(result, undefined);
    const failed = await getProgressionProfile(db, "Synthetic", { fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(failed, undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cache is account-bound and failed refreshes are throttled", async () => {
  const { dir, db } = database(); let now = new Date("2026-09-20T00:00:00.000Z"); let calls = 0;
  const fetchImpl: typeof fetch = async (input) => { calls++; const godName = decodeURIComponent(new URL(String(input)).pathname.split("/").pop()!); return new Response(JSON.stringify(payload({ godname: godName, words: godName === "Other" ? 2_000 : 500 })), { status: 200 }); };
  try {
    await getProgressionProfile(db, "Synthetic", { fetchImpl, now: () => now });
    const other = await getProgressionProfile(db, "Other", { fetchImpl, now: () => now });
    assert.equal(other?.stage, "pension"); assert.equal(calls, 2);
    const failing: typeof fetch = async () => { calls++; throw new Error("offline"); };
    now = new Date(now.getTime() + 15 * 60_000 + 1);
    const stale = await getProgressionProfile(db, "Other", { fetchImpl: failing, now: () => now });
    assert.equal(stale?.staleAt, now.toISOString()); assert.equal(calls, 3);
    assert.equal((await getProgressionProfile(db, "Other", { fetchImpl: failing, now: () => now }))?.staleAt, now.toISOString());
    assert.equal(calls, 3);
    now = new Date(now.getTime() + 15 * 60_000);
    await getProgressionProfile(db, "Other", { fetchImpl: failing, now: () => now }); assert.equal(calls, 4);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
