import { UsageError, type Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

export const prioritiesCommand: Command = new CommandBuilder()
  .named("priorities")
  .usage("priorities [VERSION JSON_STRING_ARRAY]")
  .handle(async ({ db, print }, args): Promise<void> => {
    if (args.length === 0) { print({ priorities: db.latestPriorities() ?? [] }); return; }
    const version = Number(args[0]);
    let values: unknown;
    try { values = JSON.parse(args[1] ?? ""); } catch { throw new UsageError("priorities [VERSION JSON_STRING_ARRAY]"); }
    if (args.length !== 2 || !Number.isInteger(version) || !Array.isArray(values) || !values.every((value) => typeof value === "string")) throw new UsageError("priorities [VERSION JSON_STRING_ARRAY]");
    db.savePriorities(version, values); print({ saved: version });
  })
  .build();
