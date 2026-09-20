import type { AgentDatabase } from "./database.js";

export type ArenaTurnGroup = "influence" | "voice";

function validText(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256; }
function validTurn(turn: number): boolean { return Number.isSafeInteger(turn) && turn >= 0; }
function validInput(heroId: string, battleId: string, turn: number, group: ArenaTurnGroup, operationId: string): boolean {
  return validText(heroId) && validText(battleId) && validTurn(turn)
    && (group === "influence" || group === "voice") && validText(operationId);
}
function accountId(heroId: string): string { return heroId.toLocaleLowerCase(); }

function ensureTable(db: AgentDatabase): void {
  db.db.exec(`CREATE TABLE IF NOT EXISTS arena_turn_claims (
    hero_id TEXT NOT NULL,
    battle_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    group_name TEXT NOT NULL CHECK(group_name IN ('influence','voice')),
    operation_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY(hero_id, battle_id, turn, group_name)
  );`);
}

/** Atomically claims one ordinary-arena action group for one observed turn. */
export function claimArenaTurn(db: AgentDatabase, heroId: string, battleId: string, turn: number, group: ArenaTurnGroup, operationId: string): boolean {
  if (!validInput(heroId, battleId, turn, group, operationId)) return false;
  ensureTable(db);
  const result = db.db.prepare("INSERT OR IGNORE INTO arena_turn_claims(hero_id,battle_id,turn,group_name,operation_id,claimed_at) VALUES(?,?,?,?,?,?)")
    .run(accountId(heroId), battleId, turn, group, operationId, new Date().toISOString());
  return Number(result.changes) === 1;
}

/** Read-only planner gate for a previously claimed group. */
export function isArenaTurnClaimed(db: AgentDatabase, heroId: string, battleId: string, turn: number, group: ArenaTurnGroup): boolean {
  if (!validText(heroId) || !validText(battleId) || !validTurn(turn) || (group !== "influence" && group !== "voice")) return false;
  ensureTable(db);
  return db.db.prepare("SELECT 1 FROM arena_turn_claims WHERE hero_id=? AND battle_id=? AND turn=? AND group_name=? LIMIT 1")
    .get(accountId(heroId), battleId, turn, group) !== null;
}

/** Releases a claim only when the caller explicitly proves that no click occurred. */
export function releaseArenaTurnForUnclicked(db: AgentDatabase, heroId: string, battleId: string, turn: number, group: ArenaTurnGroup, operationId: string, knownUnclicked: boolean): boolean {
  if (!knownUnclicked || !validInput(heroId, battleId, turn, group, operationId)) return false;
  ensureTable(db);
  const result = db.db.prepare("DELETE FROM arena_turn_claims WHERE hero_id=? AND battle_id=? AND turn=? AND group_name=? AND operation_id=?")
    .run(accountId(heroId), battleId, turn, group, operationId);
  return Number(result.changes) === 1;
}
