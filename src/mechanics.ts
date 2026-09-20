export type Point = Readonly<{ x: number; y: number }>;
export type ActionResult =
  | Readonly<{ kind: "NoOp"; reason: string }>
  | Readonly<{ kind: "Observe"; reason: string }>
  | Readonly<{ kind: "Route"; reason: string; target: Point; path: readonly Point[] }>
  | Readonly<{ kind: "Recommend"; reason: string; action: string }>;

export type CellState = "safe" | "wall" | "hazard" | "unknown";
export interface MapCell { point: Point; state: CellState; }
export interface DungeonGoal { point: Point; resource: string; priority: number; }
export interface DungeonInput {
  cells: readonly MapCell[];
  start: Point;
  turn: number;
  previousTurn?: number;
  leader: "self" | "other";
  goals: readonly DungeonGoal[];
  conflictingHints: boolean;
}

export interface SeaInput {
  cells: readonly MapCell[];
  start: Point;
  home: Point;
  foodRemaining: number;
  foodMargin: number;
  loot?: Point;
}

export interface PolygonInput {
  visibleBits?: number;
  requiredBits: number;
  pushLanding: "safe" | "hazard" | "unknown";
  prana?: Readonly<{ current: number; capacity: number }>;
  requiredPrana: number;
  supportedCommands: readonly string[];
}

export interface InventoryItem {
  id: string;
  known: boolean;
  protected: boolean;
  allowedActions: readonly string[];
  requiredPreconditions: readonly string[];
}
export interface InventoryInput {
  item: InventoryItem;
  action: string;
  satisfiedPreconditions: Readonly<Record<string, boolean | undefined>>;
}

const key = ({ x, y }: Point): string => `${x}:${y}`;
const samePoint = (left: Point, right: Point): boolean => left.x === right.x && left.y === right.y;
const neighbors = ({ x, y }: Point): Point[] => [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }];

function indexKnownCells(cells: readonly MapCell[]): Map<string, MapCell> | undefined {
  const byPoint = new Map<string, MapCell>();
  for (const cell of cells) {
    if (!Number.isInteger(cell.point.x) || !Number.isInteger(cell.point.y)) return undefined;
    const existing = byPoint.get(key(cell.point));
    if (existing && existing.state !== cell.state) return undefined;
    byPoint.set(key(cell.point), cell);
  }
  return byPoint;
}

/** Finds a shortest route only through cells explicitly observed as safe. */
export function shortestKnownSafePath(cells: readonly MapCell[], start: Point, target: Point): readonly Point[] | undefined {
  const byPoint = indexKnownCells(cells);
  if (!byPoint) return undefined;
  const startCell = byPoint.get(key(start));
  const targetCell = byPoint.get(key(target));
  if (startCell?.state !== "safe" || targetCell?.state !== "safe") return undefined;
  const queue: Point[] = [start];
  const previous = new Map<string, Point | null>([[key(start), null]]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (samePoint(current, target)) {
      const path: Point[] = [];
      let cursor: Point | null = current;
      while (cursor) {
        path.push(cursor);
        cursor = previous.get(key(cursor)) ?? null;
      }
      return path.reverse();
    }
    for (const next of neighbors(current)) {
      if (previous.has(key(next)) || byPoint.get(key(next))?.state !== "safe") continue;
      previous.set(key(next), current);
      queue.push(next);
    }
  }
  return undefined;
}

export function planDungeon(input: DungeonInput): ActionResult {
  if (input.previousTurn === input.turn) return { kind: "NoOp", reason: "This dungeon turn was already handled." };
  if (input.leader === "other") return { kind: "NoOp", reason: "Another leader controls this dungeon turn." };
  if (input.conflictingHints) return { kind: "Observe", reason: "Dungeon hints conflict; no route is assumed safe." };
  const orderedGoals = [...input.goals].sort((left, right) => right.priority - left.priority || left.resource.localeCompare(right.resource));
  for (const goal of orderedGoals) {
    const path = shortestKnownSafePath(input.cells, input.start, goal.point);
    if (path) return { kind: "Route", target: goal.point, path, reason: `Shortest known-safe route to priority resource ${goal.resource}.` };
  }
  return { kind: "Observe", reason: "No known-safe route to a current dungeon goal." };
}

