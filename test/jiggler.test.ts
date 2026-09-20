import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_JIGGLER_CONFIG, Jiggler, JigglerCancelledError, JigglerDeadlineError, validateJigglerConfig, type JigglerClock } from "../src/jiggler.js";

function clock(values: number[] = [0.5, 0.5], now = 0): JigglerClock {
  let index = 0, milliseconds = now;
  return { random: () => values[index++]!, now: () => new Date(milliseconds), wait: async (delay) => { milliseconds += delay; } };
}

test("uses bounded human-scale production defaults and a triangular sample", async () => {
  assert.deepEqual(DEFAULT_JIGGLER_CONFIG.reactionDelayMs, [350, 1200]);
  assert.deepEqual(DEFAULT_JIGGLER_CONFIG.betweenActionsMs, [800, 2200]);
  const jiggler = new Jiggler(clock([0.25, 0.75]), { ...DEFAULT_JIGGLER_CONFIG, reactionDelayMs: [350, 450] });
  assert.equal(await jiggler.waitReaction(), 400);
  assert.throws(() => validateJigglerConfig({ ...DEFAULT_JIGGLER_CONFIG, reactionDelayMs: [99, 100] }), /reactionDelayMs/);
  assert.doesNotThrow(() => validateJigglerConfig({ ...DEFAULT_JIGGLER_CONFIG, reactionDelayMs: [1, 1], betweenActionsMs: [1, 1] }, "fixture"));
});
test("keeps randomized points inside the target and rejects unsafe geometry", () => {
  const jiggler = new Jiggler(clock([0, 0.999999, 0, 0.999999, 0, 0.999999, 0, 0.999999]));
  const point = jiggler.point({ x: 10, y: 20, width: 20, height: 20 });
  assert.ok(point); assert.ok(point.x >= 3 && point.x <= 17); assert.ok(point.y >= 3 && point.y <= 17);
  assert.equal(jiggler.point({ x: 0, y: 0, width: 6, height: 6 }), undefined);
});
test("fails closed on cancellation, a deadline that cannot contain delay, and invalid randomness", async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => new Jiggler(clock()).waitReaction({ signal: aborted.signal }), JigglerCancelledError);
  await assert.rejects(() => new Jiggler(clock(), { ...DEFAULT_JIGGLER_CONFIG, reactionDelayMs: [100, 100] }).waitReaction({ deadline: new Date(99) }), JigglerDeadlineError);
  await assert.rejects(() => new Jiggler(clock()).waitReaction({ deadline: new Date(Number.NaN) }), JigglerDeadlineError);
  assert.throws(() => new Jiggler(clock([Number.NaN, 0.5])).sample([100, 100]), /random source/);
});
test("AbortSignal interrupts an injected clock even if that clock ignores signals", async () => {
  const controller = new AbortController();
  const uncooperative: JigglerClock = { random: () => 0.5, now: () => new Date(0), wait: async () => new Promise<void>(() => undefined) };
  const pending = new Jiggler(uncooperative).waitReaction({ signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, JigglerCancelledError);
});
