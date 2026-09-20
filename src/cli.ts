import { runCli } from "./cli-app.js";

void runCli().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "fatal error"}\n`);
  process.exitCode = 1;
});
