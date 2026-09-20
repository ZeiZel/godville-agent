import type { ObservationV1 } from "./types.js";

export const LIVE_POLICY_VERSION = "live-policy/v1" as const;
export type Comparator = "equals" | "gte" | "lte" | "missing";
export type ObservationField = "freshness" | "mode" | "health" | "health.percent" | "prana.current" | "readiness.expedition" | "readiness.zpg";
export interface Predicate { field: ObservationField; compare: Comparator; value: string | number | boolean }
export interface SequenceRule { id: string; safety: "block" | "normal"; priority: number; weight: number; when: Predicate[]; sequence: string[] }
export interface LivePolicy { schemaVersion: typeof LIVE_POLICY_VERSION; rules: SequenceRule[] }
export interface PlannedSequence { ruleId: string; commands: string[]; reason: string }

const fields = new Set<ObservationField>(["freshness", "mode", "health", "health.percent", "prana.current", "readiness.expedition", "readiness.zpg"]);
const comparators = new Set<Comparator>(["equals", "gte", "lte", "missing"]);
const commands = new Set(["hero.encourage"]);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function validPredicate(value: unknown): value is Predicate {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !fields.has(value.field as ObservationField) || !comparators.has(value.compare as Comparator)) return false;
  if (typeof value.value === "number" && !Number.isFinite(value.value)) return false;
  if (value.compare === "missing") return value.value === true;
  const numeric = value.field === "health.percent" || value.field === "prana.current";
  const readiness = value.field === "readiness.expedition" || value.field === "readiness.zpg";
  if (numeric) return typeof value.value === "number";
  if (readiness) return value.compare === "equals" && typeof value.value === "boolean";
  return value.compare === "equals" && typeof value.value === "string";
}
function validRule(value: unknown): value is SequenceRule {
  if (!isRecord(value) || !["id", "safety", "priority", "weight", "when", "sequence"].every((key) => key in value) || Object.keys(value).length !== 6) return false;
  return typeof value.id === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(value.id)
    && (value.safety === "block" || value.safety === "normal")
    && isInteger(value.priority) && value.priority >= 0 && value.priority <= 1_000
    && typeof value.weight === "number" && Number.isFinite(value.weight) && value.weight >= 1 && value.weight <= 1_000
    && Array.isArray(value.when) && value.when.length > 0 && value.when.length <= 12 && value.when.every(validPredicate)
    && Array.isArray(value.sequence) && value.sequence.length <= 8
    && value.sequence.every((command) => typeof command === "string" && commands.has(command))
    && new Set(value.sequence).size === value.sequence.length;
}

/** Parses declarative JSON only: no selectors, JavaScript, costs or dynamic command names are admitted. */
export function parseLivePolicy(value: unknown): LivePolicy {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.schemaVersion !== LIVE_POLICY_VERSION || !Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 100 || !value.rules.every(validRule)) throw new Error("invalid live policy");
  const ids = new Set<string>();
  for (const rule of value.rules) { if (ids.has(rule.id)) throw new Error(`duplicate policy rule: ${rule.id}`); ids.add(rule.id); }
  return { schemaVersion: LIVE_POLICY_VERSION, rules: value.rules };
}
function valueFor(field: ObservationField, observation: ObservationV1): string | number | boolean | undefined {
  if (field === "freshness" || field === "mode" || field === "health") return observation[field];
  if (field === "health.percent") return observation.healthPercent;
  if (field === "prana.current") return observation.prana?.current;
  if (field === "readiness.expedition") return observation.rawShape.includes("expedition-ready") ? true : undefined;
  return observation.rawShape.includes("zpg-arena") ? true : undefined;
}
function matches(predicate: Predicate, observation: ObservationV1): boolean {
  const actual = valueFor(predicate.field, observation);
  if (predicate.compare === "missing") return actual === undefined && predicate.value === true;
  if (actual === undefined) return false;
  if (predicate.compare === "equals") return actual === predicate.value;
  return typeof actual === "number" && typeof predicate.value === "number" && (predicate.compare === "gte" ? actual >= predicate.value : actual <= predicate.value);
}
/** Safety blocks win before deterministic priority/weight selection. Equal rules retain policy-file order. */
export function planLivePolicy(policy: LivePolicy, observation: ObservationV1): PlannedSequence {
  const matching = policy.rules.filter((rule) => rule.when.every((predicate) => matches(predicate, observation)));
  const block = matching.find((rule) => rule.safety === "block");
  if (block) return { ruleId: block.id, commands: [], reason: "safety block matched" };
  const candidates = matching.filter((rule) => rule.safety === "normal" && rule.sequence.length > 0);
  if (candidates.length === 0) return { ruleId: "observe", commands: [], reason: "no executable rule matched" };
  candidates.sort((left, right) => right.priority - left.priority || right.weight - left.weight);
  const selected = candidates[0]!;
  return { ruleId: selected.id, commands: [...selected.sequence], reason: "highest deterministic priority and weight" };
}
