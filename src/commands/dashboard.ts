import { createDashboardServer } from "../dashboard.js";
import { CommandBuilder } from "./builder.js";
import type { Command } from "./types.js";

function parsePort(args: string[]): number {
  if (args.length === 0) return 3210;
  if (args.length !== 2 || args[0] !== "--port") throw new Error("dashboard [--port PORT]");
  const port = Number(args[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("dashboard port must be an integer from 1 to 65535");
  return port;
}

export const dashboardCommand: Command = new CommandBuilder()
  .named("dashboard")
  .usage("dashboard [--port PORT]")
  .handle(async (context, args): Promise<void> => {
    const port = parsePort(args);
    const server = createDashboardServer({ dataDir: context.config.dataDir, port, reserveCharges: context.config.budget.reserveCharges, ...(context.env.GODVILLE_LOG_DIR ? { logDir: context.env.GODVILLE_LOG_DIR } : {}) });
    context.print({ event: "dashboard_started", host: "127.0.0.1", port });
    await new Promise<void>((resolve) => {
      const stop = () => { server.stop(true); resolve(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  })
  .build();
