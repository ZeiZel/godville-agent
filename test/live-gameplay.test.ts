import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveGodvilleAdapter,
  GODVILLE_ARENA_TARGET_EXPRESSION,
  GODVILLE_DUNGEON_STATE_EXPRESSION,
  GODVILLE_FIELD_STATE_EXPRESSION,
  GODVILLE_IDLE_READINESS_EXPRESSION,
  GODVILLE_POLYGON_STATE_EXPRESSION,
  GODVILLE_IDLE_READINESS_EXPRESSION,
  GODVILLE_OBSERVE_EXPRESSION,
  type OrcaLiveExecutor,
} from "../src/live-godville-adapter.js";
import { parseLivePolicy, planLivePolicy } from "../src/live-policy.js";

const pageId = "00000000-0000-4000-8000-000000000000";
const nested = (value: unknown): string => JSON.stringify({ ok: true, result: { result: JSON.stringify(value) } });

function clock() {
  let now = Date.UTC(2026, 0, 1);
  return { random: () => 0.5, now: () => new Date(now), wait: async (ms: number) => { now += ms; } };
}

function zpgClock(second = 5, minute = 0) {
  let now = Date.UTC(2026, 0, 1, 12, minute, second);
  return { random: () => 0.5, now: () => new Date(now), wait: async (ms: number) => { now += ms; } };
}

function zpgExecutor(options: { mode?: "idle" | "arena" | "queue"; target?: boolean } = {}) {
  const calls: string[][] = [];
  let clicked = false;
  const executor: OrcaLiveExecutor = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "mouse" && args[1] === "down") clicked = true;
    if (args[0] !== "eval") return { stdout: JSON.stringify({ ok: true }) };
    const expression = args[args.indexOf("--expression") + 1]!;
    if (expression === GODVILLE_OBSERVE_EXPRESSION) {
      const mode = clicked ? (options.mode ?? "arena") : (options.mode ?? "idle");
      return { stdout: nested({ origin: "https://godville.net", path: "/superhero", ready: true, health: [400, 500], pranaPercent: clicked ? 30 : 80, charges: 200, fieldMode: mode === "idle", dungeonMode: mode !== "idle", dungeonWaiting: mode === "queue", dungeonActive: false, dungeonCombat: false, dungeonTurn: null, battleId: null, dungeonAvailable: false, diaryFingerprint: clicked ? 2 : 1 }) };
    }
    if (expression === GODVILLE_ARENA_TARGET_EXPRESSION && options.target !== false) return { stdout: nested({ ready: true, x: 10, y: 20, width: 100, height: 30 }) };
    if (expression === GODVILLE_IDLE_READINESS_EXPRESSION) return { stdout: nested({ arena: options.target !== false, polygon: false }) };
    if (expression === GODVILLE_FIELD_STATE_EXPRESSION) return { stdout: nested({ idle: options.mode === undefined || options.mode === "idle" }) };
    if (expression === GODVILLE_IDLE_READINESS_EXPRESSION) return { stdout: nested({ arena: options.target !== false, polygon: false }) };
    if (expression.includes("getBoundingClientRect")) return { stdout: nested({ ready: true, x: 10, y: 20, width: 100, height: 30 }) };
    return { stdout: nested({ ready: true }) };
  };
  return { executor, calls };
}

type Scenario = { afterTurn?: number; afterPrana?: number; afterDiary?: number; mode?: "dungeon" | "idle" };

function gameplayExecutor(scenario: Scenario = {}) {
  let observations = 0;
  let clicked = false;
  const calls: string[][] = [];
  const executor: OrcaLiveExecutor = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "mouse" && args[1] === "down") clicked = true;
    if (args[0] !== "eval") return { stdout: JSON.stringify({ ok: true }) };
    const expression = args[args.indexOf("--expression") + 1]!;
    if (expression === GODVILLE_OBSERVE_EXPRESSION) {
      observations++;
      const after = clicked;
      const turn = after ? (scenario.afterTurn ?? 1) : 1;
      const prana = after ? (scenario.afterPrana ?? 75) : 80;
      const diary = after ? (scenario.afterDiary ?? 2) : 1;
      const mode = after ? (scenario.mode ?? "dungeon") : "dungeon";
      return { stdout: nested({ origin: "https://godville.net", path: "/superhero", ready: true, health: [400, 500], pranaPercent: prana, charges: 200, fieldMode: mode === "idle", dungeonMode: mode === "dungeon", dungeonWaiting: false, dungeonActive: mode === "dungeon", dungeonCombat: false, dungeonTurn: mode === "dungeon" ? turn : null, battleId: mode === "dungeon" ? "/duels/log/synthetic" : null, dungeonAvailable: false, diaryFingerprint: diary }) };
    }
    if (expression === GODVILLE_DUNGEON_STATE_EXPRESSION) {
      return { stdout: nested({ ready: true, turn: 1, battleId: "/duels/log/synthetic", position: { x: 0, y: 0 }, cells: [
        { x: 0, y: 0, text: "", title: "Команда героев", wall: false, unknown: false },
        { x: 1, y: 0, text: "", title: "Пока не открыто, Идите на восток", wall: false, unknown: true },
      ], legalMoves: [{ direction: "east", x: 1, y: 0 }] }) };
    }
    if (expression === GODVILLE_FIELD_STATE_EXPRESSION) return { stdout: nested({ idle: false }) };
    if (expression.includes("getBoundingClientRect")) return { stdout: nested({ ready: true, x: 10, y: 20, width: 100, height: 30 }) };
    return { stdout: nested({ ready: true }) };
  };
  return { executor, calls, observations: () => observations };
}