export function planSeaRoute(input: SeaInput): ActionResult {
  if (!Number.isInteger(input.foodRemaining) || !Number.isInteger(input.foodMargin) || input.foodRemaining < 0 || input.foodMargin < 0) {
    return { kind: "Observe", reason: "Food state is invalid or incomplete." };
  }
  const homePath = shortestKnownSafePath(input.cells, input.start, input.home);
  if (!homePath) return { kind: "Observe", reason: "A known-safe route home is required before sailing further." };
  const homeCost = homePath.length - 1;
  if (homeCost + input.foodMargin > input.foodRemaining) return { kind: "NoOp", reason: "Returning home would exhaust the food safety margin." };
  if (input.loot) {
    const outbound = shortestKnownSafePath(input.cells, input.start, input.loot);
    const returnPath = shortestKnownSafePath(input.cells, input.loot, input.home);
    if (outbound && returnPath) {
      const roundTrip = outbound.length + returnPath.length - 2;
      if (roundTrip + input.foodMargin <= input.foodRemaining) {
        return { kind: "Route", target: input.loot, path: outbound, reason: "Loot has a known-safe return route within the food margin." };
      }
    }
  }
  if (samePoint(input.start, input.home)) return { kind: "NoOp", reason: "No safely returnable loot goal is known." };
  return { kind: "Route", target: input.home, path: homePath, reason: "Return home before pursuing loot without a safe margin." };
}

export function evaluateSeaBattle(useVoice: boolean): ActionResult {
  return useVoice
    ? { kind: "NoOp", reason: "Sea battle recommendations never use a voice." }
    : { kind: "Observe", reason: "Sea battle needs a separately verified tactical observation." };
}

export function evaluatePolygon(input: PolygonInput): ActionResult {
  if (!Number.isInteger(input.requiredBits) || input.requiredBits < 0 || !Number.isFinite(input.requiredPrana) || input.requiredPrana < 0) {
    return { kind: "Observe", reason: "Polygon thresholds are invalid or unknown." };
  }
  if (input.visibleBits === undefined || !Number.isInteger(input.visibleBits) || input.visibleBits < 0) return { kind: "Observe", reason: "Visible polygon bits are unknown." };
  if (!input.prana || !Number.isFinite(input.prana.current) || !Number.isFinite(input.prana.capacity) || input.prana.current < 0 || input.prana.capacity < 0 || input.prana.current > input.prana.capacity) return { kind: "Observe", reason: "Current polygon prana is unknown." };
  if (input.visibleBits < input.requiredBits) return { kind: "NoOp", reason: "Not enough visible bits for a supported polygon action." };
  if (input.pushLanding !== "safe") return { kind: "Observe", reason: "Push landing is not known safe." };
  if (input.prana.current < input.requiredPrana) return { kind: "NoOp", reason: "Known prana is below the required polygon threshold." };
  if (!input.supportedCommands.includes("push")) return { kind: "NoOp", reason: "Push is not in the verified polygon command set." };
  return { kind: "Recommend", action: "polygon:push", reason: "Visible bits, landing, prana, and command support satisfy the polygon policy." };
}

export function evaluateInventory(input: InventoryInput): ActionResult {
  if (!input.item.known) return { kind: "Observe", reason: "Unknown inventory items are never activated." };
  if (input.item.protected) return { kind: "NoOp", reason: "Protected inventory items are not activated or consumed." };
  if (!input.item.allowedActions.includes(input.action)) return { kind: "NoOp", reason: "Requested inventory action is not allowlisted for this item." };
  const missing = input.item.requiredPreconditions.find((condition) => input.satisfiedPreconditions[condition] !== true);
  if (missing) return { kind: "Observe", reason: `Inventory precondition is not confirmed: ${missing}.` };
  return { kind: "Recommend", action: `inventory:${input.action}:${input.item.id}`, reason: "Known allowlisted item has all required preconditions." };
}
