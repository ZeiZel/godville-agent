import assert from "node:assert/strict";
import test from "node:test";
import { CommandBuilder, CommandRegistryBuilder } from "../src/commands/builder.js";
import { UsageError, type CommandContext } from "../src/commands/types.js";
import { runCli } from "../src/cli-app.js";
import { loadConfig } from "../src/config.js";
import type { AgentDatabase } from "../src/database.js";

function context(onClose: () => void): CommandContext {
  return { db: { close: onClose } as unknown as AgentDatabase, config: { dataDir: "/tmp", mode: "advisor", budget: { reserveCharges: 100, maxChargesPerDay: 2, maxChargesPerRolling7d: 10, maxChargesPerExpedition: 1 }, zpg: { enabled: false, confirmation: false, minOffsetSeconds: 10, maxOffsetSeconds: 60 }, browser: { enabled: false, headless: true, allowRemoteUrl: false } }, env: {}, print: () => undefined };
}

test("CLI dispatches from a Map registry and always closes the command context", async () => {
  const calls: string[] = [], registry = new Map();
  registry.set("hello", new CommandBuilder().named("hello").usage("hello VALUE").handle(async (_context, args) => { calls.push(args.join(",")); }).build());
  let closes = 0;
  await runCli(["hello", "world"], {}, registry, () => context(() => { closes++; }));
  assert.deepEqual(calls, ["world"]); assert.equal(closes, 1);
  await assert.rejects(runCli(["missing"], {}, registry, () => context(() => { closes++; })), UsageError);
  assert.equal(closes, 2);
});

test("registry builder rejects duplicate command names", () => {
  const command = new CommandBuilder().named("same").usage("same").handle(async () => undefined).build();
  const builder = new CommandRegistryBuilder().add(command);
  assert.throws(() => builder.add(command), /duplicate command/);
});

test("launch environment has explicit browser controls and keeps browser mode gated", () => {
  const config = loadConfig({ GODVILLE_MODE: "browser", GODVILLE_BROWSER_ENABLED: "true", GODVILLE_BROWSER_STATE_DIR: "./fixture-state", GODVILLE_BROWSER_HEADLESS: "false", GODVILLE_BROWSER_ALLOW_REMOTE: "true" });
  assert.equal(config.browser.enabled, true);
  assert.equal(config.browser.headless, false);
  assert.equal(config.browser.allowRemoteUrl, true);
  assert.match(config.browser.stateDir ?? "", /fixture-state$/);
  assert.throws(() => loadConfig({ GODVILLE_MODE: "browser" }), /requires GODVILLE_BROWSER_ENABLED/);
});