function polygonExecutor(afterPrana: number) {
  let clicked = false;
  const executor: OrcaLiveExecutor = async (_command, args) => {
    if (args[0] === "mouse" && args[1] === "down") clicked = true;
    if (args[0] !== "eval") return { stdout: JSON.stringify({ ok: true }) };
    const expression = args[args.indexOf("--expression") + 1]!;
    if (expression === GODVILLE_OBSERVE_EXPRESSION) return { stdout: nested({ origin: "https://godville.net", path: "/superhero", ready: true, health: null, pranaPercent: clicked ? afterPrana : 35, charges: 332, fieldMode: false, dungeonMode: false, dungeonWaiting: false, dungeonActive: false, dungeonCombat: false, dungeonTurn: null, polygonActive: true, polygonTurn: clicked ? 2 : 1, battleId: "/duels/log/polygon", dungeonAvailable: false, diaryFingerprint: 1 }) };
    if (expression === GODVILLE_POLYGON_STATE_EXPRESSION) return { stdout: nested({ ready: true, turn: 1, battleId: "/duels/log/polygon", moves: [{ direction: "north", kind: "ремкомплект" }] }) };
    if (expression.includes("getBoundingClientRect")) return { stdout: nested({ ready: true, x: 10, y: 20, width: 20, height: 20 }) };
    return { stdout: nested({ ready: true }) };
  };
  return executor;
}

test("dungeon movement confirms only a same-battle five-prana debit", async () => {
  const fixture = gameplayExecutor({ afterPrana: 75, afterTurn: 1 });
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("dungeon.move.auto", { beforeClick: async ({ command, observation }) => command.maxPrana === 5 && observation.mode === "dungeon" });
  assert.equal(result.state, "CONFIRMED");
  assert.equal(fixture.calls.filter((args) => args[0] === "mouse" && args[1] === "down").length, 1);
  assert.equal(fixture.calls.some((args) => args.some((part) => part.includes("Идите на восток"))), true);
});

test("a later dungeon turn without the five-prana debit is ambiguous", async () => {
  const fixture = gameplayExecutor({ afterPrana: 80, afterTurn: 2 });
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("dungeon.move.auto", { beforeClick: async () => true });
  assert.equal(result.state, "AMBIGUOUS");
  assert.equal(result.confirmed, false);
});

test("dungeon encourage confirms a same-battle bounded twenty-five-prana debit", async () => {
  const fixture = gameplayExecutor({ afterPrana: 55, afterTurn: 1 });
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("hero.encourage", { beforeClick: async ({ command, observation }) => command.maxPrana === 25 && observation.mode === "dungeon" });
  assert.equal(result.state, "CONFIRMED");
});

test("dungeon encourage confirms a debit when the active dungeon has no diary row change", async () => {
  const fixture = gameplayExecutor({ afterPrana: 55, afterTurn: 1, afterDiary: 1 });
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("hero.encourage", { beforeClick: async () => true });
  assert.equal(result.state, "CONFIRMED");
});

test("physical stop gate prevents dungeon pointer down/up", async () => {
  const fixture = gameplayExecutor();
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: clock(), fixtureMode: true });
  const result = await adapter.execute("dungeon.move.auto", { beforeClick: async () => true, beforePhysicalClick: () => false });
  assert.equal(result.state, "SKIPPED");
  assert.equal(fixture.calls.filter((args) => args[0] === "mouse" && (args[1] === "down" || args[1] === "up")).length, 0);
});

