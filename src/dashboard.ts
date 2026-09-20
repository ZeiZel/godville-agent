import { Database } from "bun:sqlite";
import { existsSync, fstatSync, openSync, closeSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { DASHBOARD_HTML } from "./dashboard-page.js";

const STDOUT_LIMIT = 128 * 1024;
const STDERR_LIMIT = 16 * 1024;
const MAX_ROWS = 40;
const DEFAULT_RESERVE = 100;

type DashboardObservation = {
  observedAt?: string;
  heroId?: string;
  health?: string;
  healthPercent?: number;
  prana?: { current?: number; capacity?: number };
  charges?: number;
  mode?: string;
  freshness?: string;
};

export interface DashboardStatus {
  generatedAt: string;
  freshness: "fresh" | "stale" | "unknown";
  identity: { heroId?: string };
  resources: {
    healthPercent?: number;
    health?: string;
    prana?: number;
    pranaCapacity?: number;
    charges?: number;
    reserveCharges: number;
  };
  counts: { confirmed: number; ambiguous: number };
  latestObservation?: {
    observedAt?: string;
    mode?: string;
    health?: string;
    healthPercent?: number;
    prana?: number;
    charges?: number;
  };
  operations: Array<{
    at: string;
    action?: string;
    state: string;
    reason?: string;
    result?: string;
  }>;
  cycles: Array<{ at?: string; event: string; action?: string; state?: string; reason?: string }>;
  logCycles: Array<{ at?: string; event: string; action?: string; state?: string; reason?: string }>;
  logs: { stdout: string[]; stderr: string[] };
}

export interface DashboardOptions {
  dataDir: string;
  logDir?: string;
  reserveCharges?: number;
  now?: () => Date;
}

function tail(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    if (!existsSync(path)) return "";
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(limit, size);
    const bytes = new Uint8Array(length);
    readSync(fd, bytes, 0, length, Math.max(0, size - length));
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function safeText(value: unknown, limit = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/(?:\/Users|\/private|[A-Za-z]:\\)[^\s]*/g, "[path]").slice(0, limit);
}

function logEvents(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-MAX_ROWS).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const event = safeText(value.event ?? value.type);
      if (!event) return [];
      const message = safeText(value.reason ?? value.message ?? value.state);
      return [message ? `${event}: ${message}` : event];
    } catch {
      const plain = safeText(line);
      return plain ? [plain] : [];
    }
  });
}

function observationFrom(value: unknown): DashboardObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const pranaValue = object.prana && typeof object.prana === "object" ? object.prana as Record<string, unknown> : undefined;
  const finite = (item: unknown): number | undefined => typeof item === "number" && Number.isFinite(item) ? item : undefined;
  const healthPercent = finite(object.healthPercent);
  const charges = finite(object.charges);
  const pranaCurrent = finite(pranaValue?.current);
  const pranaCapacity = finite(pranaValue?.capacity);
  return {
    ...(typeof object.observedAt === "string" ? { observedAt: object.observedAt } : {}),
    ...(typeof object.heroId === "string" ? { heroId: object.heroId } : {}),
    ...(typeof object.health === "string" ? { health: object.health } : {}),
    ...(healthPercent !== undefined ? { healthPercent } : {}),
    ...(pranaValue ? { prana: { ...(pranaCurrent !== undefined ? { current: pranaCurrent } : {}), ...(pranaCapacity !== undefined ? { capacity: pranaCapacity } : {}) } } : {}),
    ...(charges !== undefined ? { charges } : {}),
    ...(typeof object.mode === "string" ? { mode: object.mode } : {}),
    ...(typeof object.freshness === "string" ? { freshness: object.freshness } : {}),
  };
}

function statusFromObservation(observation: DashboardObservation | undefined, now: Date): "fresh" | "stale" | "unknown" {
  if (!observation?.observedAt) return "unknown";
  if (observation.freshness === "stale" || observation.freshness === "expired") return "stale";
  if (observation.freshness === "unknown" || observation.freshness === "auth_degraded") return "unknown";
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at)) return "unknown";
  const age = now.getTime() - at;
  if (age < 0) return "unknown";
  return age <= 180_000 ? "fresh" : "stale";
}

