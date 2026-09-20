import { randomUUID } from "node:crypto";
import { OfficialApiClient } from "../api.js";
import { readTokenFromFile } from "../config.js";
import { KNOWLEDGE_CATALOG_VERSION } from "../knowledge.js";
import { decide, RULE_VERSION, zpgDecision } from "../policy.js";
import type { CommandContext } from "./types.js";
import { UsageError, type Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

async function oneCycle({ db, config, print }: CommandContext): Promise<void> {
  if (!config.api) { print({ event: "idle", reason: "No official API configuration; dry-run remains offline." }); return; }
  let observation;
  try {
    observation = await new OfficialApiClient(config.api.godName, readTokenFromFile(config.api.tokenFile)).observe();
  } catch (error) {
    print({ event: "api_error", message: error instanceof Error ? error.message : "unknown API error" });
    return;
  }
  const observationId = db.saveObservation(observation, "official-api");
  const decision = decide(observation, db.latestPriorities());
  db.saveDecision(decision, observationId, KNOWLEDGE_CATALOG_VERSION, RULE_VERSION);
  const now = new Date();
  const zpg = zpgDecision(observation, config, now, db.isCooldownActive("zpg", now));
  db.saveDecision(zpg, observationId, KNOWLEDGE_CATALOG_VERSION, `${RULE_VERSION}/zpg`);
  print({ event: "decision", decision, zpg });
}

async function waitForNextCycle(milliseconds: number, isStopped: () => boolean): Promise<void> {
  let remaining = milliseconds;
  while (!isStopped() && remaining > 0) { const chunk = Math.min(remaining, 1_000); await new Promise<void>((resolve) => setTimeout(resolve, chunk)); remaining -= chunk; }
}

export const daemonCommand: Command = new CommandBuilder().named("daemon").usage("daemon [--once]").handle(async (context, args): Promise<void> => {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--once")) throw new UsageError("daemon [--once]");
    const once = args[0] === "--once", owner = randomUUID(), ttl = 10 * 60 * 1000;
    const { db, config } = context;
    if (!db.acquireLease("daemon", owner, ttl)) throw new Error("another daemon holds the writer lease");
    const token = db.leaseToken("daemon", owner); if (token === undefined) throw new Error("writer lease was not readable");
    db.recoverUncertainOperations("daemon", owner, token);
    let stopped = false; const stop = () => { stopped = true; };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      do {
        if (!db.renewLease("daemon", owner, token, ttl)) throw new Error("writer lease was lost");
        await oneCycle(context);
        if (!once && !stopped) await waitForNextCycle((config.api?.intervalSeconds ?? 75) * 1000, () => stopped);
      } while (!once && !stopped);
    } finally { db.releaseLease("daemon", owner, token); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }).build();
