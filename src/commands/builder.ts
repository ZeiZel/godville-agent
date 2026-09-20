import type { Command, CommandContext } from "./types.js";

/** Small fluent builder keeps each command's public name, usage and handler together. */
export class CommandBuilder {
  private commandName?: string;
  private commandUsage?: string;
  private handler?: (context: CommandContext, args: string[]) => Promise<void>;

  named(name: string): this { this.commandName = name; return this; }
  usage(usage: string): this { this.commandUsage = usage; return this; }
  handle(handler: (context: CommandContext, args: string[]) => Promise<void>): this { this.handler = handler; return this; }
  build(): Command {
    if (!this.commandName || !this.commandUsage || !this.handler) throw new Error("incomplete command definition");
    return { name: this.commandName, usage: this.commandUsage, run: this.handler };
  }
}

export class CommandRegistryBuilder {
  private readonly commands = new Map<string, Command>();
  add(command: Command): this { if (this.commands.has(command.name)) throw new Error(`duplicate command: ${command.name}`); this.commands.set(command.name, command); return this; }
  build(): Map<string, Command> { return new Map(this.commands); }
}
