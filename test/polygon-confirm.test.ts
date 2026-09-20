import assert from "node:assert/strict";
import test from "node:test";
import { GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION, GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION, GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION, GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION } from "../src/live-godville-adapter.js";

const prompt = "Отправить босса на полигон? В ближайшие 17 ч 22 мин в книгу можно гарантированно записать два слога-боссонима.";
const run = (expression: string, page: Record<string, unknown>): Record<string, unknown> => JSON.parse(new Function("window", `return ${expression}`)(page) as string) as Record<string, unknown>;

test("polygon confirmation shim accepts one reviewed prompt then self-restores", () => {
  let originalCalls = 0;
  const page: Record<string, unknown> = { confirm: () => { originalCalls++; return false; } };
  const original = page.confirm;
  assert.equal(run(GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION, page).ready, true);
  assert.equal((page.confirm as (message: string) => boolean)(prompt), true);
  assert.equal(page.confirm, original);
  assert.equal((page.confirm as (message: string) => boolean)(prompt), false);
  assert.equal(originalCalls, 1);
});

test("polygon confirmation shim delegates unknown and expired prompts to the original", () => {
  let originalCalls = 0, now = 1_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const page: Record<string, unknown> = { confirm: () => { originalCalls++; return false; } };
    const original = page.confirm;
    run(GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION, page);
    assert.equal((page.confirm as (message: string) => boolean)("Удалить всё?"), false);
    assert.notEqual(page.confirm, original, "unknown prompt does not consume the reviewed handler");
    now += 10_001;
    assert.equal((page.confirm as (message: string) => boolean)(prompt), false);
    assert.equal(page.confirm, original);
    assert.equal(originalCalls, 2);
    assert.equal(run(GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION, page).handled, false);
  } finally { Date.now = originalNow; }
});

test("arena shim accepts only the static first-stage duel prompt", () => {
  let originalCalls = 0;
  const page: Record<string, unknown> = { confirm: () => { originalCalls++; return false; } };
  const original = page.confirm;
  run(GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION, page);
  assert.equal((page.confirm as (message: string) => boolean)("Отправить героя на арену для дуэли с другим игроком?"), true);
  assert.equal(page.confirm, original);
  assert.equal((page.confirm as (message: string) => boolean)("Серверный запрос"), false);
  assert.equal(originalCalls, 1);
  assert.equal(run(GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION, page).ready, true);
});
