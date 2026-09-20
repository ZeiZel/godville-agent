export const OBSERVATION_VERSION = "observation/v1" as const;

export type Capability =
  | "temple" | "ark" | "pairs" | "laboratory" | "personal_boss"
  | "book" | "souls" | "shop" | "reliquary" | "pension";
export type Mode = "idle" | "arena" | "adventure_queue" | "dungeon" | "sailing" | "raid_boss" | "personal_boss" | "polygon" | "shop" | "unknown";
export type Health = "known_safe" | "known_risk" | "unknown";
export type ProgressionStage = "temple" | "ark" | "pairs" | "laboratory" | "personal_boss" | "book" | "souls" | "pension" | "shop" | "reliquary" | "unknown";
export interface ProgressionProfile {
  stage: ProgressionStage;
  capabilities: Capability[];
  templeCompletedAt?: string;
  arkCompletedAt?: string;
  arkMaterials?: { m: number; f: number };
  bossName?: string;
  words?: number;
  savings?: number;
  staleAt?: string;
}

export interface ObservationV1 {
  version: typeof OBSERVATION_VERSION;
  observedAt: string;
  sourceVersion: string;
  freshness: "fresh" | "stale" | "expired" | "auth_degraded";
  heroId?: string;
  /** Stable current game-event identity when the adapter can derive one; absent means live commands fail closed. */
  eventId?: string;
  /** Opaque current fight identity observed from a reviewed public battle-log link. */
  battleId?: string;
  mode: Mode;
  capabilities: Capability[];
  progressionKnown: boolean;
  progression?: ProgressionProfile;
  prana?: { current: number; capacity: number };
  charges?: number;
  health: Health;
  /** Exact observed health percentage, separate from the coarse health classification. */
  healthPercent?: number;
  opponentHealthPercent?: number;
  cooldowns: Record<string, string>;
  rawShape: string[];
}

export type DecisionKind = "NoOp" | "Observe" | "Recommend" | "ScheduleZpg";
export interface Decision {
  id: string;
  kind: DecisionKind;
  reason: string;
  action?: string;
  costCharges?: number;
  scheduleAt?: string;
  requiresManualConfirmation?: boolean;
  evidence: string[];
}

export interface BudgetPolicy {
  reserveCharges: number;
  maxChargesPerDay: number;
  maxChargesPerRolling7d: number;
  maxChargesPerExpedition: number;
}

export const DEFAULT_BUDGET: BudgetPolicy = {
  reserveCharges: 100,
  maxChargesPerDay: 2,
  maxChargesPerRolling7d: 10,
  maxChargesPerExpedition: 1,
};

export interface RuntimeConfig {
  dataDir: string;
  mode: "advisor" | "browser";
  api?: { godName: string; tokenFile?: string; intervalSeconds: number };
  budget: BudgetPolicy;
  zpg: { enabled: boolean; confirmation: boolean; minOffsetSeconds: number; maxOffsetSeconds: number };
  livePolicyFile?: string;
  browser: { enabled: boolean; manifestFile?: string; stateDir?: string; headless: boolean; allowRemoteUrl: boolean };
}
