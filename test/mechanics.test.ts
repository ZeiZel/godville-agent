import assert from "node:assert/strict";
import test from "node:test";
import { evaluateInventory, evaluatePolygon, evaluateSeaBattle, planDungeon, planSeaRoute, shortestKnownSafePath, type MapCell } from "../src/mechanics.js";

const cell = (x: number, y: number, state: MapCell["state"] = "safe"): MapCell => ({ point: { x, y }, state });

test("dungeon routes only through observed safe cells and chooses the higher-priority resource", () => {
  const cells = [cell(0, 0), cell(1, 0, "hazard"), cell(0, 1), cell(1, 1), cell(2, 1), cell(2, 0)];
  const route = planDungeon({ cells, start: { x: 0, y: 0 }, turn: 3, leader: "self", conflictingHints: false, goals: [
    { point: { x: 2, y: 0 }, resource: "gold", priority: 1 },
    { point: { x: 2, y: 1 }, resource: "logs", priority: 2 },
  ] });
  assert.deepEqual(route, { kind: "Route", target: { x: 2, y: 1 }, path: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }], reason: "Shortest known-safe route to priority resource logs." });
  assert.equal(shortestKnownSafePath([cell(0, 0), cell(1, 0, "unknown")], { x: 0, y: 0 }, { x: 1, y: 0 }), undefined);
  assert.equal(shortestKnownSafePath([cell(0, 0), cell(1, 0), cell(1, 0, "hazard")], { x: 0, y: 0 }, { x: 1, y: 0 }), undefined);
});

test("dungeon defers duplicate turns, another leader, and conflicting hints", () => {
  const base = { cells: [cell(0, 0)], start: { x: 0, y: 0 }, turn: 2, goals: [], conflictingHints: false };
  assert.equal(planDungeon({ ...base, previousTurn: 2, leader: "self" }).kind, "NoOp");
  assert.equal(planDungeon({ ...base, leader: "other" }).kind, "NoOp");
  assert.equal(planDungeon({ ...base, leader: "self", conflictingHints: true }).kind, "Observe");
});

test("sea returns home when loot cannot be safely exported and stops below food margin", () => {
  const cells = [cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1)];
  const route = planSeaRoute({ cells, start: { x: 2, y: 0 }, home: { x: 0, y: 0 }, foodRemaining: 3, foodMargin: 1, loot: { x: 0, y: 1 } });
  assert.equal(route.kind, "Route");
  assert.deepEqual(route.kind === "Route" && route.target, { x: 0, y: 0 });
  assert.equal(planSeaRoute({ cells, start: { x: 2, y: 0 }, home: { x: 0, y: 0 }, foodRemaining: 2, foodMargin: 1 }).kind, "NoOp");
});

test("polygon and inventory both fail closed, and sea battle never recommends a voice", () => {
  assert.equal(evaluatePolygon({ requiredBits: 2, pushLanding: "safe", requiredPrana: 10, supportedCommands: ["push"] }).kind, "Observe");
  assert.equal(evaluatePolygon({ visibleBits: 2, requiredBits: 2, pushLanding: "unknown", prana: { current: 20, capacity: 100 }, requiredPrana: 10, supportedCommands: ["push"] }).kind, "Observe");
  assert.equal(evaluatePolygon({ visibleBits: 2, requiredBits: 2, pushLanding: "safe", prana: { current: 20, capacity: 100 }, requiredPrana: 10, supportedCommands: ["push"] }).kind, "Recommend");
  assert.equal(evaluateInventory({ item: { id: "mystery", known: false, protected: false, allowedActions: ["use"], requiredPreconditions: [] }, action: "use", satisfiedPreconditions: {} }).kind, "Observe");
  assert.equal(evaluateInventory({ item: { id: "relic", known: true, protected: true, allowedActions: ["use"], requiredPreconditions: [] }, action: "use", satisfiedPreconditions: {} }).kind, "NoOp");
  assert.equal(evaluateSeaBattle(true).kind, "NoOp");
});
