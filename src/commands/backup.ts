import { UsageError, type Command } from "./types.js";
import { CommandBuilder } from "./builder.js";
export const backupCommand: Command = new CommandBuilder()
  .named("backup")
  .usage("backup FILE")
  .handle(async ({ db, print }, args): Promise<void> => {
    const output = args[0];
    if (!output || args.length !== 1) throw new UsageError("backup FILE");
    db.backupTo(output);
    print({ backup: output });
  })
  .build();
