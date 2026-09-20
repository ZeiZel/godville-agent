import { readFileSync } from "node:fs";
import { normalizeApiPayload } from "../api.js";
import { KNOWLEDGE_CATALOG_VERSION } from "../knowledge.js";
import { decide, RULE_VERSION } from "../policy.js";
import { UsageError, type Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

export const importSnapshotCommand: Command = new CommandBuilder()
  .named("import-snapshot")
  .usage("import-snapshot FILE")
  .handle(async ({ db, env, print }, args): Promise<void> => {
    const file = args[0]; if (!file || args.length !== 1) throw new UsageError("import-snapshot FILE");
    const observation = normalizeApiPayload(JSON.parse(readFileSync(file, "utf8")), env.GODVILLE_GOD_NAME, false);
    const id = db.saveObservation(observation, "manual-snapshot");
    const decision = decide(observation, db.latestPriorities());
    db.saveDecision(decision, id, KNOWLEDGE_CATALOG_VERSION, RULE_VERSION);
    print({ observationId: id, decision });
  })
  .build();
