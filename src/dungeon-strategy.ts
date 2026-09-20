export type DungeonDirection = "north" | "south" | "east" | "west";

export interface DungeonCell {
  x: number;
  y: number;
  text: string;
  title: string;
  wall: boolean;
  unknown: boolean;
}

export interface DungeonMap {
  cells: DungeonCell[];
  legalMoves: Array<{ direction: DungeonDirection; x: number; y: number }>;
  position: { x: number; y: number };
  turn: number;
  battleId: string;
  otherGodDirected: boolean;
  treasureCollected?: boolean;
  previousPosition?: { x: number; y: number };
}

export interface DungeonStrategyResult {
  direction?: DungeonDirection;
  reason: string;
}

const directions: ReadonlyArray<Readonly<{ direction: DungeonDirection; dx: number; dy: number }>> = [
  { direction: "north", dx: 0, dy: -1 },
  { direction: "east", dx: 1, dy: 0 },
  { direction: "south", dx: 0, dy: 1 },
  { direction: "west", dx: -1, dy: 0 },
];

const key = (x: number, y: number): string => `${x}:${y}`;
const validPoint = (point: { x: number; y: number }): boolean => Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y);
const isHazard = (cell: DungeonCell): boolean => /босс|ловушк|капкан|монстр|опасн/u.test(`${cell.title} ${cell.text}`.toLowerCase());
// Distance hints are map text, while only the cell title identifies a concrete goal.
const isTreasure = (cell: DungeonCell): boolean => {
  const title = cell.title.trim().toLowerCase().replace(/,\s*идите на\s+(?:север|юг|восток|запад)\s*$/u, "");
  return title === "сокровище" || title === "сокровищница";
};
const isExit = (cell: DungeonCell): boolean => cell.title.trim().toLowerCase().replace(/,\s*идите на\s+(?:север|юг|восток|запад)\s*$/u, "") === "выход из подземелья";

function orderedNeighbors(point: { x: number; y: number }): Array<{ direction: DungeonDirection; x: number; y: number }> {
  return directions.map(({ direction, dx, dy }) => ({ direction, x: point.x + dx, y: point.y + dy }));
}

function reverseOf(previous: { x: number; y: number } | undefined, current: { x: number; y: number }): string | undefined {
  return previous && validPoint(previous) ? key(previous.x, previous.y) : undefined;
}

