import type { Mode, ObservationV1 } from "./types.js";

export const HANDLER_CATALOG_VERSION = "handler-catalog/v1" as const;
export const HANDLER_VERSION = "handler/v1" as const;
const MAX_REACTION_DELAY_MS = 5_000, MAX_CLICK_OFFSET_PX = 12, MAX_CLICK_JIGGLE_PX = 8, MAX_POSTCONDITION_TIMEOUT_MS = 30_000, MAX_CONDITION_DEPTH = 4;
export type Primitive = string | number | boolean;
export type ObservationField = "freshness" | "mode" | "health" | "progressionKnown" | "charges";
export type Condition =
  | { kind: "equals"; field: ObservationField; value: Primitive }
  | { kind: "contains"; field: "rawShape" | "capabilities"; value: string }
  | { kind: "cooldownElapsed"; name: string }
  | { kind: "all"; conditions: readonly Condition[] };
export interface HandlerDefinition {
  schemaVersion: typeof HANDLER_VERSION; handler: string; version: number; priority: number; enabled: boolean;
  reviewedSourceURL: string; verifiedAt: string;
  /** A versioned handler can click only a precisely named button. */
  match: { role: "button"; text: string };
  scope: { modes: readonly Exclude<Mode, "unknown">[]; requiredMarkers: readonly string[]; deadline?: { endSecond: number; safetyMarginMs: number } };
  precondition: Condition;
  /** Maximum known cost. Unknown cost has no valid handler representation. */
  cost: { maxPrana: number; maxCharges: number };
  action: { reactionDelayMs: readonly [number, number]; clickOffsetPx: number; clickJigglePx: number };
  postcondition: { condition: Condition; timeoutMs: number; pollIntervalMs: number };
}
export interface HandlerCatalog { schemaVersion: typeof HANDLER_CATALOG_VERSION; enabled: boolean; handlers: readonly HandlerDefinition[]; }
type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const isPrimitive = (value: unknown): value is Primitive => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
const only = (record: UnknownRecord, allowed: readonly string[]): boolean => Object.keys(record).every((key) => allowed.includes(key));
const knownModes = new Set<Mode>(["idle", "arena", "adventure_queue", "dungeon", "sailing", "raid_boss", "personal_boss", "polygon", "shop", "unknown"]);
const validText = (value: unknown): value is string => isString(value) && value.trim().length > 0 && value.length <= 160;
function validUrl(value: unknown): boolean { if (!isString(value)) return false; try { return new URL(value).protocol === "https:"; } catch { return false; } }
const validDate = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));

