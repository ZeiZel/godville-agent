import { inspectOrcaPage } from "../browser-inspection.js";
import { CommandBuilder } from "./builder.js";
import { UsageError, type Command } from "./types.js";

export const browserInspectCommand: Command = new CommandBuilder().named("browser-inspect").usage("browser-inspect").handle(async ({ env, print }, args): Promise<void> => {
  if (args.length !== 0) throw new UsageError("browser-inspect");
  const pageId = env.GODVILLE_ORCA_PAGE_ID;
  if (!pageId) throw new Error("browser-inspect requires GODVILLE_ORCA_PAGE_ID");
  const inspection = await inspectOrcaPage({ pageId, ...(env.GODVILLE_ORCA_COMMAND ? { command: env.GODVILLE_ORCA_COMMAND } : {}) });
  const authentication = inspection.path === "/login" && inspection.passwordFieldPresent ? "auth_required" : inspection.path === "/superhero" && !inspection.passwordFieldPresent ? "authenticated_but_adapter_missing" : "unknown";
  print({ ...inspection, authentication, domAdapter: inspection.observationContractCount > 0 ? "candidate_contract_present" : "unsupported", executorReady: false });
}).build();
