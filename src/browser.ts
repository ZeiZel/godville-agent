import type { ObservationV1 } from "./types.js";
import { evaluateCondition, isHandlerEnabled, type Condition, type HandlerDefinition } from "./handlers.js";

export type { Condition, HandlerDefinition } from "./handlers.js";

/** Structural subset of Playwright. A real Playwright Page satisfies this interface. */
export interface UiElement {
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  click(options: { position: { x: number; y: number }; timeout?: number }): Promise<void>;
}
export interface UiLocator { count(): Promise<number>; nth(index: number): UiElement; }
/** Semantic locators only: no CSS, XPath, index, or partial-text fallback is exposed. */
export interface UiPage { getByRole(role: "button", options: { name: string; exact: true }): UiLocator; mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void> }; }
export type FreshReader = () => Promise<ObservationV1>;
export type ClickOutcome =
  | { state: "SKIPPED"; clicked: false; confirmed: false; ambiguous: false; reason: string }
  | { state: "CONFIRMED"; clicked: true; confirmed: true; ambiguous: false; reason: string; observation: ObservationV1 }
  | { state: "AMBIGUOUS"; clicked: boolean; confirmed: false; ambiguous: true; reason: string; observation?: ObservationV1 };
export type BrowserResult = ClickOutcome;

export interface BrowserExecutionOptions {
  /** Atomic action-journal gate; called once after final recheck, immediately before click. */
  beforeClick?: (input: { handler: HandlerDefinition; observation: ObservationV1 }) => Promise<boolean>;
  /** Explicit fixture-only escape hatch. Production callers must provide beforeClick. */
  allowUnsafeTestClick?: true;
  onObservation?: (observation: ObservationV1, phase: "precheck" | "recheck" | "postcondition") => void | Promise<void>;
  onOutcome?: (outcome: ClickOutcome) => void | Promise<void>;
}
export interface BrowserClock { random(): number; now(): Date; wait(milliseconds: number): Promise<void>; }
const systemClock: BrowserClock = { random: Math.random, now: () => new Date(), wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
const bound = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const randomUnit = (random: () => number): number => bound(random(), 0, 0.999999999999);
const skipped = (reason: string): ClickOutcome => ({ state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason });

function isInScope(handler: HandlerDefinition, observation: ObservationV1): boolean {
  const mode = observation.mode;
  return mode !== "unknown" && handler.scope.modes.includes(mode) && handler.scope.requiredMarkers.every((marker) => observation.rawShape.includes(marker));
}

/** True only while there is enough time left for the declared safety margin. */
export function withinDeadline(handler: HandlerDefinition, now: Date): boolean {
  const deadline = handler.scope.deadline;
  if (!deadline) return true;
  const seconds = now.getUTCMinutes() * 60 + now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  return seconds <= deadline.endSecond - deadline.safetyMarginMs / 1000;
}
function clickTimeout(handler: HandlerDefinition, now: Date): number | undefined {
  const deadline = handler.scope.deadline;
  if (!deadline) return undefined;
  const seconds = now.getUTCMinutes() * 60 + now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  return Math.max(1, Math.floor((deadline.endSecond - deadline.safetyMarginMs / 1_000 - seconds) * 1_000));
}
function hasKnownCost(handler: HandlerDefinition, observation: ObservationV1): boolean {
  return handler.cost.maxPrana === 0 || (observation.prana !== undefined && observation.prana.current >= handler.cost.maxPrana);
}

/**
 * A bounded Page adapter for an already-authenticated Playwright Page. It
 * never launches/logs in, retries a click, or changes to a second selector.
 */
export class PlaywrightAdapter {
  constructor(private readonly page: UiPage, private readonly readFresh: FreshReader, private readonly clock: BrowserClock = systemClock) {}

  private async observe(options: BrowserExecutionOptions, phase: "precheck" | "recheck" | "postcondition"): Promise<ObservationV1> {
    const observation = await this.readFresh();
    await options.onObservation?.(observation, phase);
    return observation;
  }
  /** Rebuilds the exact semantic locator; never retains a pre-delay nth(0). */
  private async exactActionable(handler: HandlerDefinition): Promise<UiElement | undefined> {
    const locator = this.page.getByRole(handler.match.role, { name: handler.match.text, exact: true });
    if (await locator.count() !== 1) return undefined;
    const element = locator.nth(0);
    if (!(await element.isVisible()) || !(await element.isEnabled()) || !(await element.boundingBox())) return undefined;
    return element;
  }
  private delay(handler: HandlerDefinition): number {
    const [minimum, maximum] = handler.action.reactionDelayMs;
    return minimum + Math.floor(randomUnit(this.clock.random) * (maximum - minimum + 1));
  }
  private point(handler: HandlerDefinition, box: { x: number; y: number; width: number; height: number }): { x: number; y: number } | undefined {
    const inset = Math.max(1, handler.action.clickOffsetPx + handler.action.clickJigglePx);
    if (box.width <= inset * 2 || box.height <= inset * 2) return undefined;
    const varied = (amount: number): number => (randomUnit(this.clock.random) * 2 - 1) * amount;
    return {
      x: bound(box.width / 2 + varied(handler.action.clickOffsetPx) + varied(handler.action.clickJigglePx), inset, box.width - inset),
      y: bound(box.height / 2 + varied(handler.action.clickOffsetPx) + varied(handler.action.clickJigglePx), inset, box.height - inset),
    };
  }
  private async finish(options: BrowserExecutionOptions, outcome: ClickOutcome): Promise<ClickOutcome> { await options.onOutcome?.(outcome); return outcome; }

  async execute(handler: HandlerDefinition, options: BrowserExecutionOptions): Promise<ClickOutcome> {
    if (!isHandlerEnabled(handler)) return this.finish(options, skipped("handler is disabled"));
    if (!options.beforeClick && options.allowUnsafeTestClick !== true) return this.finish(options, skipped("a journal beforeClick callback is required for a real click"));

    const before = await this.observe(options, "precheck");
    if (before.freshness !== "fresh" || !isInScope(handler, before) || !hasKnownCost(handler, before) || !evaluateCondition(handler.precondition, before, this.clock.now())) return this.finish(options, skipped("precondition or known cost failed on fresh UI"));
    if (!withinDeadline(handler, this.clock.now())) return this.finish(options, skipped("deadline safety margin has passed"));
    if (!(await this.exactActionable(handler))) return this.finish(options, skipped("exact visible enabled button/text match is not unique"));
    await this.clock.wait(this.delay(handler));

    // Fresh observation plus fresh locator/actionability must both hold after the delay.
    const rechecked = await this.observe(options, "recheck");
    if (rechecked.freshness !== "fresh" || !isInScope(handler, rechecked) || !hasKnownCost(handler, rechecked) || !evaluateCondition(handler.precondition, rechecked, this.clock.now())) return this.finish(options, skipped("precondition or known cost changed before click"));
    if (!withinDeadline(handler, this.clock.now())) return this.finish(options, skipped("deadline safety margin has passed before click"));
    const element = await this.exactActionable(handler);
    if (!element) return this.finish(options, skipped("exact button no longer actionably unique"));
    const box = await element.boundingBox();
    if (!box) return this.finish(options, skipped("target lost visible geometry before click"));
    const point = this.point(handler, box);
    if (!point) return this.finish(options, skipped("target is too small for bounded click offset"));
    if (!withinDeadline(handler, this.clock.now())) return this.finish(options, skipped("deadline safety margin has passed before click"));
    if (options.beforeClick && !(await options.beforeClick({ handler, observation: rechecked }))) return this.finish(options, skipped("journal did not grant this intent"));
    let clickAttempted = false;
    try {
      // Playwright's Locator.click supplies its own actionability/overlay check;
      // mouse.move is only bounded pointer variation, never the click itself.
      await this.page.mouse.move(box.x + point.x, box.y + point.y, { steps: 2 + Math.floor(randomUnit(this.clock.random) * 3) });
      if (!withinDeadline(handler, this.clock.now())) return this.finish(options, { state: "AMBIGUOUS", clicked: false, confirmed: false, ambiguous: true, reason: "journal gate passed but deadline elapsed before click; do not retry" });
      const timeout = clickTimeout(handler, this.clock.now());
      clickAttempted = true;
      await element.click({ position: point, ...(timeout === undefined ? {} : { timeout }) });
    } catch {
      return this.finish(options, { state: "AMBIGUOUS", clicked: clickAttempted, confirmed: false, ambiguous: true, reason: "browser error after click was authorized; do not retry" });
    }
    const started = this.clock.now().getTime();
    let last: ObservationV1 | undefined;
    while (this.clock.now().getTime() - started <= handler.postcondition.timeoutMs) {
      let observation: ObservationV1;
      try { observation = await this.observe(options, "postcondition"); } catch {
        return this.finish(options, { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "post-click observation failed; do not retry" });
      }
      last = observation;
      if (observation.freshness === "fresh" && evaluateCondition(handler.postcondition.condition, observation, this.clock.now())) return this.finish(options, { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "postcondition observed", observation });
      if (this.clock.now().getTime() - started >= handler.postcondition.timeoutMs) break;
      await this.clock.wait(Math.min(handler.postcondition.pollIntervalMs, handler.postcondition.timeoutMs));
    }
    return this.finish(options, { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "postcondition timed out; do not retry", ...(last ? { observation: last } : {}) });
  }
}
