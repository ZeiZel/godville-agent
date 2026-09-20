import { createHash, randomUUID } from "node:crypto";
import type { ClickOutcome } from "./browser.js";
import type { AgentDatabase } from "./database.js";
import {
  LIVE_COMMANDS,
  type LiveBrowserAdapter,
  type LiveCommandId,
  type ReviewedLiveCommand,
} from "./live-godville-adapter.js";
import { planLivePolicy, type LivePolicy, type PlannedSequence } from "./live-policy.js";
import type { BudgetPolicy, Decision, ObservationV1 } from "./types.js";

/** Only reviewed adapter commands enter this map. Policy JSON can select, never define, commands. */
export const REVIEWED_COMMANDS: ReadonlyMap<LiveCommandId, ReviewedLiveCommand> = new Map(
  Object.values(LIVE_COMMANDS).map((command) => [command.id, command]),
);

export type LiveAdapter = LiveBrowserAdapter;

function chargeScope(db: AgentDatabase, command: ReviewedLiveCommand, godName: string): string {
  // Rule IDs are user-editable policy data and must never define an expedition
  // budget scope. Reviewed command identity remains stable across policy edits.
  return `live-mission:${db.liveMissionId(godName)}`;
}

export interface RunResult {
  state: "DRY_RUN" | "CONFIRMED" | "SKIPPED" | "AMBIGUOUS" | "FAILED";
  completed: string[];
  reason: string;
}

/** A live runner never grants a click unless its caller proves the shared browser lease is live. */
export interface RunnerGuards {
  canIssueClick(): boolean;
}

