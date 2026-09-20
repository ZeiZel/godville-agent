import { KNOWLEDGE_CATALOG, KNOWLEDGE_CATALOG_VERSION } from "../knowledge.js";
import type { Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

export const knowledgeCommand: Command = new CommandBuilder()
  .named("knowledge")
  .usage("knowledge")
  .handle(async ({ print }): Promise<void> => {
    print({ version: KNOWLEDGE_CATALOG_VERSION, sources: KNOWLEDGE_CATALOG });
  })
  .build();
