import type { Capability } from "./types.js";
export interface Stage { id: Capability; requires: Capability[]; next: Capability[]; metric: string }
export const STAGES: Stage[] = [
  { id: "temple", requires: [], next: ["ark", "pension"], metric: "gold_bricks/1000" },
  { id: "ark", requires: ["temple"], next: ["pairs"], metric: "gopher_logs/1000" },
  { id: "pairs", requires: ["ark"], next: ["laboratory"], metric: "creature_pairs/1000" },
  { id: "laboratory", requires: ["pairs"], next: ["personal_boss"], metric: "boss_parts" },
  { id: "personal_boss", requires: ["laboratory"], next: ["book"], metric: "boss_power" },
  { id: "book", requires: ["personal_boss"], next: ["souls"], metric: "book_words/1000" },
  { id: "souls", requires: ["book"], next: ["reliquary"], metric: "souls/5000" },
  { id: "pension", requires: ["temple"], next: ["shop"], metric: "retirement_deposited/30000000" },
  { id: "shop", requires: ["pension"], next: ["reliquary"], metric: "merchant_level" },
  { id: "reliquary", requires: ["shop", "souls"], next: [], metric: "relics_found" },
];
export function availableStages(capabilities: Capability[]): Stage[] { return STAGES.filter((s) => !capabilities.includes(s.id) && s.requires.every((r) => capabilities.includes(r))); }
