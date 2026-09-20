import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLiveGodvilleAdapter } from "../live-godville-adapter.js";
import { parseLivePolicy, planLivePolicy } from "../live-policy.js";
import { livePolicyFingerprint, runSequence } from "../live-runner.js";
import { CommandBuilder } from "./builder.js";
import { UsageError, type Command, type CommandContext } from "./types.js";
import { reconcileLiveLifecycle } from "../live-lifecycle.js";
import { enrichObservationWithProfile } from "../api.js";
import { getProgressionProfile } from "../progression-cache.js";

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
    zpgEnabled: context.config.zpg.enabled,
    zpgWindow: { minOffsetSeconds: context.config.zpg.minOffsetSeconds, maxOffsetSeconds: context.config.zpg.maxOffsetSeconds },
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

function parseArgs(args: string[]): { verb: LiveVerb; dryRun: boolean; once: boolean } {
  const [verb, ...flags] = args;
  if (verb !== "observe" && verb !== "plan" && verb !== "run") {
    throw new UsageError("live observe | live plan | live run [--once] [--dry-run]");
  }
  const dryRun = flags.includes("--dry-run");
  const once = flags.includes("--once");
  const expected = verb === "run" ? [ ...(once ? ["--once"] : []), ...(dryRun ? ["--dry-run"] : []) ] : [];
  if (flags.length !== expected.length || !expected.every((flag) => flags.includes(flag))) {
    throw new UsageError("live observe | live plan | live run [--once] [--dry-run]");
  }
  return { verb, dryRun, once };
}

async function waitForNextLiveCycle(milliseconds: number, stopped: () => boolean): Promise<void> {
  let remaining = milliseconds;
  while (!stopped() && remaining > 0) { const chunk = Math.min(remaining, 1_000); await new Promise<void>((resolve) => setTimeout(resolve, chunk)); remaining -= chunk; }
}

async function runLive(
  context: CommandContext,
  adapter: ReturnType<typeof createAdapter>,
  initial: Awaited<ReturnType<typeof stableObservation>>,
  dryRun: boolean,
  once: boolean,
): Promise<void> {
  const { config, db, print } = context;
  if (config.mode !== "browser" || !config.browser.enabled) {
    throw new Error("live run requires GODVILLE_MODE=browser and GODVILLE_BROWSER_ENABLED=true");
  }
  if (!config.api?.godName) {
    throw new Error("live run requires GODVILLE_GOD_NAME as the trusted single-account identity");
  }

  const policy = readPolicy(context);
  let progressionProfile: Awaited<ReturnType<typeof getProgressionProfile>>;
  const enrichProgression = async (candidate: typeof initial): Promise<typeof initial> => {
    const criticalWindow = candidate.mode === "arena"
      || candidate.rawShape.includes("arena-window-reserved")
      || candidate.rawShape.includes("zpg-ready")
      || candidate.rawShape.includes("zpg-arena");
    if (!criticalWindow && config.api?.godName) {
      const refreshed = await getProgressionProfile(db, config.api.godName);
      if (refreshed) progressionProfile = refreshed;
    }
    return progressionProfile ? enrichObservationWithProfile(candidate, progressionProfile) : candidate;
  };
  initial = await enrichProgression(initial);
  if (dryRun) {
    const sequence = planLivePolicy(policy, initial);
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
    let stopped = false, observation = initial, failures = 0, needsObservation = false;
    reconcileLiveLifecycle(db, observation, config.api.godName);
    const stop = () => { stopped = true; };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      do {
        if (!db.renewLease(BROWSER_LEASE, owner, token, LEASE_TTL_MS)) throw new Error("browser writer lease was lost");
        try {
          if (needsObservation) { observation = await stableObservation(context, adapter); needsObservation = false; }
          observation = await enrichProgression(observation);
          reconcileLiveLifecycle(db, observation, config.api.godName);
          const sequence = planLivePolicy(policy, observation);
          if (db.isCooldownActive("zpg-active", new Date()) || db.hasUnresolvedOperation("arena.zpg.start")) {
            print({ event: "live_wait", initial: observation, reason: "persistent ZPG intervention lock is active; awaiting verified terminal reconciliation" });
            if (!once && !stopped) { await waitForNextLiveCycle(3_000 + Math.floor(Math.random() * 2_001), () => stopped); needsObservation = true; }
            continue;
          }
          const result = await runSequence(adapter, db, config.budget, policy, sequence, false, {
            canIssueClick: () => !stopped && db.hasLease(BROWSER_LEASE, owner, token)
              && db.renewLease(BROWSER_LEASE, owner, token, LEASE_TTL_MS),
          });
          print({ event: "live_run", policySha256: livePolicyFingerprint(policy), initial: observation, sequence, result, waiting: result.state === "SKIPPED" ? result.reason : undefined });
          failures = 0;
          if (!once && !stopped) {
            const zpgReserve = observation.rawShape.includes("arena-window-reserved") || observation.rawShape.includes("zpg-ready");
            const delay = observation.mode === "idle" && sequence.commands.length === 0 && !zpgReserve ? 15_000 : 3_000 + Math.floor(Math.random() * 2_001);
            await waitForNextLiveCycle(delay, () => stopped);
            if (!stopped) needsObservation = true;
          }
        } catch (error) {
          failures++;
          needsObservation = true;
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 3));
          print({ event: "live_transport_backoff", failures, delayMs: delay, reason: error instanceof Error ? error.message : "unknown live failure" });
          if (!once && !stopped) await waitForNextLiveCycle(delay, () => stopped);
          else if (once) throw error;
        }
      } while (!once && !stopped);
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } finally {
    db.releaseLease(BROWSER_LEASE, owner, token);
  }
}

export const liveCommand: Command = new CommandBuilder()
  .named("live")
  .usage("live observe | live plan | live run [--once] [--dry-run]")
  .handle(async (context, args): Promise<void> => {
    const { verb, dryRun, once } = parseArgs(args);
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

    await runLive(context, adapter, observation, dryRun, once);
  })
  .build();