/** Chooses one bounded, observed dungeon move. The DOM adapter supplies the complete map and legal controls. */
export function planDungeonStrategy(map: DungeonMap): DungeonStrategyResult {
  if (!map || !Array.isArray(map.cells) || !Array.isArray(map.legalMoves) || !validPoint(map.position) || !Number.isSafeInteger(map.turn) || typeof map.battleId !== "string" || map.battleId.length === 0) {
    return { reason: "Карта подземелья неполна или имеет недопустимые координаты." };
  }
  if (map.otherGodDirected) return { reason: "Другой бог уже направил героя; ход не меняется." };

  const cells = new Map<string, DungeonCell>();
  for (const cell of map.cells) {
    if (!validPoint(cell) || typeof cell.text !== "string" || typeof cell.title !== "string" || typeof cell.wall !== "boolean" || typeof cell.unknown !== "boolean") continue;
    cells.set(key(cell.x, cell.y), cell);
  }
  const current = cells.get(key(map.position.x, map.position.y));
  if (!current || current.wall || isHazard(current)) return { reason: "Текущая клетка подземелья не подтверждена как безопасная." };

  const legal = new Map<string, { direction: DungeonDirection; x: number; y: number }>();
  for (const move of map.legalMoves) {
    if (!directions.some((item) => item.direction === move.direction) || !validPoint(move)) continue;
    const expected = directions.find((item) => item.direction === move.direction)!;
    if (move.x !== map.position.x + expected.dx || move.y !== map.position.y + expected.dy) continue;
    const cell = cells.get(key(move.x, move.y));
    if (!cell || cell.wall || isHazard(cell) || (isExit(cell) && !map.treasureCollected)) continue;
    legal.set(key(move.x, move.y), move);
  }
  if (legal.size === 0) return { reason: "Безопасный легальный ход не найден." };

  const reverse = reverseOf(map.previousPosition, map.position);
  const allowed = new Set(legal.keys());
  const candidates = orderedNeighbors(map.position)
    .filter((move) => allowed.has(key(move.x, move.y)))
    .sort((left, right) => Number(key(left.x, left.y) === reverse) - Number(key(right.x, right.y) === reverse));
  const traversable = (cell: DungeonCell | undefined): boolean => !!cell && !cell.wall && !cell.unknown && !isHazard(cell) && (!isExit(cell) || map.treasureCollected === true);

  const queue: Array<{ x: number; y: number }> = candidates.filter((move) => traversable(cells.get(key(move.x, move.y)))).map((move) => ({ x: move.x, y: move.y }));
  const visited = new Set<string>([key(map.position.x, map.position.y)]);
  const firstByCell = new Map<string, DungeonDirection>();
  for (const move of candidates) firstByCell.set(key(move.x, move.y), move.direction);
  const goalMoves = new Map<string, DungeonDirection>();
  while (queue.length > 0) {
    const point = queue.shift()!;
    const pointCell = cells.get(key(point.x, point.y));
    const isGoal = pointCell && (isTreasure(pointCell) || (map.treasureCollected === true && isExit(pointCell)));
    if (isGoal && key(point.x, point.y) !== key(map.position.x, map.position.y)) goalMoves.set(key(point.x, point.y), firstByCell.get(key(point.x, point.y))!);
    for (const next of orderedNeighbors(point)) {
      const nextKey = key(next.x, next.y);
      if (visited.has(nextKey)) continue;
      const nextCell = cells.get(nextKey);
      if (!traversable(nextCell)) continue;
      visited.add(nextKey);
      firstByCell.set(nextKey, firstByCell.get(key(point.x, point.y))!);
      queue.push({ x: next.x, y: next.y });
    }
  }
  const goalDirection = [...goalMoves.values()][0];
  if (goalDirection) return { direction: goalDirection, reason: "К ближайшей подтверждённой цели найден безопасный путь." };

  const frontier = candidates.find((move) => cells.get(key(move.x, move.y))?.unknown === true);
  if (frontier) return { direction: frontier.direction, reason: "Исследуется легальная неизвестная клетка подземелья." };

  const frontierDirections = new Map<string, DungeonDirection>();
  const frontierQueue: Array<{ x: number; y: number }> = candidates.filter((move) => traversable(cells.get(key(move.x, move.y)))).map((move) => ({ x: move.x, y: move.y }));
  const frontierVisited = new Set<string>([key(map.position.x, map.position.y)]);
  const frontierFirst = new Map<string, DungeonDirection>();
  for (const candidate of candidates) frontierFirst.set(key(candidate.x, candidate.y), candidate.direction);
  while (frontierQueue.length > 0) {
    const point = frontierQueue.shift()!;
    const pointKey = key(point.x, point.y);
    for (const next of orderedNeighbors(point)) {
      const nextKey = key(next.x, next.y);
      const nextCell = cells.get(nextKey);
      if (nextCell?.unknown === true) {
        frontierDirections.set(nextKey, frontierFirst.get(pointKey)!);
        continue;
      }
      if (frontierVisited.has(nextKey) || !traversable(nextCell)) continue;
      frontierVisited.add(nextKey);
      frontierFirst.set(nextKey, frontierFirst.get(pointKey)!);
      frontierQueue.push({ x: next.x, y: next.y });
    }
  }
  const frontierDirection = [...frontierDirections.values()][0];
  if (frontierDirection) return { direction: frontierDirection, reason: "К ближайшей границе исследования найден безопасный путь." };
  return { reason: "Безопасная граница исследования не найдена." };
}
