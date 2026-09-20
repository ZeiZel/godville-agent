import type { AgentDatabase, OperationState } from "./database.js";
import type { ObservationV1 } from "./types.js";

export const LIVE_LIFECYCLE_KEY = "live-lifecycle";
const LIVE_LIFECYCLE_VERSION = 1;

export interface LiveLifecycleState {
  godName: string;
  lastActive?: { mode: "arena" | "polygon" | "dungeon"; battleId: string; seenAt: string };
  arenaOperationId?: string;
}

function battleIdOf(observation: ObservationV1): string | undefined {
  const value = (observation as ObservationV1 & { battleId?: unknown }).battleId;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof observation.eventId !== "string") return undefined;
  const dungeon = observation.eventId.match(/^godville-dungeon-turn:(.+):\d+$/u);
  return dungeon?.[1] ?? observation.eventId;
}

function read(db: AgentDatabase, godName: string): LiveLifecycleState {
  const state = db.getUserSetting<LiveLifecycleState>(LIVE_LIFECYCLE_KEY, LIVE_LIFECYCLE_VERSION);
  return state?.godName === godName ? state : { godName };
}

function save(db: AgentDatabase, state: LiveLifecycleState, now: Date): void {
  db.upsertUserSetting(LIVE_LIFECYCLE_KEY, LIVE_LIFECYCLE_VERSION, state, now);
}

/**
 * Persists the observed adventure state across process restarts. A field snapshot
 * releases the ZPG lock only after an active arena snapshot was observed first.
 */
export function reconcileLiveLifecycle(db: AgentDatabase, observation: ObservationV1, godName: string, now = new Date()): LiveLifecycleState {
  const state = read(db, godName);
  if (observation.freshness !== "fresh" || observation.heroId?.toLocaleLowerCase() !== godName.toLocaleLowerCase()) return state;
  const battleId = battleIdOf(observation);
  if ((observation.mode === "arena" || observation.mode === "polygon" || observation.mode === "dungeon") && battleId && Number.isFinite(Date.parse(observation.observedAt))) {
    if (state.arenaOperationId && state.lastActive?.mode === "arena" && observation.mode !== "arena") return state;
    state.lastActive = { mode: observation.mode, battleId, seenAt: observation.observedAt };
    if (observation.mode === "arena") {
      const operationId = db.cooldownOperationId("zpg-active") ?? db.latestUnresolvedOperation("arena.zpg.start")?.id;
      if (operationId && db.operationBelongsToAccount(operationId, godName)) state.arenaOperationId = operationId;
    }
    save(db, state, now);
    return state;
  }
  const observedAt = Date.parse(observation.observedAt);
  const seenAt = state.lastActive ? Date.parse(state.lastActive.seenAt) : NaN;
  if (observation.mode !== "idle" || !state.lastActive || !Number.isFinite(observedAt) || !Number.isFinite(seenAt) || observedAt <= seenAt || observedAt > now.getTime() + 5 * 60_000) {
    save(db, state, now);
    return state;
  }
  const operation = state.arenaOperationId ? db.operation(state.arenaOperationId) : undefined;
  if (state.lastActive.mode === "arena" && state.arenaOperationId) {
    if (operation && (operation.state === "EXECUTED" || operation.state === "AMBIGUOUS")) db.transitionOperation(operation.id, operation.state as OperationState, "CONFIRMED", "verified field return after observed active arena");
    db.clearCooldown("zpg-active");
  }
  db.expireUnresolvedWithoutReservations(state.lastActive.seenAt, state.lastActive.battleId, ["hero.encourage", "hero.punish", "arena.voice.heal", "arena.voice.attack", "dungeon.move.auto", "polygon.move.safe"], godName);
  db.rotateLiveMission(godName);
  delete state.arenaOperationId;
  delete state.lastActive;
  save(db, state, now);
  return state;
}