export function readDashboardStatus(options: DashboardOptions): DashboardStatus {
  const now = (options.now ?? (() => new Date()))();
  const reserveCharges = Math.max(DEFAULT_RESERVE, options.reserveCharges ?? DEFAULT_RESERVE);
  const result: DashboardStatus = {
    generatedAt: now.toISOString(), freshness: "unknown", identity: {},
    resources: { reserveCharges }, counts: { confirmed: 0, ambiguous: 0 }, operations: [], cycles: [],
    logs: { stdout: [], stderr: [] }, logCycles: [],
  };
  const dbPath = join(resolve(options.dataDir), "godville.sqlite");
  if (existsSync(dbPath)) {
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, create: false });
      const row = db.prepare("SELECT observed_at, payload FROM observations ORDER BY observed_at DESC LIMIT 1").get() as { observed_at: string; payload: string } | null;
      const observation = row ? observationFrom(JSON.parse(row.payload)) : undefined;
      result.freshness = statusFromObservation(observation, now);
      if (observation) {
        const heroId = safeText(observation.heroId, 80);
        if (heroId !== undefined) result.identity.heroId = heroId;
        const mode = safeText(observation.mode);
        const healthValue = safeText(observation.health);
        result.latestObservation = {
          ...(observation.observedAt ? { observedAt: observation.observedAt } : {}),
          ...(mode ? { mode } : {}),
          ...(healthValue ? { health: healthValue } : {}),
          ...(observation.healthPercent !== undefined ? { healthPercent: observation.healthPercent } : {}),
          ...(observation.prana?.current !== undefined ? { prana: observation.prana.current } : {}),
          ...(observation.charges !== undefined ? { charges: observation.charges } : {}),
        };
        if (observation.healthPercent !== undefined) result.resources.healthPercent = observation.healthPercent;
        if (healthValue !== undefined) result.resources.health = healthValue;
        if (observation.prana?.current !== undefined) result.resources.prana = observation.prana.current;
        if (observation.prana?.capacity !== undefined) result.resources.pranaCapacity = observation.prana.capacity;
        if (observation.charges !== undefined) result.resources.charges = observation.charges;
      }
      const counts = db.prepare("SELECT state, COUNT(*) AS count FROM operations WHERE state IN ('CONFIRMED','AMBIGUOUS') GROUP BY state").all() as Array<{ state: string; count: number }>;
      for (const count of counts) if (count.state === "CONFIRMED") result.counts.confirmed = Number(count.count); else if (count.state === "AMBIGUOUS") result.counts.ambiguous = Number(count.count);
      const rows = db.prepare("SELECT o.created_at, o.handler, o.state, o.result, d.payload AS decision_payload FROM operations o LEFT JOIN decisions d ON d.id=o.decision_id ORDER BY o.created_at DESC LIMIT 40").all() as Array<{ created_at: string; handler: string; state: string; result?: string; decision_payload?: string }>;
      result.operations = rows.map((item) => {
        let decision: Record<string, unknown> = {};
        try { decision = item.decision_payload ? JSON.parse(item.decision_payload) as Record<string, unknown> : {}; } catch { /* malformed audit row */ }
        const action = safeText(decision.action ?? item.handler, 100);
        const reason = safeText(decision.reason);
        const resultText = safeText(item.result);
        return { at: item.created_at, state: item.state, ...(action ? { action } : {}), ...(reason ? { reason } : {}), ...(resultText ? { result: resultText } : {}) };
      });
    } catch { /* missing or malformed DB is represented by an empty status */ }
    finally { db?.close(); }
  }
  const logDir = resolve(options.logDir ?? join(options.dataDir, "automation", "logs"));
  const stdoutText = tail(join(logDir, "agent.stdout.log"), STDOUT_LIMIT);
  const stderrText = tail(join(logDir, "agent.stderr.log"), STDERR_LIMIT);
  result.logs.stdout = logEvents(stdoutText);
  result.logs.stderr = logEvents(stderrText);
  result.logCycles = stdoutText.split(/\r?\n/).filter(Boolean).slice(-MAX_ROWS).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const event = safeText(value.event ?? value.type, 80);
      if (!event) return [];
      const initial = value.initial && typeof value.initial === "object" ? value.initial as Record<string, unknown> : undefined;
      const sequence = value.sequence && typeof value.sequence === "object" ? value.sequence as Record<string, unknown> : undefined;
      const outcome = value.result && typeof value.result === "object" ? value.result as Record<string, unknown> : undefined;
      const completed = Array.isArray(outcome?.completed) ? outcome.completed.find((item): item is string => typeof item === "string") : undefined;
      const commands = Array.isArray(sequence?.commands) ? sequence.commands.find((item): item is string => typeof item === "string") : undefined;
      const action = safeText(value.action ?? completed ?? commands, 100);
      const state = safeText(value.state ?? outcome?.state, 40);
      const reason = safeText(value.reason ?? outcome?.reason);
      const at = safeText(value.at ?? initial?.observedAt ?? value.observedAt, 40);
      return [{ event, ...(action ? { action } : {}), ...(state ? { state } : {}), ...(reason ? { reason } : {}), ...(at ? { at } : {}) }];
    } catch { return []; }
  });
  result.cycles = result.logCycles;
  return result;
}

function allowedHost(request: Request, port: number): boolean {
  const host = request.headers.get("host")?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      && parsed.port === String(port);
  } catch { return false; }
}

export function createDashboardServer(options: DashboardOptions & { port?: number; html?: string }): Bun.Server<unknown> {
  const port = options.port ?? 3210;
  const html = options.html ?? DASHBOARD_HTML;
  return Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
    if (!allowedHost(request, port)) return new Response("forbidden", { status: 403 });
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (url.pathname === "/api/status") return Response.json(readDashboardStatus(options), { headers: { "cache-control": "no-store" } });
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  }});
}
