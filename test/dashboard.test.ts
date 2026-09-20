import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentDatabase } from "../src/database.js";
import { createDashboardServer, readDashboardStatus } from "../src/dashboard.js";
import { DASHBOARD_HTML } from "../src/dashboard-page.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "godville-dashboard-"));
  const now = new Date("2026-09-20T12:00:00.000Z");
  const db = new AgentDatabase(dir);
  db.saveObservation({ version: "observation/v1", observedAt: new Date(now.getTime() - 30_000).toISOString(), sourceVersion: "test", freshness: "fresh", heroId: "fixture", mode: "idle", capabilities: [], progressionKnown: false, prana: { current: 70, capacity: 100 }, charges: 334, health: "known_risk", healthPercent: 32, cooldowns: {}, rawShape: [] }, "test");
  const decision = { id: randomUUID(), kind: "Recommend" as const, reason: "low health", action: "hero.encourage", evidence: ["health.percent"] };
  const decisionId = db.saveDecision(decision, undefined, "test", "test");
  const operation = db.createOperation("fixture-intent", decisionId, "hero.encourage", 1, {}, {});
  db.transitionOperation(operation.id, "PLANNED", "CONFIRMED", "clicked");
  db.close();
  const logs = join(dir, "automation", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "agent.stdout.log"), `${"x".repeat(140_000)}\n${JSON.stringify({ event: "live_run", initial: { observedAt: now.toISOString(), mode: "idle" }, sequence: { commands: [], ruleId: "observe" }, result: { state: "SKIPPED", completed: [], reason: "no executable rule matched" } })}\n`);
  writeFileSync(join(logs, "agent.stderr.log"), `${JSON.stringify({ event: "warning", message: "/Users/private/secret" })}\n`);
  return { dir, now };
}

test("dashboard status is bounded, projects audit rows, and derives freshness", () => {
  const { dir, now } = fixture();
  const status = readDashboardStatus({ dataDir: dir, now: () => now });
  expect(status.freshness).toBe("fresh");
  expect(status.identity.heroId).toBe("fixture");
  expect(status.resources.charges).toBe(334);
  expect(status.counts.confirmed).toBe(1);
  expect(status.operations[0]?.action).toBe("hero.encourage");
  expect(status.logs.stdout.length).toBeLessThanOrEqual(40);
  expect(status.logCycles[0]).toMatchObject({ event: "live_run", at: now.toISOString(), state: "SKIPPED", reason: "no executable rule matched" });
  expect(status.logCycles[0]?.action).toBeUndefined();
  expect(status.logs.stderr.join(" ")).not.toContain("/Users/private");
});

test("dashboard names live gameplay modes, actions, and dungeon reasons in Russian", () => {
  for (const label of [
    "Обычная жизнь героя", "Ожидание группы", "Полигон", "Возраст heartbeat", "Нет подходящего действия по текущим правилам", "Восстановление праны", "Запуск ZPG-арены",
    "Вход в подземелье", "Автоматический ход в подземелье", "Запуск полигона", "Отправка в плавание",
    "К ближайшему подтверждённому сокровищу найден безопасный путь.",
  ]) expect(DASHBOARD_HTML).toContain(label);
});

test("dashboard reports stale and tolerates malformed or absent files", () => {
  const dir = mkdtempSync(join(tmpdir(), "godville-dashboard-empty-"));
  const status = readDashboardStatus({ dataDir: dir, now: () => new Date("2026-09-20T12:00:00.000Z") });
  expect(status.freshness).toBe("unknown");
  expect(status.cycles).toEqual([]);
  const db = new AgentDatabase(dir);
  db.saveObservation({ version: "observation/v1", observedAt: "2026-09-20T11:56:00.000Z", sourceVersion: "test", freshness: "fresh", mode: "idle", capabilities: [], progressionKnown: false, health: "unknown", cooldowns: {}, rawShape: [] }, "test");
  db.close();
  expect(readDashboardStatus({ dataDir: dir, now: () => new Date("2026-09-20T12:00:00.000Z") }).freshness).toBe("stale");
  const badDir = mkdtempSync(join(tmpdir(), "godville-dashboard-bad-"));
  writeFileSync(join(badDir, "godville.sqlite"), "not sqlite");
  expect(readDashboardStatus({ dataDir: badDir, now: () => new Date() }).freshness).toBe("unknown");
});

test("dashboard serves read-only routes and rejects hostile hosts", async () => {
  const { dir } = fixture();
  const port = 43210;
  const server = createDashboardServer({ dataDir: dir, port, html: "<main>dashboard</main>" });
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json()).resources.charges).toBe(334);
    expect((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { host: `evil.test:${port}` } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/status`, { method: "POST" })).status).toBe(405);
  } finally { server.stop(true); }
});
