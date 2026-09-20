import { createCommandContext, printJson } from "./commands/context.js";
import { commandUsage, createCommandRegistry } from "./commands/index.js";
import { UsageError, type Command, type CommandContext } from "./commands/types.js";

export async function dispatchCommand(args: string[], registry: ReadonlyMap<string, Command>, context: CommandContext): Promise<void> {
  const [name, ...commandArgs] = args;
  if (!name) throw new UsageError(commandUsage(registry));
  const command = registry.get(name);
  if (!command) throw new UsageError(commandUsage(registry));
  await command.run(context, commandArgs);
}

export async function runCli(args = process.argv.slice(2), env = process.env, registry = createCommandRegistry(), createContext = createCommandContext): Promise<void> {
  const context = createContext(env, printJson);
  try { await dispatchCommand(args, registry, context); }
  finally { context.db.close(); }
}
