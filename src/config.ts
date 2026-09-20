import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BUDGET, type RuntimeConfig } from "./types.js";

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadConfig(env = process.env): RuntimeConfig {
  const dataDir = resolve(env.GODVILLE_DATA_DIR ?? "./data");
  const mode = env.GODVILLE_MODE === "browser" ? "browser" : "advisor";
  const browserEnabled = env.GODVILLE_BROWSER_ENABLED === "true";
  if (mode === "browser" && !browserEnabled) throw new Error("browser mode requires GODVILLE_BROWSER_ENABLED=true");
  const reserveCharges = intEnv(env, "GODVILLE_RESERVE_CHARGES", DEFAULT_BUDGET.reserveCharges);
  const tokenFile = env.GODVILLE_TOKEN_FILE;
  const manifestFile = env.GODVILLE_BROWSER_MANIFEST;
  const stateDir = env.GODVILLE_BROWSER_STATE_DIR;
  const livePolicyFile = env.GODVILLE_LIVE_POLICY_FILE;
  return {
    dataDir,
    mode,
    ...(env.GODVILLE_GOD_NAME ? { api: { godName: env.GODVILLE_GOD_NAME, ...(tokenFile ? { tokenFile } : {}), intervalSeconds: Math.max(60, intEnv(env, "GODVILLE_API_INTERVAL_SECONDS", 75)) } } : {}),
    budget: {
      reserveCharges,
      maxChargesPerDay: intEnv(env, "GODVILLE_MAX_CHARGES_PER_DAY", DEFAULT_BUDGET.maxChargesPerDay),
      maxChargesPerRolling7d: intEnv(env, "GODVILLE_MAX_CHARGES_PER_7D", DEFAULT_BUDGET.maxChargesPerRolling7d),
      maxChargesPerExpedition: intEnv(env, "GODVILLE_MAX_CHARGES_PER_EXPEDITION", DEFAULT_BUDGET.maxChargesPerExpedition),
    },
    zpg: { enabled: env.GODVILLE_ZPG_ENABLED === "true", confirmation: env.GODVILLE_ZPG_CONFIRMATION === "true", minOffsetSeconds: intEnv(env, "GODVILLE_ZPG_MIN_OFFSET_SECONDS", 5), maxOffsetSeconds: intEnv(env, "GODVILLE_ZPG_MAX_OFFSET_SECONDS", 160) },
    ...(livePolicyFile ? { livePolicyFile: resolve(livePolicyFile) } : {}),
    browser: {
      enabled: browserEnabled,
      ...(manifestFile ? { manifestFile } : {}),
      ...(stateDir ? { stateDir: resolve(stateDir) } : {}),
      headless: env.GODVILLE_BROWSER_HEADLESS !== "false",
      allowRemoteUrl: env.GODVILLE_BROWSER_ALLOW_REMOTE === "true",
    },
  };
}

export function readTokenFromFile(file?: string): string | undefined {
  if (!file) return undefined;
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error("token file is empty");
  return token;
}
