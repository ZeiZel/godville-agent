export interface KnowledgeSource { id: string; url: string; version: string; checkedAt: string; confidence: "official" | "community"; purpose: string; facts: Record<string, string | number | boolean> }
export const KNOWLEDGE_CATALOG_VERSION = "2026-09-20";
export const KNOWLEDGE_CATALOG: KnowledgeSource[] = [
  { id: "rules", url: "https://godville.net/login/rules", version: "2021-12-01", checkedAt: "2026-09-20", confidence: "official", purpose: "automation boundary", facts: { automated_game_actions: false } },
  { id: "api", url: "https://wiki.godville.net/API", version: "curated-2026-09-20", checkedAt: "2026-09-20", confidence: "community", purpose: "read-only API schema", facts: { private_api_poll_min_seconds: 60, observation_schema: "api/v1" } },
  { id: "arena", url: "https://wiki.godville.net/Арена", version: "curated-2026-09-20", checkedAt: "2026-09-20", confidence: "community", purpose: "ZPG arena timing", facts: { zpg_window_seconds: 180, zpg_confirmed_cooldown_hours: 4, zpg_no_charge_reward_assumption: true } },
  { id: "progression", url: "https://godville.net/blog/post/298", version: "298", checkedAt: "2026-09-20", confidence: "official", purpose: "reliquary progression", facts: { temple_bricks: 1000, ark_logs: 1000, pairs_required: 1000, book_words: 1000, souls_required: 5000, pension_target: 30000000 } },
  { id: "budget_policy", url: "local://user-config", version: "1", checkedAt: "2026-09-20", confidence: "official", purpose: "owner-configured charge guardrails", facts: { reserve_charges: 100, max_charges_per_day: 2, max_charges_per_rolling_7d: 10, max_charges_per_expedition: 1 } },
];
