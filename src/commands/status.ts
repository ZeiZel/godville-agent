import { KNOWLEDGE_CATALOG_VERSION } from "../knowledge.js";
import type { Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

export const statusCommand: Command = new CommandBuilder()
  .named("status")
  .usage("status")
  .handle(async ({ db, config, print }): Promise<void> => {
    print({ integrity: db.integrityCheck(), mode: config.mode, browserEnabled: config.browser.enabled, balance: db.currentBalance(), available: db.availableCharges(), knowledgeVersion: KNOWLEDGE_CATALOG_VERSION });
  })
  .build();