function validateCondition(value: unknown, depth = 0): value is Condition {
  if (depth > MAX_CONDITION_DEPTH || !isRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "equals") return only(value, ["kind", "field", "value"]) && ["freshness", "mode", "health", "progressionKnown", "charges"].includes(String(value.field)) && isPrimitive(value.value);
  if (value.kind === "contains") return only(value, ["kind", "field", "value"]) && (value.field === "rawShape" || value.field === "capabilities") && validText(value.value);
  if (value.kind === "cooldownElapsed") return only(value, ["kind", "name"]) && validText(value.name);
  return value.kind === "all" && only(value, ["kind", "conditions"]) && Array.isArray(value.conditions) && value.conditions.length > 0 && value.conditions.length <= 8 && value.conditions.every((condition) => validateCondition(condition, depth + 1));
}
function validateHandler(value: unknown): value is HandlerDefinition {
  if (!isRecord(value) || !only(value, ["schemaVersion", "handler", "version", "priority", "enabled", "reviewedSourceURL", "verifiedAt", "match", "scope", "precondition", "cost", "action", "postcondition"])) return false;
  if (value.schemaVersion !== HANDLER_VERSION || !validText(value.handler) || !isInteger(value.version) || value.version < 1 || !isInteger(value.priority) || typeof value.enabled !== "boolean" || !validUrl(value.reviewedSourceURL) || !validDate(value.verifiedAt)) return false;
  if (!isRecord(value.match) || !only(value.match, ["role", "text"]) || value.match.role !== "button" || !validText(value.match.text)) return false;
  if (!isRecord(value.scope) || !only(value.scope, ["modes", "requiredMarkers", "deadline"]) || !Array.isArray(value.scope.modes) || value.scope.modes.length === 0 || !value.scope.modes.every((mode) => isString(mode) && mode !== "unknown" && knownModes.has(mode as Mode)) || !Array.isArray(value.scope.requiredMarkers) || value.scope.requiredMarkers.length === 0 || !value.scope.requiredMarkers.every(validText)) return false;
  if (value.scope.deadline !== undefined && (!isRecord(value.scope.deadline) || !only(value.scope.deadline, ["endSecond", "safetyMarginMs"]) || !isInteger(value.scope.deadline.endSecond) || value.scope.deadline.endSecond < 0 || value.scope.deadline.endSecond > 179 || !isInteger(value.scope.deadline.safetyMarginMs) || value.scope.deadline.safetyMarginMs < 0 || value.scope.deadline.safetyMarginMs > 30_000)) return false;
  if (!isRecord(value.cost) || !only(value.cost, ["maxPrana", "maxCharges"]) || !isInteger(value.cost.maxPrana) || value.cost.maxPrana < 0 || value.cost.maxPrana > 1_000_000 || !isInteger(value.cost.maxCharges) || value.cost.maxCharges < 0 || value.cost.maxCharges > 1_000_000) return false;
  if (!isRecord(value.action) || !only(value.action, ["reactionDelayMs", "clickOffsetPx", "clickJigglePx"]) || !Array.isArray(value.action.reactionDelayMs) || value.action.reactionDelayMs.length !== 2 || !value.action.reactionDelayMs.every(isInteger)) return false;
  const [minimum, maximum] = value.action.reactionDelayMs as [number, number];
  if (minimum < 0 || maximum < minimum || maximum > MAX_REACTION_DELAY_MS || !isInteger(value.action.clickOffsetPx) || value.action.clickOffsetPx < 0 || value.action.clickOffsetPx > MAX_CLICK_OFFSET_PX || !isInteger(value.action.clickJigglePx) || value.action.clickJigglePx < 0 || value.action.clickJigglePx > MAX_CLICK_JIGGLE_PX) return false;
  if (!validateCondition(value.precondition) || !isRecord(value.postcondition) || !only(value.postcondition, ["condition", "timeoutMs", "pollIntervalMs"]) || !validateCondition(value.postcondition.condition) || !isInteger(value.postcondition.timeoutMs) || value.postcondition.timeoutMs < 100 || value.postcondition.timeoutMs > MAX_POSTCONDITION_TIMEOUT_MS || !isInteger(value.postcondition.pollIntervalMs) || value.postcondition.pollIntervalMs < 25 || value.postcondition.pollIntervalMs > value.postcondition.timeoutMs) return false;
  // ZPG must be proven by fresh UI data, not only its runtime configuration.
  if (value.handler === "arena.zpg.start" && (!value.scope.modes.includes("idle") || !value.scope.requiredMarkers.some((marker) => marker.toLowerCase().includes("zpg")) || value.scope.deadline?.endSecond !== 179)) return false;
  return true;
}
/** Validates a single definition when it was obtained outside a parsed catalog. */
export function isValidHandlerDefinition(value: unknown): value is HandlerDefinition { return validateHandler(value); }

/** Parses untrusted JSON without evaluating strings, selectors, or expressions. */
export function parseHandlerCatalog(value: unknown): HandlerCatalog {
  if (!isRecord(value) || !only(value, ["schemaVersion", "enabled", "handlers"]) || value.schemaVersion !== HANDLER_CATALOG_VERSION || (value.enabled !== undefined && typeof value.enabled !== "boolean") || !Array.isArray(value.handlers) || value.handlers.length > 100 || !value.handlers.every(validateHandler)) throw new Error("invalid handler catalog");
  const identifiers = new Set<string>();
  for (const handler of value.handlers) { const id = `${handler.handler}@${handler.version}`; if (identifiers.has(id)) throw new Error(`duplicate handler version: ${id}`); identifiers.add(id); }
  return { schemaVersion: HANDLER_CATALOG_VERSION, enabled: value.enabled === true, handlers: value.handlers };
}
export const isHandlerEnabled = (handler: HandlerDefinition): boolean => handler.enabled === true;
export function findEnabledHandler(catalog: HandlerCatalog, handler: string, version: number): HandlerDefinition | undefined {
  if (!catalog.enabled) return undefined;
  const entry = catalog.handlers.find((candidate) => candidate.handler === handler && candidate.version === version);
  return entry && isHandlerEnabled(entry) ? entry : undefined;
}
/** Evaluates the declared condition DSL only; manifests cannot execute code. */
export function evaluateCondition(condition: Condition, observation: ObservationV1, now = new Date()): boolean {
  switch (condition.kind) {
    case "equals": return observation[condition.field] === condition.value;
    case "contains": return observation[condition.field].includes(condition.value as never);
    case "cooldownElapsed": { const expiresAt = observation.cooldowns[condition.name]; return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime(); }
    case "all": return condition.conditions.every((child) => evaluateCondition(child, observation, now));
  }
}
