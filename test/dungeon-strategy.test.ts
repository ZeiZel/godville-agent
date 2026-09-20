import assert from "node:assert/strict";
import test from "node:test";
import { planDungeonStrategy, type DungeonCell, type DungeonMap } from "../src/dungeon-strategy.js";

const cell = (x: number, y: number, extra: Partial<DungeonCell> = {}): DungeonCell => ({ x, y, text: "", title: "", wall: false, unknown: false, ...extra });
const map = (cells: DungeonCell[], legalMoves: DungeonMap["legalMoves"], extra: Partial<DungeonMap> = {}): DungeonMap => ({ cells, legalMoves, position: { x: 0, y: 0 }, turn: 1, battleId: "battle-1", otherGodDirected: false, ...extra });
const move = (direction: "north" | "south" | "east" | "west", x: number, y: number) => ({ direction, x, y });

test("selects a legal treasure route while respecting walls and map boundaries", () => {
  const result = planDungeonStrategy(map([
    cell(0, 0), cell(1, 0, { wall: true }), cell(0, 1), cell(1, 1), cell(2, 1, { title: "Сокровищница" }),
  ], [move("east", 1, 0), move("south", 0, 1)]));
  assert.deepEqual(result, { direction: "south", reason: "К ближайшей подтверждённой цели найден безопасный путь." });
});

test("yields when another god directed the turn and never emits an invalid position", () => {
  const result = planDungeonStrategy(map([cell(0, 0), cell(1, 0)], [move("east", 1, 0)], { otherGodDirected: true }));
  assert.equal(result.direction, undefined);
  assert.match(result.reason, /Другой бог/);
  const invalid = planDungeonStrategy(map([cell(0, 0)], [{ direction: "east", x: 9, y: 9 }]));
  assert.equal(invalid.direction, undefined);
});

test("avoids immediate reversal when another legal move exists", () => {
  const result = planDungeonStrategy(map([cell(0, 0), cell(-1, 0), cell(1, 0, { unknown: true })], [move("west", -1, 0), move("east", 1, 0)], { previousPosition: { x: -1, y: 0 } }));
  assert.equal(result.direction, "east");
});

test("treats the distance hint as text, while selecting an actual treasure title", () => {
  const result = planDungeonStrategy(map([cell(0, 0), cell(1, 0, { title: "Сокровище не дальше тринадцати шагов" })], [move("east", 1, 0)]));
  assert.equal(result.reason, "Безопасная граница исследования не найдена.");
  const actual = planDungeonStrategy(map([cell(0, 0), cell(1, 0, { title: "Сокровище" })], [move("east", 1, 0)]));
  assert.equal(actual.direction, "east");
});

test("routes a known corridor toward its nearest unknown frontier", () => {
  const result = planDungeonStrategy(map([
    cell(0, 0), cell(1, 0), cell(2, 0), cell(2, 1, { unknown: true }),
  ], [move("east", 1, 0)]));
  assert.deepEqual(result, { direction: "east", reason: "К ближайшей границе исследования найден безопасный путь." });
});

test("does not enter the dungeon exit before treasure collection, then permits it", () => {
  const cells = [cell(0, 0), cell(1, 0, { title: "Выход из подземелья" })];
  const blocked = planDungeonStrategy(map(cells, [move("east", 1, 0)]));
  assert.equal(blocked.direction, undefined);
  const collected = planDungeonStrategy(map(cells, [move("east", 1, 0)], { treasureCollected: true }));
  assert.equal(collected.direction, "east");
});

test("uses the sole reverse path when it is the only safe route to treasure", () => {
  const result = planDungeonStrategy(map([
    cell(0, 0), cell(-1, 0, { title: "Сокровищница, Идите на запад" }),
  ], [move("west", -1, 0)], { previousPosition: { x: -1, y: 0 } }));
  assert.deepEqual(result, { direction: "west", reason: "К ближайшей подтверждённой цели найден безопасный путь." });
});

test("never routes through a non-legal first step and orders legal moves north east south west", () => {
  const result = planDungeonStrategy(map([
    cell(0, 0), cell(0, -1), cell(1, 0, { title: "Сокровище" }),
  ], [move("east", 1, 0), move("north", 0, -1)]));
  assert.equal(result.direction, "east");

  const illegalGoal = planDungeonStrategy(map([
    cell(0, 0), cell(0, -1, { title: "Сокровище" }), cell(1, 0),
  ], [move("east", 1, 0)]));
  assert.equal(illegalGoal.direction, undefined);

  const blockedGoal = planDungeonStrategy(map([
    cell(0, 0), cell(0, -1, { title: "Сокровище" }), cell(1, 0), cell(2, 0, { title: "Сокровищница" }),
  ], [move("east", 1, 0)]));
  assert.equal(blockedGoal.direction, "east");
});

test("skips known boss and trap cells and explores only safe legal unknowns", () => {
  const result = planDungeonStrategy(map([cell(0, 0), cell(1, 0, { title: "Ловушка" }), cell(0, 1, { unknown: true })], [move("east", 1, 0), move("south", 0, 1)]));
  assert.equal(result.direction, "south");
});
