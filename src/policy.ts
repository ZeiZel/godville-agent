import { createHash } from "node:crypto";
import { availableStages } from "./stages.js";
import type { Decision, ObservationV1, RuntimeConfig } from "./types.js";

export const RULE_VERSION = "rules/1";
function id(parts: unknown): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24); }
function noOp(reason: string, evidence: string[]): Decision { return { id: id([reason, evidence]), kind: "NoOp", reason, evidence }; }

export function decide(observation: ObservationV1, priorities: string[] = []): Decision {
  if (observation.freshness !== "fresh") return noOp("Observation is not fresh; dependent decisions are blocked.", [observation.freshness]);
  if (observation.mode === "unknown" || observation.health === "unknown") return { id: id([observation.observedAt, "unknown-state"]), kind: "Observe", reason: "Mode or health is unknown; do not infer a compatible activity.", evidence: ["mode", "health"] };
  if (observation.mode !== "idle") return noOp("A game mode is already active; do not propose an incompatible start.", [observation.mode]);
  if (!observation.progressionKnown) return { id: id([observation.observedAt, "progression-unknown"]), kind: "Observe", reason: "Progress milestones are not authoritative yet.", evidence: ["progression_known"] };
  const candidates = availableStages(observation.capabilities).sort((a, b) => { const ai = priorities.indexOf(a.id), bi = priorities.indexOf(b.id); return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi); });
  if (candidates.length === 0) return { id: id([observation.observedAt, "stable"]), kind: "Observe", reason: "No known next permanent unlock.", evidence: ["stage_dag"] };
  const stage = candidates[0]!;
  return { id: id([observation.observedAt, stage.id]), kind: "Recommend", action: `progress:${stage.id}`, reason: `Prioritize the known permanent unlock ${stage.id}.`, evidence: [stage.metric, RULE_VERSION] };
}

export function zpgDecision(observation: ObservationV1, config: RuntimeConfig, now: Date, cooldownActive = false, random: () => number = Math.random): Decision {
  if (!config.zpg.enabled || !config.zpg.confirmation) return noOp("ZPG needs both enablement and explicit confirmation.", ["zpg_confirmation"]);
  if (observation.freshness !== "fresh" || observation.mode !== "idle") return noOp("ZPG requires a fresh idle UI observation.", [observation.freshness, observation.mode]);
  const minute = now.getUTCMinutes(), second = now.getUTCSeconds();
  if (cooldownActive) return noOp("A confirmed ZPG cooldown is active.", ["zpg_cooldown"]);
  if (minute > 2 || (minute === 2 && second > 50)) return noOp("The ZPG attempt window has closed; ordinary arena is never a fallback.", ["hour_window"]);
  const offset = config.zpg.minOffsetSeconds + Math.floor(random() * (config.zpg.maxOffsetSeconds - config.zpg.minOffsetSeconds + 1));
  const earliest = new Date(now); earliest.setUTCMinutes(0, 0, 0); earliest.setUTCSeconds(offset);
  const schedule = earliest > now ? earliest : now;
  const hour = new Date(now); hour.setUTCMinutes(0, 0, 0);
  return { id: id([hour.toISOString(), "zpg"]), kind: "ScheduleZpg", action: "arena.zpg.start", reason: "One ZPG attempt may be made only after a fresh UI recheck.", scheduleAt: schedule.toISOString(), requiresManualConfirmation: true, evidence: ["arena knowledge", "no ordinary arena fallback", "no voices or charge reward assumption"] };
}
