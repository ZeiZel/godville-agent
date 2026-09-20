import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { executeBrowserHandler } from "../browser-runtime.js";
import { findEnabledHandler, parseHandlerCatalog } from "../handlers.js";
import { CommandBuilder } from "./builder.js";
import { UsageError, type Command } from "./types.js";

export const browserRunCommand: Command = new CommandBuilder()
  .named("browser-run")
  .usage("browser-run HANDLER VERSION [URL]")
  .handle(async ({ config, db, print }, args): Promise<void> => {
    if (!config.browser.enabled || !config.browser.manifestFile) {
      throw new Error("browser-run requires GODVILLE_BROWSER_ENABLED=true and GODVILLE_BROWSER_MANIFEST");
    }
    const [name, versionText, url] = args;
    const version = Number(versionText);
    if (!name || !Number.isInteger(version) || args.length < 2 || args.length > 3) {
      throw new UsageError("browser-run HANDLER VERSION [URL]");
    }
    const catalog = parseHandlerCatalog(JSON.parse(readFileSync(config.browser.manifestFile, "utf8")));
    const handler = findEnabledHandler(catalog, name, version);
    if (!handler) throw new Error("requested handler is not an enabled exact catalog entry");

    const owner = randomUUID(), ttl = 10 * 60 * 1000;
    if (!db.acquireLease("browser", owner, ttl)) throw new Error("another browser actor holds the writer lease");
    const token = db.leaseToken("browser", owner);
    if (token === undefined) throw new Error("browser lease was not readable");
    db.recoverUncertainOperations("browser", owner, token);
    let operationId: string | undefined, decisionId: string | undefined;

    try {
      const outcome = await executeBrowserHandler({
        handler,
        catalog,
        ...(url ? { url } : {}),
        ...(config.browser.stateDir ? { userDataDir: config.browser.stateDir } : {}),
        headless: config.browser.headless,
        allowRemoteUrl: config.browser.allowRemoteUrl,
        beforeClick: async ({ handler: current, observation }) => {
          if (!db.hasLease("browser", owner, token) || !db.renewLease("browser", owner, token, ttl)) return false;
          if (current.handler === "arena.zpg.start" && db.isCooldownActive("zpg", new Date())) return false;
          if (db.hasUnresolvedOperation(current.handler)) return false;
          const eventKey = current.handler === "arena.zpg.start"
            ? `${new Date().toISOString().slice(0, 13)}:00Z`
            : current.handler.startsWith("fixture.") ? "local-fixture" : undefined;
          if (!eventKey) return false;

          decisionId = createHash("sha256")
            .update(`${current.handler}:${current.version}:${observation.heroId ?? "unknown"}:${eventKey}`)
            .digest("hex");
          const operation = db.createOperation(decisionId, decisionId, current.handler, current.version, current.precondition, current.postcondition);
          if (operation.state !== "PLANNED") return false;
          if (current.cost.maxCharges > 0 && !db.reserveCharges(decisionId, operation.id, current.cost.maxCharges, config.budget)) {
            db.transitionOperation(operation.id, "PLANNED", "SKIPPED", "budget guard rejected cost");
            return false;
          }
          if (!db.transitionOperation(operation.id, "PLANNED", "EXECUTED")) return false;
          operationId = operation.id;
          return true;
        },
        onOutcome: async (outcome) => {
          if (!operationId || !decisionId) return;
          if (outcome.state === "CONFIRMED") {
            db.transitionOperation(operationId, "EXECUTED", "CONFIRMED", outcome.reason);
            if (handler.cost.maxCharges > 0) db.resolveReservation(decisionId, operationId, "CONFIRM");
            if (handler.handler === "arena.zpg.start") {
              const actualExpiry = outcome.observation?.cooldowns["zpg-arena"];
              if (actualExpiry && Date.parse(actualExpiry) > Date.now()) db.confirmCooldown("zpg", operationId, new Date(actualExpiry));
            }
          } else if (outcome.state === "AMBIGUOUS") {
            db.transitionOperation(operationId, "EXECUTED", "AMBIGUOUS", outcome.reason);
          } else {
            db.transitionOperation(operationId, "PLANNED", "SKIPPED", outcome.reason);
          }
        },
      });
      print({ event: "browser_outcome", state: outcome.state, reason: outcome.reason });
    } finally {
      db.releaseLease("browser", owner, token);
    }
  })
  .build();