test("disabled ZPG never clicks even inside the official window", async () => {
  const fixture = zpgExecutor();
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", zpgEnabled: false, executor: fixture.executor, clock: zpgClock(20), fixtureMode: true });
  const result = await adapter.execute("arena.zpg.start", { beforeClick: async () => true });
  assert.equal(result.state, "SKIPPED");
  assert.equal(fixture.calls.some((args) => args[0] === "mouse"), false);
});

test("enabled visible ZPG control advertises readiness to the default live policy", async () => {
  const fixture = zpgExecutor();
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", zpgEnabled: true, executor: fixture.executor, clock: zpgClock(20), fixtureMode: true });
  const observation = await adapter.observe();
  const policy = parseLivePolicy({ schemaVersion: "live-policy/v1", rules: [{ id: "zpg", safety: "normal", priority: 10, weight: 1, when: [
    { field: "mode", compare: "equals", value: "idle" },
    { field: "readiness.zpg", compare: "equals", value: true },
  ], sequence: ["arena.zpg.start"] }] });
  assert.equal(observation.rawShape.includes("zpg-ready"), true);
  assert.deepEqual(planLivePolicy(policy, observation).commands, ["arena.zpg.start"]);
});

test("ZPG readiness in the previous minute exposes the reservation marker", async () => {
  const fixture = zpgExecutor();
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", zpgEnabled: true, executor: fixture.executor, clock: zpgClock(20, 59), fixtureMode: true });
  const observation = await adapter.observe();
  assert.equal(observation.rawShape.includes("zpg-ready"), false);
  assert.equal(observation.rawShape.includes("arena-window-reserved"), true);
});

test("ZPG crossing the official bounded deadline during jiggle is blocked before click", async () => {
  const fixture = zpgExecutor();
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", zpgEnabled: true, executor: fixture.executor, clock: zpgClock(159), jigglerConfig: { reactionDelayMs: [2_000, 2_000], betweenActionsMs: [0, 0], clickOffsetPx: 2, clickJigglePx: 1 }, fixtureMode: true });
  const result = await adapter.execute("arena.zpg.start", { beforeClick: async () => true });
  assert.equal(result.state, "SKIPPED");
  assert.equal(fixture.calls.filter((args) => args[0] === "mouse" && (args[1] === "down" || args[1] === "up")).length, 0);
});

test("encourage is blocked in an active arena or adventure queue", async () => {
  for (const mode of ["arena", "queue"] as const) {
    const fixture = zpgExecutor({ mode });
    const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor: fixture.executor, clock: zpgClock(20), fixtureMode: true });
    const result = await adapter.execute("hero.encourage", { beforeClick: async () => true });
    assert.equal(result.state, "SKIPPED", mode);
    assert.equal(fixture.calls.filter((args) => args[0] === "mouse" && args[1] === "down").length, 0, mode);
  }
});

test("active polygon remains a locked mode when hero health is absent", async () => {
  const executor: OrcaLiveExecutor = async (_command, args) => {
    if (args[0] !== "eval") return { stdout: JSON.stringify({ ok: true }) };
    const expression = args[args.indexOf("--expression") + 1]!;
    assert.equal(expression, GODVILLE_OBSERVE_EXPRESSION);
    return { stdout: nested({ origin: "https://godville.net", path: "/superhero", ready: true, health: null, pranaPercent: 5, charges: 332, fieldMode: false, dungeonMode: false, dungeonWaiting: false, dungeonActive: false, dungeonCombat: false, dungeonTurn: null, polygonActive: true, polygonTurn: 23, battleId: "/duels/log/synthetic", dungeonAvailable: false, diaryFingerprint: 1 }) };
  };
  const adapter = createLiveGodvilleAdapter({ pageId, heroId: "synthetic-hero", executor, clock: clock(), fixtureMode: true });
  const observation = await adapter.observe();
  assert.equal(observation.mode, "polygon");
  assert.equal(observation.health, "unknown");
  assert.equal(observation.rawShape.includes("polygon-active"), true);
});

test("polygon push confirms an immediate fifteen-prana debit even when no next safe move remains", async () => {
  const adapter = createLiveGodvilleAdapter({ pageId, executor: polygonExecutor(20), clock: clock(), fixtureMode: true });
  const result = await adapter.execute("polygon.move.safe", { beforeClick: async () => true });
  assert.equal(result.state, "CONFIRMED");
});

test("polygon turn advance without its reviewed debit remains ambiguous", async () => {
  const adapter = createLiveGodvilleAdapter({ pageId, executor: polygonExecutor(35), clock: clock(), fixtureMode: true });
  const result = await adapter.execute("polygon.move.safe", { beforeClick: async () => true });
  assert.equal(result.state, "AMBIGUOUS");
});
