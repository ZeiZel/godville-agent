import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BudgetPolicy, Decision, ObservationV1 } from "./types.js";
import type { KnowledgeSource } from "./knowledge.js";

export type OperationState = "PLANNED" | "SKIPPED" | "EXECUTED" | "CONFIRMED" | "AMBIGUOUS" | "FAILED";
export interface StoredOperation { id: string; intentKey: string; handler: string; handlerVersion: number; state: OperationState; }
const validDate = (value: Date): boolean => Number.isFinite(value.getTime());

export class AgentDatabase {
  readonly db: Database;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "godville.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, source TEXT NOT NULL, schema_version TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge (id TEXT NOT NULL, url TEXT NOT NULL, checked_at TEXT NOT NULL, version TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id, version));
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, observation_id TEXT, knowledge_version TEXT NOT NULL, rule_version TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(observation_id, rule_version));
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, intent_key TEXT NOT NULL UNIQUE, decision_id TEXT, handler TEXT NOT NULL, handler_version INTEGER NOT NULL, precondition TEXT NOT NULL, postcondition TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PLANNED','SKIPPED','EXECUTED','CONFIRMED','AMBIGUOUS','FAILED')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS cooldowns (name TEXT PRIMARY KEY, confirmed_at TEXT NOT NULL, expires_at TEXT NOT NULL, operation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS charge_ledger (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('BALANCE','RESERVE','CONFIRM','CANCEL','RECONCILE')), charges INTEGER NOT NULL, decision_id TEXT, operation_id TEXT, expedition TEXT, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handler_catalog (handler TEXT NOT NULL, version INTEGER NOT NULL, priority INTEGER NOT NULL, payload TEXT NOT NULL, verified_at TEXT, PRIMARY KEY(handler,version));
      CREATE TABLE IF NOT EXISTS user_settings (key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(key, version));
      CREATE TABLE IF NOT EXISTS user_priorities (version INTEGER PRIMARY KEY, priorities TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL, expires_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reserve_per_decision ON charge_ledger(decision_id) WHERE kind='RESERVE';
      CREATE UNIQUE INDEX IF NOT EXISTS resolution_per_decision ON charge_ledger(decision_id) WHERE kind IN ('CONFIRM','CANCEL');
      INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
  }
  integrityCheck(): boolean { return (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok"; }
  close(): void { this.db.close(); }
  backupTo(destination: string): void { this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
  saveObservation(observation: ObservationV1, source = "api"): string {
    const payload = JSON.stringify(observation);
    const hash = createHash("sha256").update(payload).digest("hex");
    const existing = this.db.prepare("SELECT id FROM observations WHERE content_hash=?").get(hash) as { id: string } | null;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO observations(id,observed_at,source,schema_version,content_hash,payload) VALUES(?,?,?,?,?,?)").run(id, observation.observedAt, source, observation.version, hash, payload);
    return id;
  }
  saveKnowledge(source: KnowledgeSource): void {
    const priority = source.confidence === "official" ? 3 : 2;
    this.db.prepare("INSERT OR IGNORE INTO knowledge(id,url,checked_at,version,priority,status,payload) VALUES(?,?,?,?,?,?,?)").run(source.id, source.url, source.checkedAt, source.version, priority, "active", JSON.stringify(source));
  }
  saveHandler(handler: string, version: number, priority: number, definition: unknown, verifiedAt?: string): void {
    this.db.prepare("INSERT OR IGNORE INTO handler_catalog(handler,version,priority,payload,verified_at) VALUES(?,?,?,?,?)").run(handler, version, priority, JSON.stringify(definition), verifiedAt ?? null);
  }
  setUserSetting(key: string, version: number, value: unknown): void { this.db.prepare("INSERT OR IGNORE INTO user_settings(key,version,value,updated_at) VALUES(?,?,?,?)").run(key, version, JSON.stringify(value), new Date().toISOString()); }
  upsertUserSetting(key: string, version: number, value: unknown, now = new Date()): void { this.db.prepare("INSERT INTO user_settings(key,version,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(key,version) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, version, JSON.stringify(value), now.toISOString()); }
  getUserSetting<T>(key: string, version: number): T | undefined { const row = this.db.prepare("SELECT value FROM user_settings WHERE key=? AND version=?").get(key, version) as { value: string } | null; if (!row) return undefined; try { return JSON.parse(row.value) as T; } catch { return undefined; } }
  liveMissionId(godName: string): string {
    const key = "live-mission";
    const current = this.getUserSetting<{ godName?: string; id?: string }>(key, 1);
    if (current?.godName?.toLocaleLowerCase() === godName.toLocaleLowerCase() && typeof current.id === "string" && current.id) return current.id;
    const id = randomUUID();
    this.upsertUserSetting(key, 1, { godName, id });
    return id;
  }
  rotateLiveMission(godName: string): string { const id = randomUUID(); this.upsertUserSetting("live-mission", 1, { godName, id }); return id; }
  savePriorities(version: number, priorities: string[]): void { this.db.prepare("INSERT OR IGNORE INTO user_priorities(version,priorities,created_at) VALUES(?,?,?)").run(version, JSON.stringify(priorities), new Date().toISOString()); }
  latestPriorities(): string[] | undefined { const row = this.db.prepare("SELECT priorities FROM user_priorities ORDER BY version DESC LIMIT 1").get() as { priorities: string } | null; return row ? JSON.parse(row.priorities) as string[] : undefined; }
  acquireLease(name: string, owner: string, ttlMs: number, now = new Date()): boolean {
    if (!name || !owner || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !validDate(now)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT fencing_token,expires_at FROM leases WHERE name=?").get(name) as { fencing_token: number; expires_at: string } | null;
      if (prior && prior.expires_at > now.toISOString()) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO leases(name,owner,fencing_token,expires_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at").run(name, owner, Number(prior?.fencing_token ?? 0) + 1, new Date(now.getTime() + ttlMs).toISOString());
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  leaseToken(name: string, owner: string): number | undefined {
    const row = this.db.prepare("SELECT fencing_token FROM leases WHERE name=? AND owner=?").get(name, owner) as { fencing_token: number } | null;
    return row ? Number(row.fencing_token) : undefined;
  }
  renewLease(name: string, owner: string, fencingToken: number, ttlMs: number, now = new Date()): boolean {
    if (!Number.isSafeInteger(fencingToken) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !validDate(now)) return false;
    const changed = this.db.prepare("UPDATE leases SET expires_at=? WHERE name=? AND owner=? AND fencing_token=? AND expires_at>?").run(new Date(now.getTime() + ttlMs).toISOString(), name, owner, fencingToken, now.toISOString());
    return Number(changed.changes) === 1;
  }
  hasLease(name: string, owner: string, fencingToken: number, now = new Date()): boolean {
    if (!validDate(now)) return false;
    return this.db.prepare("SELECT 1 FROM leases WHERE name=? AND owner=? AND fencing_token=? AND expires_at>?").get(name, owner, fencingToken, now.toISOString()) != null;
  }
  releaseLease(name: string, owner: string, fencingToken?: number): void {
    if (fencingToken === undefined) this.db.prepare("DELETE FROM leases WHERE name=? AND owner=?").run(name, owner);
    else this.db.prepare("DELETE FROM leases WHERE name=? AND owner=? AND fencing_token=?").run(name, owner, fencingToken);
  }
  saveDecision(decision: Decision, observationId: string | undefined, knowledgeVersion: string, ruleVersion: string): string {
    const prior = observationId ? this.db.prepare("SELECT id FROM decisions WHERE observation_id=? AND rule_version=?").get(observationId, ruleVersion) as { id: string } | null : undefined;
    if (prior) return prior.id;
    const id = decision.id;
    this.db.prepare("INSERT INTO decisions(id,created_at,observation_id,knowledge_version,rule_version,payload) VALUES(?,?,?,?,?,?)").run(id, new Date().toISOString(), observationId ?? null, knowledgeVersion, ruleVersion, JSON.stringify(decision));
    return id;
  }
  createOperation(intentKey: string, decisionId: string | undefined, handler: string, handlerVersion: number, precondition: unknown, postcondition: unknown): StoredOperation {
    const existing = this.db.prepare("SELECT id,intent_key as intentKey,handler,handler_version as handlerVersion,state FROM operations WHERE intent_key=?").get(intentKey) as StoredOperation | null;
    if (existing) return existing;
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO operations(id,intent_key,decision_id,handler,handler_version,precondition,postcondition,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, intentKey, decisionId ?? null, handler, handlerVersion, JSON.stringify(precondition), JSON.stringify(postcondition), "PLANNED", now, now);
    return this.db.prepare("SELECT id,intent_key as intentKey,handler,handler_version as handlerVersion,state FROM operations WHERE intent_key=?").get(intentKey) as unknown as StoredOperation;
  }
  transitionOperation(id: string, from: OperationState, to: OperationState, result?: string): boolean {
    const changed = this.db.prepare("UPDATE operations SET state=?,result=?,updated_at=? WHERE id=? AND state=?").run(to, result ?? null, new Date().toISOString(), id, from);
    return changed.changes === 1;
  }
  /** An EXECUTED or AMBIGUOUS handler outcome may have reached the game; never issue a new intent before reconciliation. */
  hasUnresolvedOperation(handler: string): boolean {
    return this.db.prepare("SELECT 1 FROM operations WHERE handler=? AND state IN ('EXECUTED','AMBIGUOUS') LIMIT 1").get(handler) != null;
  }
  operation(id: string): StoredOperation | undefined { return this.db.prepare("SELECT id,intent_key as intentKey,handler,handler_version as handlerVersion,state FROM operations WHERE id=?").get(id) as StoredOperation | undefined; }
  latestUnresolvedOperation(handler: string): StoredOperation | undefined { return this.db.prepare("SELECT id,intent_key as intentKey,handler,handler_version as handlerVersion,state FROM operations WHERE handler=? AND state IN ('EXECUTED','AMBIGUOUS') ORDER BY updated_at DESC LIMIT 1").get(handler) as StoredOperation | undefined; }
  operationBelongsToAccount(id: string, godName: string): boolean {
    return this.db.prepare("SELECT 1 FROM operations o JOIN observations obs ON json_extract(o.precondition,'$.finalObservationId')=obs.id WHERE o.id=? AND lower(json_extract(obs.payload,'$.heroId'))=lower(?)").get(id, godName) != null;
  }
  expireUnresolvedWithoutReservations(before: string, eventId: string, handlers: readonly string[], account?: string, result = "verified lifecycle transition expired old zero-charge action"): number {
    if (!handlers.length || !eventId || !Number.isFinite(Date.parse(before))) return 0;
    const placeholders = handlers.map(() => "?").join(",");
    return Number(this.db.prepare(`UPDATE operations SET state='FAILED',result=?,updated_at=? WHERE state IN ('EXECUTED','AMBIGUOUS') AND created_at<=? AND handler IN (${placeholders}) AND EXISTS (SELECT 1 FROM observations obs WHERE json_extract(operations.precondition,'$.finalObservationId')=obs.id AND lower(json_extract(obs.payload,'$.heroId'))=lower(?) AND (json_extract(obs.payload,'$.battleId')=? OR json_extract(obs.payload,'$.eventId')=? OR json_extract(obs.payload,'$.eventId') LIKE ? OR (operations.handler='hero.encourage' AND json_extract(obs.payload,'$.mode')='idle'))) AND NOT EXISTS (SELECT 1 FROM charge_ledger WHERE kind='RESERVE' AND operation_id=operations.id)`).run(result, new Date().toISOString(), before, ...handlers, account ?? "", eventId, eventId, `godville-dungeon-turn:${eventId}:%`).changes);
  }
  recoverUncertainOperations(leaseName?: string, owner?: string, fencingToken?: number, now = new Date()): number {
    if (!leaseName || !owner || fencingToken === undefined || !this.hasLease(leaseName, owner, fencingToken, now)) return 0;
    return Number(this.db.prepare("UPDATE operations SET state='AMBIGUOUS',updated_at=? WHERE state='EXECUTED'").run(now.toISOString()).changes);
  }
  isCooldownActive(name: string, now: Date): boolean { return this.db.prepare("SELECT 1 FROM cooldowns WHERE name=? AND expires_at>? ").get(name, now.toISOString()) != null; }
  cooldownOperationId(name: string): string | undefined { const row = this.db.prepare("SELECT operation_id FROM cooldowns WHERE name=?").get(name) as { operation_id: string } | null; return row?.operation_id; }
  confirmCooldown(name: string, operationId: string, expiresAt: Date): void { this.db.prepare("INSERT INTO cooldowns(name,confirmed_at,expires_at,operation_id) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET confirmed_at=excluded.confirmed_at,expires_at=excluded.expires_at,operation_id=excluded.operation_id").run(name, new Date().toISOString(), expiresAt.toISOString(), operationId); }
  /** Releases a verified terminal live context. Callers must not use this for uncertain actions. */
  clearCooldown(name: string): void { if (name) this.db.prepare("DELETE FROM cooldowns WHERE name=?").run(name); }
  importBalance(charges: number, note = "manual reconciliation", now = new Date()): boolean {
    if (!Number.isSafeInteger(charges) || charges < 0 || !note || !validDate(now)) return false;
    this.db.prepare("INSERT INTO charge_ledger(id,created_at,kind,charges,note) VALUES(?,?,?,?,?)").run(randomUUID(), now.toISOString(), "BALANCE", charges, note);
    return true;
  }
  currentBalance(): number | undefined {
    const row = this.db.prepare("SELECT charges FROM charge_ledger WHERE kind='BALANCE' ORDER BY rowid DESC LIMIT 1").get() as { charges: number } | null;
    return row ? Number(row.charges) : undefined;
  }
  reservedCharges(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(r.charges),0) total FROM charge_ledger r WHERE r.kind='RESERVE' AND NOT EXISTS (SELECT 1 FROM charge_ledger x WHERE x.decision_id=r.decision_id AND x.kind IN ('CONFIRM','CANCEL'))").get() as { total: number };
    return Number(row.total);
  }
  private chargesInWindow(since: string, expedition?: string): number {
    const scope = expedition === undefined ? "" : " AND r.expedition=?";
    const active = this.db.prepare(`SELECT COALESCE(SUM(r.charges),0) total FROM charge_ledger r WHERE r.kind='RESERVE'${scope} AND NOT EXISTS (SELECT 1 FROM charge_ledger x WHERE x.decision_id=r.decision_id AND x.kind IN ('CONFIRM','CANCEL'))`).get(...(expedition === undefined ? [] : [expedition])) as { total: number };
    const confirmed = this.db.prepare(`SELECT COALESCE(SUM(x.charges),0) total FROM charge_ledger x JOIN charge_ledger r ON r.decision_id=x.decision_id AND r.kind='RESERVE' WHERE x.kind='CONFIRM' AND x.created_at>=?${expedition === undefined ? "" : " AND r.expedition=?"}`).get(...(expedition === undefined ? [since] : [since, expedition])) as { total: number };
    return Number(active.total) + Number(confirmed.total);
  }
  availableCharges(): number | undefined {
    const balanceRow = this.db.prepare("SELECT rowid,charges FROM charge_ledger WHERE kind='BALANCE' ORDER BY rowid DESC LIMIT 1").get() as { rowid: number; charges: number } | null;
    if (!balanceRow) return undefined;
    const confirmed = this.db.prepare("SELECT COALESCE(SUM(charges),0) total FROM charge_ledger WHERE kind='CONFIRM' AND rowid>?").get(balanceRow.rowid) as { total: number };
    return Number(balanceRow.charges) - Number(confirmed.total) - this.reservedCharges();
  }
  reserveCharges(decisionId: string, operationId: string, charges: number, policy: BudgetPolicy, expedition?: string, now = new Date()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!decisionId || !operationId || !Number.isSafeInteger(charges) || charges <= 0 || !this.validPolicy(policy) || !validDate(now) || (expedition !== undefined && !expedition)) { this.db.exec("ROLLBACK"); return false; }
      const existing = this.db.prepare("SELECT charges,operation_id FROM charge_ledger WHERE kind='RESERVE' AND decision_id=?").get(decisionId) as { charges: number; operation_id: string } | null;
      if (existing) {
        const resolved = this.db.prepare("SELECT 1 FROM charge_ledger WHERE decision_id=? AND kind IN ('CONFIRM','CANCEL')").get(decisionId);
        const repeat = !resolved && Number(existing.charges) === charges && existing.operation_id === operationId;
        this.db.exec(repeat ? "COMMIT" : "ROLLBACK"); return repeat;
      }
      const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
      const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const available = this.availableCharges();
      if (available === undefined || available - charges < Math.max(100, policy.reserveCharges) || this.chargesInWindow(day.toISOString()) + charges > policy.maxChargesPerDay || this.chargesInWindow(week.toISOString()) + charges > policy.maxChargesPerRolling7d || (expedition !== undefined && this.chargesInWindow(day.toISOString(), expedition) + charges > policy.maxChargesPerExpedition)) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO charge_ledger(id,created_at,kind,charges,decision_id,operation_id,expedition,note) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), now.toISOString(), "RESERVE", charges, decisionId, operationId, expedition ?? null, "reserved before action");
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  resolveReservation(decisionId: string, operationId: string, state: "CONFIRM" | "CANCEL", now = new Date()): boolean {
    if (!decisionId || !operationId || (state !== "CONFIRM" && state !== "CANCEL") || !validDate(now)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const reserved = this.db.prepare("SELECT charges,operation_id FROM charge_ledger WHERE kind='RESERVE' AND decision_id=?").get(decisionId) as { charges: number; operation_id: string } | null;
      if (!reserved || reserved.operation_id !== operationId) { this.db.exec("ROLLBACK"); return false; }
      const resolved = this.db.prepare("SELECT kind,operation_id FROM charge_ledger WHERE kind IN ('CONFIRM','CANCEL') AND decision_id=?").get(decisionId) as { kind: "CONFIRM" | "CANCEL"; operation_id: string } | null;
      if (resolved) {
        const repeat = resolved.kind === state && resolved.operation_id === operationId;
        this.db.exec(repeat ? "COMMIT" : "ROLLBACK"); return repeat;
      }
      this.db.prepare("INSERT INTO charge_ledger(id,created_at,kind,charges,decision_id,operation_id,note) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), now.toISOString(), state, reserved.charges, decisionId, operationId, state.toLowerCase());
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private validPolicy(policy: BudgetPolicy): boolean {
    return [policy.reserveCharges, policy.maxChargesPerDay, policy.maxChargesPerRolling7d, policy.maxChargesPerExpedition].every((value) => Number.isSafeInteger(value) && value >= 0);
  }
}
