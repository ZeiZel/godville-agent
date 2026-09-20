export const MIN_PRODUCTION_DELAY_MS = 100;
export const MAX_DELAY_MS = 5_000;
export const DEFAULT_JIGGLER_CONFIG = {
  reactionDelayMs: [350, 1_200] as const,
  betweenActionsMs: [800, 2_200] as const,
  clickOffsetPx: 2,
  clickJigglePx: 1,
} as const;

export type JigglerMode = "production" | "fixture";
export interface JigglerConfig {
  reactionDelayMs: readonly [number, number];
  betweenActionsMs: readonly [number, number];
  clickOffsetPx: number;
  clickJigglePx: number;
}
export interface JigglerClock {
  random(): number;
  now(): Date;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
export interface JigglerWaitOptions { signal?: AbortSignal; deadline?: Date; }
export interface Box { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }

export class JigglerCancelledError extends Error { constructor() { super("jiggler wait cancelled"); this.name = "JigglerCancelledError"; } }
export class JigglerDeadlineError extends Error { constructor() { super("jiggler delay cannot complete before deadline"); this.name = "JigglerDeadlineError"; } }

const finiteInteger = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
function abortIfNeeded(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new JigglerCancelledError(); }
function range(value: readonly [number, number], field: string, minimum: number): void {
  const [low, high] = value;
  if (!finiteInteger(low) || !finiteInteger(high) || low < minimum || high < low || high > MAX_DELAY_MS) throw new Error(`${field} must be an integer range within ${minimum}..${MAX_DELAY_MS}ms`);
}

/** Validates a finite, bounded timing/geometry profile. Fixture mode is explicit and local-test-only. */
export function validateJigglerConfig(config: JigglerConfig = DEFAULT_JIGGLER_CONFIG, mode: JigglerMode = "production"): JigglerConfig {
  const minimum = mode === "production" ? MIN_PRODUCTION_DELAY_MS : 0;
  range(config.reactionDelayMs, "reactionDelayMs", minimum);
  range(config.betweenActionsMs, "betweenActionsMs", minimum);
  if (!finiteInteger(config.clickOffsetPx) || config.clickOffsetPx < 0 || config.clickOffsetPx > 12 || !finiteInteger(config.clickJigglePx) || config.clickJigglePx < 0 || config.clickJigglePx > 8) throw new Error("click offset and jiggle must be bounded integers");
  return {
    reactionDelayMs: [config.reactionDelayMs[0], config.reactionDelayMs[1]],
    betweenActionsMs: [config.betweenActionsMs[0], config.betweenActionsMs[1]],
    clickOffsetPx: config.clickOffsetPx,
    clickJigglePx: config.clickJigglePx,
  };
}

/**
 * Shared bounded timing and geometry helper. It adds execution variation for
 * UI resilience; it does not provide stealth or bypass any site control.
 */
export class Jiggler {
  readonly config: JigglerConfig;
  private readonly minimumDelay: number;
  constructor(private readonly clock: JigglerClock, config: JigglerConfig = DEFAULT_JIGGLER_CONFIG, mode: JigglerMode = "production") {
    this.config = validateJigglerConfig(config, mode);
    this.minimumDelay = mode === "production" ? MIN_PRODUCTION_DELAY_MS : 0;
  }
  private unit(): number {
    const value = this.clock.random();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) throw new Error("jiggler random source returned an invalid value");
    return value;
  }
  /** A centered triangular sample prevents excessive endpoint clustering. */
  private triangular(): number { return (this.unit() + this.unit()) / 2; }
  private signedTriangular(): number { return this.unit() - this.unit(); }
  sample(range: readonly [number, number]): number {
    const [low, high] = range;
    if (!finiteInteger(low) || !finiteInteger(high) || low < 0 || high < low || high > MAX_DELAY_MS) throw new Error("jiggler delay range is invalid");
    return low + Math.floor(this.triangular() * (high - low + 1));
  }
  private async waitClock(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) { await this.clock.wait(milliseconds); return; }
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => { signal.removeEventListener("abort", aborted); reject(new JigglerCancelledError()); };
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve().then(() => this.clock.wait(milliseconds, signal)).then(
        () => { signal.removeEventListener("abort", aborted); resolve(); },
        (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error); },
      );
    });
  }
  private async wait(milliseconds: number, options: JigglerWaitOptions): Promise<number> {
    abortIfNeeded(options.signal);
    if (options.deadline && !Number.isFinite(options.deadline.getTime())) throw new JigglerDeadlineError();
    if (options.deadline && this.clock.now().getTime() + milliseconds > options.deadline.getTime()) throw new JigglerDeadlineError();
    await this.waitClock(milliseconds, options.signal);
    abortIfNeeded(options.signal);
    if (options.deadline && this.clock.now().getTime() > options.deadline.getTime()) throw new JigglerDeadlineError();
    return milliseconds;
  }
  waitReaction(options: JigglerWaitOptions = {}, rangeOverride?: readonly [number, number]): Promise<number> {
    const selected = rangeOverride ?? this.config.reactionDelayMs;
    range(selected, "reactionDelayMs", this.minimumDelay);
    return this.wait(this.sample(selected), options);
  }
  waitBetweenActions(options: JigglerWaitOptions = {}): Promise<number> { return this.wait(this.sample(this.config.betweenActionsMs), options); }
  /** Relative point, clamped to a safe inset so all randomized coordinates stay inside the target. */
  point(box: Box, geometry?: Pick<JigglerConfig, "clickOffsetPx" | "clickJigglePx">): Point | undefined {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error("jiggler box is invalid");
    const clickOffsetPx = geometry?.clickOffsetPx ?? this.config.clickOffsetPx;
    const clickJigglePx = geometry?.clickJigglePx ?? this.config.clickJigglePx;
    if (!finiteInteger(clickOffsetPx) || clickOffsetPx < 0 || clickOffsetPx > 12 || !finiteInteger(clickJigglePx) || clickJigglePx < 0 || clickJigglePx > 8) throw new Error("click offset and jiggle must be bounded integers");
    const inset = Math.max(1, clickOffsetPx + clickJigglePx);
    if (box.width <= inset * 2 || box.height <= inset * 2) return undefined;
    return {
      x: clamp(box.width / 2 + this.signedTriangular() * clickOffsetPx + this.signedTriangular() * clickJigglePx, inset, box.width - inset),
      y: clamp(box.height / 2 + this.signedTriangular() * clickOffsetPx + this.signedTriangular() * clickJigglePx, inset, box.height - inset),
    };
  }
}
