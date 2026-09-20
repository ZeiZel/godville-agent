import type { AgentDatabase } from "../database.js";
import type { RuntimeConfig } from "../types.js";

export interface CommandContext {
  db: AgentDatabase;
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  print(value: unknown): void;
}

export interface Command {
  name: string;
  usage: string;
  run(context: CommandContext, args: string[]): Promise<void>;
}

export class UsageError extends Error {}
