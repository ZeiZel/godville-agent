import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeApiPayload, OfficialApiClient } from "./api.js";
import { parseHandlerCatalog } from "./handlers.js";
import { findEnabledHandler } from "./handlers.js";
import { executeBrowserHandler } from "./browser-runtime.js";
import { loadConfig, readTokenFromFile } from "./config.js";
import { AgentDatabase } from "./database.js";
import { KNOWLEDGE_CATALOG, KNOWLEDGE_CATALOG_VERSION } from "./knowledge.js";
import { decide, RULE_VERSION, zpgDecision } from "./policy.js";
import type { ObservationV1 } from "./types.js";

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function usage(): never { throw new Error("usage: daemon [--once] | status | import-snapshot FILE | knowledge | priorities [VERSION JSON] | browser-check | browser-run HANDLER VERSION [URL] | backup FILE"); }
function init(): { db: AgentDatabase; config: ReturnType<typeof loadConfig> } {
  const config = loadConfig(); const db = new AgentDatabase(config.dataDir);
  for (const source of KNOWLEDGE_CATALOG) db.saveKnowledge(source);
  return { db, config };
}
async function oneCycle(db: AgentDatabase, config: ReturnType<typeof loadConfig>): Promise<void> {
  if (!config.api) { print({ event: "idle", reason: "No official API configuration; dry-run remains offline." }); return; }
  let observation: ObservationV1;
  try { observation = await new OfficialApiClient(config.api.godName, readTokenFromFile(config.api.tokenFile)).observe(); }
  catch (error) { print({ event: "api_error", message: error instanceof Error ? error.message : "unknown API error" }); return; }
  const observationId = db.saveObservation(observation, "official-api");
  const decision = decide(observation, db.latestPriorities());
  db.saveDecision(decision, observationId, KNOWLEDGE_CATALOG_VERSION, RULE_VERSION);
  const zpg = zpgDecision(observation, config, new Date(), db.isCooldownActive("zpg", new Date()));
  db.saveDecision(zpg, observationId, KNOWLEDGE_CATALOG_VERSION, `${RULE_VERSION}/zpg`);
  print({ event: "decision", decision, zpg });
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2); if (!command) usage();
  const { db, config } = init();
  try {
    if (command === "status") { print({ integrity: db.integrityCheck(), mode: config.mode, browserEnabled: config.browser.enabled, balance: db.currentBalance(), available: db.availableCharges(), knowledgeVersion: KNOWLEDGE_CATALOG_VERSION }); return; }
    if (command === "knowledge") { print({ version: KNOWLEDGE_CATALOG_VERSION, sources: KNOWLEDGE_CATALOG }); return; }
    if (command === "import-snapshot") { const file = args[0]; if (!file) usage(); const observation = normalizeApiPayload(JSON.parse(readFileSync(file, "utf8")), process.env.GODVILLE_GOD_NAME, false); const id = db.saveObservation(observation, "manual-snapshot"); const decision = decide(observation, db.latestPriorities()); db.saveDecision(decision, id, KNOWLEDGE_CATALOG_VERSION, RULE_VERSION); print({ observationId: id, decision }); return; }
    if (command === "priorities") { if (args.length === 0) { print({ priorities: db.latestPriorities() ?? [] }); return; } const version = Number(args[0]); const values = JSON.parse(args[1] ?? "[]"); if (!Number.isInteger(version) || !Array.isArray(values) || !values.every((v) => typeof v === "string")) throw new Error("priorities requires integer version and JSON string array"); db.savePriorities(version, values); print({ saved: version }); return; }
    if (command === "browser-check") { if (!config.browser.enabled || !config.browser.manifestFile) throw new Error("browser-check requires GODVILLE_BROWSER_ENABLED=true and GODVILLE_BROWSER_MANIFEST"); const catalog = parseHandlerCatalog(JSON.parse(readFileSync(config.browser.manifestFile, "utf8"))); for (const handler of catalog.handlers) db.saveHandler(handler.handler, handler.version, handler.priority, handler, handler.verifiedAt); print({ browser: "configured", handlers: catalog.handlers.length, execution: "browser-run defaults to the checked-in local fixture; remote targets require an explicit flag and a reviewed DOM contract" }); return; }
    if (command === "browser-run") {
      if (!config.browser.enabled || !config.browser.manifestFile) throw new Error("browser-run requires GODVILLE_BROWSER_ENABLED=true and GODVILLE_BROWSER_MANIFEST");
      const name = args[0], version = Number(args[1]); if (!name || !Number.isInteger(version)) usage();
      const catalog = parseHandlerCatalog(JSON.parse(readFileSync(config.browser.manifestFile, "utf8")));
      const handler = findEnabledHandler(catalog, name, version); if (!handler) throw new Error("requested handler is not an enabled exact catalog entry");
      const owner = randomUUID(), ttl = 10 * 60 * 1000;
      if (!db.acquireLease("browser", owner, ttl)) throw new Error("another browser actor holds the writer lease");
      const token = db.leaseToken("browser", owner); if (token === undefined) throw new Error("browser lease was not readable");
      db.recoverUncertainOperations("browser", owner, token);
      let operationId: string | undefined, decisionId: string | undefined;
      try {
        const outcome = await executeBrowserHandler({
          handler, catalog, ...(args[2] ? { url: args[2] } : {}), ...(process.env.GODVILLE_BROWSER_STATE_DIR ? { userDataDir: process.env.GODVILLE_BROWSER_STATE_DIR } : {}), headless: process.env.GODVILLE_BROWSER_HEADLESS !== "false", allowRemoteUrl: process.env.GODVILLE_BROWSER_ALLOW_REMOTE === "true",
          beforeClick: async ({ handler: current, observation }) => {
            if (!db.hasLease("browser", owner, token) || !db.renewLease("browser", owner, token, ttl)) return false;
            if (current.handler === "arena.zpg.start" && db.isCooldownActive("zpg", new Date())) return false;
            if (db.hasUnresolvedOperation(current.handler)) return false;
            const eventKey = current.handler === "arena.zpg.start"
              ? `${new Date().toISOString().slice(0, 13)}:00Z`
              : current.handler.startsWith("fixture.") ? "local-fixture" : undefined;
            if (!eventKey) return false; // no server/UI event id: fail closed rather than replay an unknown action
            decisionId = createHash("sha256").update(`${current.handler}:${current.version}:${observation.heroId ?? "unknown"}:${eventKey}`).digest("hex");
            const operation = db.createOperation(decisionId, decisionId, current.handler, current.version, current.precondition, current.postcondition);
            if (operation.state !== "PLANNED") return false;
            if (current.cost.maxCharges > 0 && !db.reserveCharges(decisionId, operation.id, current.cost.maxCharges, config.budget)) { db.transitionOperation(operation.id, "PLANNED", "SKIPPED", "budget guard rejected cost"); return false; }
            if (!db.transitionOperation(operation.id, "PLANNED", "EXECUTED")) return false;
            operationId = operation.id; return true;
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
            } else if (outcome.state === "AMBIGUOUS") db.transitionOperation(operationId, "EXECUTED", "AMBIGUOUS", outcome.reason);
            else db.transitionOperation(operationId, "PLANNED", "SKIPPED", outcome.reason);
          },
        });
        print({ event: "browser_outcome", state: outcome.state, reason: outcome.reason });
      } finally { db.releaseLease("browser", owner, token); }
      return;
    }
    if (command === "backup") { const output = args[0]; if (!output) usage(); db.backupTo(output); print({ backup: output }); return; }
    if (command === "daemon") {
      const owner = randomUUID(), ttl = 10 * 60 * 1000;
      if (!db.acquireLease("daemon", owner, ttl)) throw new Error("another daemon holds the writer lease");
      const token = db.leaseToken("daemon", owner); if (token === undefined) throw new Error("writer lease was not readable");
      db.recoverUncertainOperations("daemon", owner, token);
      let stopped = false; const stop = () => { stopped = true; };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        do {
          if (!db.renewLease("daemon", owner, token, ttl)) throw new Error("writer lease was lost");
          await oneCycle(db, config);
          if (!args.includes("--once") && !stopped) {
            let remaining = (config.api?.intervalSeconds ?? 75) * 1000;
            while (!stopped && remaining > 0) { const chunk = Math.min(remaining, 1_000); await new Promise((resolve) => setTimeout(resolve, chunk)); remaining -= chunk; }
          }
        } while (!args.includes("--once") && !stopped);
      } finally { db.releaseLease("daemon", owner, token); }
      return;
    }
    usage();
  } finally { db.close(); }
}
void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "fatal error"}\n`); process.exitCode = 1; });
