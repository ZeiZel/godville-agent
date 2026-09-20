import type { AgentDatabase } from "./database.js";
import { normalizeApiPayload, progressionFromApiPayload } from "./api.js";
import type { ProgressionProfile } from "./types.js";

export const PROGRESSION_CACHE_KEY = "progression-profile";
export const PROGRESSION_CACHE_TTL_MS = 15 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 5_000;

interface StoredProgression {
  godName: string;
  fetchedAt?: string;
  lastAttemptAt: string;
  profile?: ProgressionProfile;
}

function readStored(db: AgentDatabase, godName: string): StoredProgression | undefined {
  const row = db.db.prepare("SELECT value,updated_at FROM user_settings WHERE key=? ORDER BY version DESC LIMIT 1").get(PROGRESSION_CACHE_KEY) as { value: string; updated_at: string } | null;
  if (!row) return undefined;
  try {
    const stored = JSON.parse(row.value) as StoredProgression;
    return stored.godName.toLocaleLowerCase() === godName.toLocaleLowerCase() && typeof stored.lastAttemptAt === "string" ? stored : undefined;
  } catch { return undefined; }
}

function writeStored(db: AgentDatabase, stored: StoredProgression): void {
  db.db.prepare("INSERT INTO user_settings(key,version,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(key,version) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(PROGRESSION_CACHE_KEY, 1, JSON.stringify(stored), new Date().toISOString());
}

/** Returns cached public progression and refreshes it at most once per 15 minutes. */
export async function getProgressionProfile(
  db: AgentDatabase,
  godName: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
): Promise<ProgressionProfile | undefined> {
  const now = options.now ?? (() => new Date());
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime()) || !godName.trim()) return undefined;
  const stored = readStored(db, godName);
  const lastAttempt = stored ? new Date(stored.lastAttemptAt).getTime() : NaN;
  const fetchedAt = stored?.fetchedAt ? new Date(stored.fetchedAt).getTime() : NaN;
  if (stored && Number.isFinite(fetchedAt) && current.getTime() >= fetchedAt && current.getTime() - fetchedAt <= PROGRESSION_CACHE_TTL_MS && stored.profile) return stored.profile;
  if (stored && Number.isFinite(lastAttempt) && current.getTime() >= lastAttempt && current.getTime() - lastAttempt < PROGRESSION_CACHE_TTL_MS) {
    return stored.profile ? { ...stored.profile, staleAt: current.toISOString() } : undefined;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const attemptedAt = current.toISOString();
  try {
    const url = new URL(`https://godville.net/gods/api/${encodeURIComponent(godName)}`);
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) {
      writeStored(db, { godName, lastAttemptAt: attemptedAt, ...(stored?.profile ? { profile: stored.profile, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) } : {}) });
      return stored?.profile ? { ...stored.profile, staleAt: attemptedAt } : undefined;
    }
    const payload = await response.json();
    const observation = normalizeApiPayload(payload, godName, false, current.toISOString());
    const profile = observation.progressionKnown ? progressionFromApiPayload(payload) : undefined;
    if (!profile) {
      writeStored(db, { godName, lastAttemptAt: attemptedAt, ...(stored?.profile ? { profile: stored.profile, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) } : {}) });
      return stored?.profile ? { ...stored.profile, staleAt: attemptedAt } : undefined;
    }
    writeStored(db, { godName, fetchedAt: attemptedAt, lastAttemptAt: attemptedAt, profile });
    return profile;
  } catch {
    writeStored(db, { godName, lastAttemptAt: attemptedAt, ...(stored?.profile ? { profile: stored.profile, ...(stored.fetchedAt ? { fetchedAt: stored.fetchedAt } : {}) } : {}) });
    return stored?.profile ? { ...stored.profile, staleAt: attemptedAt } : undefined;
  }
  finally { clearTimeout(timer); }
}
