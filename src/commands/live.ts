import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLiveGodvilleAdapter } from "../live-godville-adapter.js";
import { parseLivePolicy, planLivePolicy } from "../live-policy.js";
import { livePolicyFingerprint, runSequence } from "../live-runner.js";
import { CommandBuilder } from "./builder.js";
import { UsageError, type Command, type CommandContext } from "./types.js";

const BROWSER_LEASE = "browser";
const LEASE_TTL_MS = 10 * 60 * 1000;

type LiveVerb = "observe" | "plan" | "run";

function requirePageId(context: CommandContext): string {
  const pageId = context.env.GODVILLE_ORCA_PAGE_ID;
  if (!pageId) throw new Error("live commands require GODVILLE_ORCA_PAGE_ID for an already-open Orca page");
  return pageId;
}

function createAdapter(context: CommandContext) {
  const command = context.env.GODVILLE_ORCA_COMMAND;
  if (command !== undefined && command !== "orca" && command !== "orca-dev") {
    throw new Error("GODVILLE_ORCA_COMMAND must be orca or orca-dev");
  }
  return createLiveGodvilleAdapter({
    pageId: requirePageId(context),
    ...(command ? { command } : {}),
    ...(context.config.api?.godName ? { heroId: context.config.api.godName } : {}),
  });
}

function readPolicy(context: CommandContext) {
  if (!context.config.livePolicyFile) {
    throw new Error("live plan/run require GODVILLE_LIVE_POLICY_FILE");
  }
  return parseLivePolicy(JSON.parse(readFileSync(context.config.livePolicyFile, "utf8")));
}

/** The adapter returns a stable diary event on its second observation when the first one lacks it. */
async function stableObservation(context: CommandContext, adapter: ReturnType<typeof createAdapter>) {
  let observation = await adapter.observe();
  if (!observation.eventId) observation = await adapter.observe();
  context.db.saveObservation(observation, "live-godville");
  return observation;
}

function parseArgs(args: string[]): { verb: LiveVerb; dryRun: boolean } {
  const [verb, ...flags] = args;
  if (verb !== "observe" && verb !== "plan" && verb !== "run") {
    throw new UsageError("live observe | live plan | live run --once [--dry-run]");
  }
  const dryRun = flags.includes("--dry-run");
  const expected = verb === "run" ? (dryRun ? ["--once", "--dry-run"] : ["--once"]) : [];
  if (flags.length !== expected.length || !expected.every((flag) => flags.includes(flag))) {
    throw new UsageError("live observe | live plan | live run --once [--dry-run]");
  }
  return { verb, dryRun };
}

async function runLive(
  context: CommandContext,
  adapter: ReturnType<typeof createAdapter>,
  initial: Awaited<ReturnType<typeof stableObservation>>,
  dryRun: boolean,
): Promise<void> {
  const { config, db, print } = context;
  if (config.mode !== "browser" || !config.browser.enabled) {
    throw new Error("live run requires GODVILLE_MODE=browser and GODVILLE_BROWSER_ENABLED=true");
  }
  if (!config.api?.godName) {
    throw new Error("live run requires GODVILLE_GOD_NAME as the trusted single-account identity");
  }

  const policy = readPolicy(context);
  const sequence = planLivePolicy(policy, initial);

  if (dryRun) {
    const result = await runSequence(adapter, db, config.budget, policy, sequence, true, {
      canIssueClick: () => false,
    });
    print({ event: "live_dry_run", policySha256: livePolicyFingerprint(policy), initial, sequence, result });
    return;
  }

  const owner = randomUUID();
  if (!db.acquireLease(BROWSER_LEASE, owner, LEASE_TTL_MS)) {
    throw new Error("another browser actor holds the writer lease");
  }
  const token = db.leaseToken(BROWSER_LEASE, owner);
  if (token === undefined) {
    db.releaseLease(BROWSER_LEASE, owner);
    throw new Error("browser lease was not readable");
  }

  try {
    db.recoverUncertainOperations(BROWSER_LEASE, owner, token);
    const result = await runSequence(adapter, db, config.budget, policy, sequence, false, {
      canIssueClick: () => db.hasLease(BROWSER_LEASE, owner, token)
        && db.renewLease(BROWSER_LEASE, owner, token, LEASE_TTL_MS),
    });
    print({ event: "live_run", policySha256: livePolicyFingerprint(policy), initial, sequence, result });
  } finally {
    db.releaseLease(BROWSER_LEASE, owner, token);
  }
}

export const liveCommand: Command = new CommandBuilder()
  .named("live")
  .usage("live observe | live plan | live run --once [--dry-run]")
  .handle(async (context, args): Promise<void> => {
    const { verb, dryRun } = parseArgs(args);
    const adapter = createAdapter(context);
    const observation = await stableObservation(context, adapter);

    if (verb === "observe") {
      context.print({ event: "live_observation", observation });
      return;
    }

    const policy = readPolicy(context);
    const sequence = planLivePolicy(policy, observation);
    if (verb === "plan") {
      context.print({ event: "live_plan", policySha256: livePolicyFingerprint(policy), observation, sequence });
      return;
    }

    await runLive(context, adapter, observation, dryRun);
  })
  .build();
