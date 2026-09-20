import assert from "node:assert/strict";
import test from "node:test";
import { isZpgEntryWindow, isZpgEntryWindowAtGate } from "../src/arena-window.js";

const at = (value: string): Date => new Date(value);

test("default ZPG window is bounded to offsets 05 through 160 of an hour", () => {
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:04Z")), false);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:05Z")), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:45Z")), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:01:00Z")), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:02:40Z")), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:02:41Z")), false);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:03:00Z")), false);
});

test("custom bounds remain inside the hard official safety ceiling", () => {
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:10Z"), { minOffsetSeconds: 10, maxOffsetSeconds: 20 }), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:09Z"), { minOffsetSeconds: 10, maxOffsetSeconds: 20 }), false);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:01:15Z"), { minOffsetSeconds: 10, maxOffsetSeconds: 20 }), false);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:10Z"), { minOffsetSeconds: -1, maxOffsetSeconds: 20 }), false);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:10Z"), { minOffsetSeconds: 20, maxOffsetSeconds: 10 }), false);
  assert.equal(isZpgEntryWindow(at("invalid")), false);
});

test("whole-hour UTC and Moscow offset representations have the same window result", () => {
  assert.equal(isZpgEntryWindow(at("2026-09-20T09:00:05Z")), true);
  assert.equal(isZpgEntryWindow(at("2026-09-20T12:00:05+03:00")), true);
});

test("physical gate requires same hour, live deadline, and the bounded window", () => {
  assert.equal(isZpgEntryWindowAtGate(at("2026-09-20T12:00:30Z"), at("2026-09-20T12:00:45Z")), true);
  assert.equal(isZpgEntryWindowAtGate(at("2026-09-20T12:00:46Z"), at("2026-09-20T12:02:40Z")), true);
  assert.equal(isZpgEntryWindowAtGate(at("2026-09-20T12:00:30Z"), at("2026-09-20T13:00:45Z")), false);
  assert.equal(isZpgEntryWindowAtGate(at("2026-09-20T12:00:46Z"), at("2026-09-20T12:00:45Z")), false);
});