export function livePolicyFingerprint(policy: LivePolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function immutableCommandMatches(candidate: ReviewedLiveCommand, expected: ReviewedLiveCommand): boolean {
  // Older fixture adapters model only immutable costs; production adapters always
  // carry the reviewed mode list from LIVE_COMMANDS.
  const candidateModes = candidate.allowedModes ?? expected.allowedModes;
  return candidate.id === expected.id
    && candidate.maxPrana === expected.maxPrana
    && candidate.maxCharges === expected.maxCharges
    && candidateModes.length === expected.allowedModes.length
    && candidateModes.every((mode, index) => mode === expected.allowedModes[index]);
}

function stableIdentity(observation: ObservationV1): observation is ObservationV1 & { heroId: string; eventId: string } {
  return typeof observation.heroId === "string" && observation.heroId.length > 0
    && typeof observation.eventId === "string" && observation.eventId.length > 0;
}

function auditedDecision(
  policyHash: string,
  sequence: PlannedSequence,
  command: ReviewedLiveCommand,
  observation: ObservationV1,
): Decision {
  return {
    id: randomUUID(),
    kind: "Recommend",
    action: command.id,
    reason: "reviewed live policy command passed final observation gate",
    evidence: [
      `policy_sha256:${policyHash}`,
      `rule:${sequence.ruleId}`,
      `hero:${observation.heroId ?? "missing"}`,
      `event:${observation.eventId ?? "missing"}`,
    ],
  };
}

/**
 * Executes one planned sequence in order. The adapter waits and re-observes before invoking the
 * gate, so this runner audits and validates the final snapshot immediately before every click.
 */
export async function runSequence(
  adapter: LiveAdapter,
  db: AgentDatabase,
  _budget: BudgetPolicy,
  policy: LivePolicy,
  sequence: PlannedSequence,
  dryRun: boolean,
  guards: RunnerGuards,
): Promise<RunResult> {
  if (sequence.commands.length === 0) {
    return { state: dryRun ? "DRY_RUN" : "SKIPPED", completed: [], reason: sequence.reason };
  }

  const completed: string[] = [];
  const policyHash = livePolicyFingerprint(policy);

  for (const [phaseIndex, commandId] of sequence.commands.entries()) {
    const command = REVIEWED_COMMANDS.get(commandId as LiveCommandId);
    if (!command) {
      return { state: "FAILED", completed, reason: `unknown reviewed command: ${commandId}` };
    }

    const fresh = await adapter.observe();
    if (fresh.freshness !== "fresh" || !command.allowedModes.includes(fresh.mode) || fresh.prana === undefined || fresh.prana.current < command.maxPrana || (command.maxCharges > 0 && (fresh.charges === undefined || fresh.charges < command.maxCharges + 100))) {
      return { state: "SKIPPED", completed, reason: "fresh observation does not satisfy fixed command cost" };
    }

    if (dryRun) {
      completed.push(commandId);
      continue;
    }

    if (!stableIdentity(fresh)) {
      return { state: "SKIPPED", completed, reason: "account identity or stable game event is unavailable" };
    }

    let operationId: string | undefined;
    let decisionId: string | undefined;
    let gateReason: string | undefined;
    const outcome = await adapter.execute(command.id, {
      beforeClick: async ({ command: finalCommand, observation: finalObservation }) => {
        const finalPlan = planLivePolicy(policy, finalObservation);
        if (!guards.canIssueClick()) { gateReason = "browser writer lease or stop signal is unavailable"; return false; }
        if (command.id !== "arena.zpg.start" && db.isCooldownActive("zpg-active", new Date())) { gateReason = "persistent ZPG intervention lock suppresses other commands"; return false; }
        if (!immutableCommandMatches(finalCommand, command)) { gateReason = "adapter command metadata differs from the reviewed registry"; return false; }
        if (!stableIdentity(finalObservation) || finalObservation.heroId !== fresh.heroId || finalObservation.eventId !== fresh.eventId) { gateReason = "account identity or battle/turn event changed before the journal gate"; return false; }
        if (finalPlan.ruleId !== sequence.ruleId || finalPlan.commands[phaseIndex] !== command.id) { gateReason = "JSON policy changed before the journal gate"; return false; }
        if (finalObservation.freshness !== "fresh" || !command.allowedModes.includes(finalObservation.mode) || finalObservation.prana === undefined || finalObservation.prana.current < command.maxPrana || (command.maxCharges > 0 && (finalObservation.charges === undefined || finalObservation.charges < command.maxCharges + 100))) { gateReason = "final resources or mode no longer satisfy this command"; return false; }
        if (db.hasUnresolvedOperation(command.id)) { gateReason = "an unresolved operation for this command blocks a retry"; return false; }

        const observationId = db.saveObservation(finalObservation, "live-godville-final");
        decisionId = db.saveDecision(
          auditedDecision(policyHash, sequence, command, finalObservation),
          observationId,
          "live-command/v1",
          `live-policy/${policyHash}`,
        );
        const intentKey = createHash("sha256")
          .update(`${command.id}:${finalObservation.heroId}:${finalObservation.eventId}`)
          .digest("hex");
        const operation = db.createOperation(
          intentKey,
          decisionId,
          command.id,
          1,
          {
            policySha256: policyHash,
            ruleId: sequence.ruleId,
            phaseIndex,
            finalObservationId: observationId,
            minPrana: command.maxPrana,
          },
          { confirmedBy: "diary event and bounded prana change" },
        );
        if (operation.state !== "PLANNED" || !db.transitionOperation(operation.id, "PLANNED", "EXECUTED")) return false;
        if (command.id === "arena.zpg.start") db.confirmCooldown("zpg-active", operation.id, new Date(Date.now() + 4 * 60 * 60 * 1000));
        if (command.maxCharges > 0) {
          // The observed accumulator balance is persisted immediately before the fenced
          // reservation; a recharge can never silently cross the user reserve.
          // A charge budget applies once to the qualified mission rule (for example
          // dungeon entry or the ZPG window), rather than forever to the generic
          // restore command ID.
          if (!db.importBalance(finalObservation.charges!, "live accumulator observation") || !db.reserveCharges(decisionId, operation.id, command.maxCharges, _budget, chargeScope(db, command, finalObservation.heroId!))) {
            db.transitionOperation(operation.id, "EXECUTED", "FAILED", "charge reserve was unavailable");
            return false;
          }
        }
        operationId = operation.id;
        return true;
      },
      denialReason: () => gateReason,
      beforePhysicalClick: () => guards.canIssueClick(),
      onOutcome: async (result: ClickOutcome) => {
        if (!operationId) return;
        if (result.state === "CONFIRMED") {
          db.transitionOperation(operationId, "EXECUTED", "CONFIRMED", result.reason);
          if (command.id === "arena.zpg.start") db.confirmCooldown("zpg-active", operationId, new Date(Date.now() + 4 * 60 * 60 * 1000));
          if (decisionId && command.maxCharges > 0) db.resolveReservation(decisionId, operationId, "CONFIRM");
        } else if (result.state === "AMBIGUOUS") {
          db.transitionOperation(operationId, "EXECUTED", "AMBIGUOUS", result.reason);
          // A click may have entered an arena even when the postcondition is unavailable.
          // Preserve the lock until a later verified field state releases it.
          if (command.id === "arena.zpg.start") db.confirmCooldown("zpg-active", operationId, new Date(Date.now() + 4 * 60 * 60 * 1000));
        } else {
          db.transitionOperation(operationId, "EXECUTED", "FAILED", result.reason);
          if (command.id === "arena.zpg.start" && !result.clicked && !result.ambiguous) db.clearCooldown("zpg-active");
          if (decisionId && command.maxCharges > 0) db.resolveReservation(decisionId, operationId, "CANCEL");
        }
      },
    });

    if (outcome.state !== "CONFIRMED") {
      return { state: outcome.state, completed, reason: outcome.reason };
    }
    completed.push(command.id);
    if (completed.length < sequence.commands.length) await adapter.waitBetweenActions();
  }

  return { state: dryRun ? "DRY_RUN" : "CONFIRMED", completed, reason: "sequence completed" };
}
