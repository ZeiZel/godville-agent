import { loadConfig } from "../config.js";
import { AgentDatabase } from "../database.js";
import { KNOWLEDGE_CATALOG } from "../knowledge.js";
import type { CommandContext } from "./types.js";

export function printJson(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

export function createCommandContext(env = process.env, print = printJson): CommandContext {
  const config = loadConfig(env);
  const db = new AgentDatabase(config.dataDir);
  try {
    for (const source of KNOWLEDGE_CATALOG) db.saveKnowledge(source);
    return { db, config, env, print };
  } catch (error) { db.close(); throw error; }
}
