import { backupCommand } from "./backup.js";
import { browserCheckCommand } from "./browser-check.js";
import { browserInspectCommand } from "./browser-inspect.js";
import { browserRunCommand } from "./browser-run.js";
import { daemonCommand } from "./daemon.js";
import { importSnapshotCommand } from "./import-snapshot.js";
import { knowledgeCommand } from "./knowledge.js";
import { liveCommand } from "./live.js";
import { prioritiesCommand } from "./priorities.js";
import { statusCommand } from "./status.js";
import { CommandRegistryBuilder } from "./builder.js";
import type { Command } from "./types.js";

const commands: readonly Command[] = [
  daemonCommand,
  statusCommand,
  importSnapshotCommand,
  knowledgeCommand,
  prioritiesCommand,
  browserCheckCommand,
  browserInspectCommand,
  browserRunCommand,
  liveCommand,
  backupCommand,
];
export function createCommandRegistry(items: readonly Command[] = commands): Map<string, Command> {
  const builder = new CommandRegistryBuilder();
  for (const command of items) builder.add(command);
  return builder.build();
}

export function commandUsage(registry: ReadonlyMap<string, Command>): string { return `usage: ${[...registry.values()].map((command) => command.usage).join(" | ")}`; }
