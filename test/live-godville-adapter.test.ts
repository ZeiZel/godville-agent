import assert from "node:assert/strict";
import test from "node:test";
import { createLiveGodvilleAdapter, GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION, GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION, GODVILLE_DUNGEON_HOVER_EXPRESSION, GODVILLE_DUNGEON_TARGET_EXPRESSION, GODVILLE_ENCOURAGE_HOVER_EXPRESSION, GODVILLE_ENCOURAGE_TARGET_EXPRESSION, GODVILLE_FIELD_STATE_EXPRESSION, GODVILLE_OBSERVE_EXPRESSION, GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION, GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION, GODVILLE_RESTORE_PRANA_HOVER_EXPRESSION, GODVILLE_RESTORE_PRANA_TARGET_EXPRESSION, NORMAL_FIELD_HEADING_PATTERN, type OrcaLiveExecutor } from "../src/live-godville-adapter.js";
import { readFileSync } from "node:fs";

const pageId = "00000000-0000-4000-8000-000000000000";
const nested = (value: unknown): string => JSON.stringify({ ok: true, result: { result: JSON.stringify(value) } });
const snapshot = (overrides: Record<string, unknown> = {}): string => nested({ origin: "https://godville.net", path: "/superhero", ready: true, health: [400, 500], pranaPercent: 80, charges: 200, fieldMode: true, dungeonMode: false, dungeonWaiting: false, dungeonActive: false, dungeonCombat: false, dungeonTurn: null, dungeonAvailable: false, diaryFingerprint: 1, ...overrides });
function clock() { let now = Date.UTC(2026, 0, 1); return { random: () => 0.5, now: () => new Date(now), wait: async (ms: number) => { now += ms; } }; }

test("live observation parses only the fixed Godville DOM contract", async () => {
  const executor: OrcaLiveExecutor = async (_command, args) => { assert.equal(args[0], "eval"); return { stdout: args.includes(GODVILLE_FIELD_STATE_EXPRESSION) ? nested({ idle: true }) : snapshot() }; };
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor, clock: clock(), fixtureMode: true });
  const observation = await adapter.observe();
  assert.equal(observation.mode, "idle");
  assert.deepEqual(observation.prana, { current: 80, capacity: 100 });
  assert.equal(observation.charges, 200);
  assert.equal(observation.healthPercent, 80);
  assert.equal(observation.heroId, "synthetic-hero");
  assert.equal(observation.eventId, "godville-diary-fnv1a32:1");
  assert.equal(GODVILLE_OBSERVE_EXPRESSION.includes("cookie"), false);
});

test("synthetic live DOM headings each identify normal field mode independently", () => {
  const html = readFileSync(new URL("../fixtures/live-godville-dom.synthetic.html", import.meta.url), "utf8");
  const headings = [...html.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/gu)].map((match) => match[1]!);
  assert.equal(headings.every((heading) => NORMAL_FIELD_HEADING_PATTERN.test(heading)), true);
  assert.equal(GODVILLE_OBSERVE_EXPRESSION.includes(".some("), true);
});

test("every fixed DOM expression is syntactically valid without evaluating page APIs", () => {
  for (const expression of [GODVILLE_OBSERVE_EXPRESSION, GODVILLE_ENCOURAGE_TARGET_EXPRESSION, GODVILLE_ENCOURAGE_HOVER_EXPRESSION, GODVILLE_RESTORE_PRANA_TARGET_EXPRESSION, GODVILLE_RESTORE_PRANA_HOVER_EXPRESSION, GODVILLE_DUNGEON_TARGET_EXPRESSION, GODVILLE_DUNGEON_HOVER_EXPRESSION, GODVILLE_FIELD_STATE_EXPRESSION, GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION, GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION, GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION, GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION]) {
    assert.doesNotThrow(() => new Function(`return ${expression}`));
  }
});

test("execution requires final hit test and a journal gate before exactly one down/up", async () => {
  const calls: string[][] = [];
  const executor: OrcaLiveExecutor = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "mouse" && args[1] === "move") {
      const x = Number(args[args.indexOf("--x") + 1]), y = Number(args[args.indexOf("--y") + 1]);
      assert.equal(Number.isInteger(x), true);
      assert.equal(Number.isInteger(y), true);
    }
    if (args[0] === "eval") {
      const expression = args[args.indexOf("--expression") + 1]!;
      if (expression === GODVILLE_OBSERVE_EXPRESSION) return { stdout: snapshot() };
      if (expression === GODVILLE_FIELD_STATE_EXPRESSION) return { stdout: nested({ idle: true }) };
      if (expression === GODVILLE_ENCOURAGE_TARGET_EXPRESSION) return { stdout: nested({ ready: true, x: 10, y: 20, width: 100, height: 30 }) };
      if (expression === GODVILLE_ENCOURAGE_HOVER_EXPRESSION) return { stdout: nested({ ready: true }) };
    }
    return { stdout: JSON.stringify({ ok: true, result: {} }) };
  };
  const adapter = createLiveGodvilleAdapter({ pageId, executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("hero.encourage", { beforeClick: async ({ command, observation }) => command.maxPrana === 25 && observation.mode === "idle" });
  assert.equal(result.state, "AMBIGUOUS");
  assert.equal(calls.filter((args) => args[0] === "mouse" && args[1] === "down").length, 1);
  assert.equal(calls.filter((args) => args[0] === "mouse" && args[1] === "up").length, 1);
});

test("unknown DOM and denied journal cannot click", async () => {
  const noDom: OrcaLiveExecutor = async () => ({ stdout: snapshot({ ready: false }) });
  const blocked = createLiveGodvilleAdapter({ pageId, executor: noDom, clock: clock(), fixtureMode: true });
  assert.equal((await blocked.execute("hero.encourage", { beforeClick: async () => true })).state, "SKIPPED");
  let mouse = false;
  const executor: OrcaLiveExecutor = async (_command, args) => {
    if (args[0] === "mouse") mouse = true;
    if (args[0] !== "eval") return { stdout: JSON.stringify({ ok: true }) };
    const expression = args[args.indexOf("--expression") + 1]!;
    if (expression === GODVILLE_OBSERVE_EXPRESSION) return { stdout: snapshot() };
    if (expression === GODVILLE_FIELD_STATE_EXPRESSION) return { stdout: nested({ idle: true }) };
    if (expression === GODVILLE_ENCOURAGE_TARGET_EXPRESSION) return { stdout: nested({ ready: true, x: 10, y: 20, width: 100, height: 30 }) };
    return { stdout: nested({ ready: true }) };
  };
  const adapter = createLiveGodvilleAdapter({ pageId, executor, clock: clock(), fixtureMode: true });
  assert.equal((await adapter.execute("hero.encourage", { beforeClick: async () => false })).state, "SKIPPED");
  assert.equal(mouse, true, "pointer move may precede the journal gate, but no down/up is permitted");
});
