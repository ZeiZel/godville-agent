import { OBSERVATION_VERSION, type Capability, type ObservationV1, type ProgressionProfile } from "./types.js";

function asObject(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function savingsNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(",", ".");
  const parsed = Number(/\d+(?:\.\d+)?/.exec(text)?.[0] ?? "NaN");
  if (!Number.isFinite(parsed)) return undefined;
  return parsed * (/(тысяч|thousand)/iu.test(text) ? 1_000 : /(миллион|million)/iu.test(text) ? 1_000_000 : 1);
}

export function progressionFromApiPayload(payload: unknown): ProgressionProfile | undefined {
  const object = asObject(payload);
  if (!object) return undefined;
  const templeCompletedAt = typeof object.temple_completed_at === "string" && object.temple_completed_at ? object.temple_completed_at : undefined;
  const arkCompletedAt = typeof object.ark_completed_at === "string" && object.ark_completed_at ? object.ark_completed_at : undefined;
  const arkM = number(object.ark_m), arkF = number(object.ark_f), words = number(object.words), savings = savingsNumber(object.savings);
  const bossName = typeof object.boss_name === "string" && object.boss_name ? object.boss_name : undefined;
  const capabilities: Capability[] = [];
  if (templeCompletedAt) capabilities.push("temple");
  if (arkCompletedAt) capabilities.push("ark");
  if (arkM !== undefined && arkF !== undefined && arkM >= 1_000 && arkF >= 1_000) capabilities.push("pairs");
  if (bossName) capabilities.push("personal_boss", "laboratory");
  if (words !== undefined && words >= 1_000) capabilities.push("book");
  if (savings !== undefined && savings >= 30_000_000) capabilities.push("pension");
  const complete = capabilities.includes("book") && capabilities.includes("pension");
  let stage: ProgressionProfile["stage"] = "unknown";
  if (!capabilities.includes("temple")) stage = "temple";
  else if (!capabilities.includes("ark")) stage = "ark";
  else if (!capabilities.includes("pairs")) stage = "pairs";
  else if (!capabilities.includes("laboratory")) stage = "laboratory";
  else if (!capabilities.includes("personal_boss")) stage = "personal_boss";
  else if (!capabilities.includes("book")) stage = "book";
  else if (!capabilities.includes("pension")) stage = "pension";
  else if (complete) stage = "souls";
  return {
    stage, capabilities: [...new Set(capabilities)],
    ...(templeCompletedAt ? { templeCompletedAt } : {}),
    ...(arkCompletedAt ? { arkCompletedAt } : {}),
    ...(arkM !== undefined && arkF !== undefined ? { arkMaterials: { m: arkM, f: arkF } } : {}),
    ...(bossName ? { bossName } : {}), ...(words !== undefined ? { words } : {}), ...(savings !== undefined ? { savings } : {}),
  };
}

export function enrichObservationWithProgression(observation: ObservationV1, payload: unknown): ObservationV1 {
  const progression = progressionFromApiPayload(payload);
  if (!progression) return observation;
  const object = asObject(payload);
  const fields = ["temple_completed_at", "ark_completed_at", "ark_m", "ark_f", "boss_name", "words", "savings"];
  const enriched = enrichObservationWithProfile(observation, progression);
  return { ...enriched, progressionKnown: !!object && fields.every((field) => Object.hasOwn(object, field)) };
}

export function enrichObservationWithProfile(observation: ObservationV1, progression: ProgressionProfile): ObservationV1 {
  if (!progression || !Array.isArray(progression.capabilities)) return observation;
  return { ...observation, progression, capabilities: [...new Set(progression.capabilities)], progressionKnown: observation.progressionKnown };
}

export function normalizeApiPayload(payload: unknown, expectedGodName?: string, requirePrivate = false, observedAt = new Date().toISOString()): ObservationV1 {
  const object = asObject(payload);
  if (!object || object.expired === true) return { version: OBSERVATION_VERSION, observedAt, sourceVersion: "api/v1", freshness: "expired", mode: "unknown", capabilities: [], progressionKnown: false, health: "unknown", cooldowns: {}, rawShape: [] };
  const keys = Object.keys(object).sort();
  const godname = typeof object.godname === "string" ? object.godname : undefined;
  const privateFieldsPresent = number(object.health) !== undefined && number(object.godpower) !== undefined;
  const identityMatches = !expectedGodName || godname?.toLocaleLowerCase() === expectedGodName.toLocaleLowerCase();
  if (!godname || !identityMatches || (requirePrivate && !privateFieldsPresent)) return { version: OBSERVATION_VERSION, observedAt, sourceVersion: "api/v1", freshness: "auth_degraded", mode: "unknown", capabilities: [], progressionKnown: false, health: "unknown", cooldowns: {}, rawShape: keys };
  const caps: Capability[] = [];
  if (typeof object.temple_completed_at === "string" && object.temple_completed_at) caps.push("temple");
  if (typeof object.ark_completed_at === "string" && object.ark_completed_at) caps.push("ark");
  if ((typeof object.pairs_at === "string" && object.pairs_at) || (number(object.ark_m) ?? 0) >= 1000 && (number(object.ark_f) ?? 0) >= 1000) caps.push("pairs");
  if (typeof object.boss_name === "string" && object.boss_name) caps.push("personal_boss");
  if (number(object.words) !== undefined && number(object.words)! >= 1000) caps.push("book");
  const savings = savingsNumber(object.savings);
  if ((savings ?? 0) >= 30_000_000) caps.push("pension");
  if (caps.includes("personal_boss")) { for (const parent of ["temple", "ark", "pairs", "laboratory"] as Capability[]) if (!caps.includes(parent)) caps.push(parent); }
  if (caps.includes("book") && !caps.includes("personal_boss")) caps.push("personal_boss", "laboratory", "pairs", "ark", "temple");
  const fightType = typeof object.fight_type === "string" ? object.fight_type : undefined;
  const mode = fightType === "sail" ? "sailing" : fightType === "dungeon" ? "dungeon" : fightType === "range" ? "polygon" : object.arena_fight === true ? "arena" : object.arena_fight === false && !fightType ? "idle" : "unknown";
  const health = number(object.health), maxHealth = number(object.max_health);
  const progressionKnown = ["temple_completed_at", "ark_completed_at", "ark_m", "ark_f", "boss_name", "words", "savings"].every((field) => Object.hasOwn(object, field));
  const observation: ObservationV1 = { version: OBSERVATION_VERSION, observedAt, sourceVersion: "api/v1", freshness: "fresh", ...(typeof object.name === "string" ? { heroId: object.name } : {}), mode, capabilities: [...new Set(caps)], progressionKnown, health: health === undefined || maxHealth === undefined || maxHealth <= 0 ? "unknown" : health / maxHealth >= 0.5 ? "known_safe" : "known_risk", cooldowns: {}, rawShape: keys };
  return enrichObservationWithProgression(observation, object);
}

export class OfficialApiClient {
  constructor(private readonly godName: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async observe(): Promise<ObservationV1> {
    const path = this.token ? `${encodeURIComponent(this.godName)}/${encodeURIComponent(this.token)}` : encodeURIComponent(this.godName);
    const url = new URL(`https://godville.net/gods/api/${path}`);
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error" });
    if (!response.ok) throw new Error(`official API returned HTTP ${response.status}`);
    return normalizeApiPayload(await response.json(), this.godName, this.token !== undefined);
  }
}
