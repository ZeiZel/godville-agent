import { readFileSync } from "node:fs";
import { parseHandlerCatalog } from "../handlers.js";
import { UsageError, type Command } from "./types.js";
import { CommandBuilder } from "./builder.js";

export const browserCheckCommand: Command = new CommandBuilder().named("browser-check").usage("browser-check").handle(async ({ config, db, print }, args): Promise<void> => {
    if (args.length !== 0) throw new UsageError("browser-check");
    if (!config.browser.enabled || !config.browser.manifestFile) throw new Error("browser-check requires GODVILLE_BROWSER_ENABLED=true and GODVILLE_BROWSER_MANIFEST");
    const catalog = parseHandlerCatalog(JSON.parse(readFileSync(config.browser.manifestFile, "utf8")));
    for (const handler of catalog.handlers) db.saveHandler(handler.handler, handler.version, handler.priority, handler, handler.verifiedAt);
    print({ browser: "configured", handlers: catalog.handlers.length, execution: "browser-run defaults to the checked-in local fixture; remote targets require an explicit flag and a reviewed DOM contract" });
  }).build();
