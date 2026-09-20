import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClickOutcome } from "./browser.js";
import { Jiggler, type JigglerClock, type JigglerConfig } from "./jiggler.js";
import { OBSERVATION_VERSION, type ObservationV1 } from "./types.js";

const execFileAsync = promisify(execFile);
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GODVILLE_ORIGIN = "https://godville.net";
const MAX_TIMEOUT_MS = 5_000;
const POSTCONDITION_TIMEOUT_MS = 15_000;
const POSTCONDITION_POLL_MS = 250;
export const NORMAL_FIELD_HEADING_PATTERN = /^(?:Бой\s+на\s+\d+-м\s+столбе|Дорога\s+мимо\s+\d+-го\s+столба)$/u;

export type LiveCommandId = "hero.encourage";
export interface ReviewedLiveCommand { id: LiveCommandId; maxPrana: number; maxCharges: 0; }
export const LIVE_COMMANDS: Readonly<Record<LiveCommandId, ReviewedLiveCommand>> = {
  // The 25-prana maximum is curated game knowledge; recharge is deliberately absent.
  "hero.encourage": { id: "hero.encourage", maxPrana: 25, maxCharges: 0 },
};
export interface LiveExecuteOptions {
  beforeClick: (input: { command: ReviewedLiveCommand; observation: ObservationV1 }) => Promise<boolean>;
  onOutcome?: (outcome: ClickOutcome) => void | Promise<void>;
}
export interface LiveBrowserAdapter {
  observe(): Promise<ObservationV1>;
  execute(commandId: LiveCommandId, options: LiveExecuteOptions): Promise<ClickOutcome>;
  waitBetweenActions(): Promise<void>;
}
/** Short runner-facing name for the adapter-neutral observe/execute contract. */
export type LiveAdapter = LiveBrowserAdapter;
export interface OrcaResponse { stdout: string; }
export type OrcaLiveExecutor = (command: "orca" | "orca-dev", args: readonly string[], options: { timeout: number }) => Promise<OrcaResponse>;
export interface LiveGodvilleAdapterConfig {
  pageId: string;
  command?: "orca" | "orca-dev";
  /** Trusted configured account identity; the observer never reads a hero name from the live DOM. */
  heroId?: string;
  executor?: OrcaLiveExecutor;
  clock?: JigglerClock;
  jigglerConfig?: JigglerConfig;
  fixtureMode?: boolean;
}

/** Fixed DOM reader: outputs only parsed numeric state and a non-reversible diary fingerprint. */
export const GODVILLE_OBSERVE_EXPRESSION = `(() => {const pair=(s,r)=>{const m=typeof s==='string'?s.match(r):null;return m?[Number(m[1]),Number(m[2])]:null};const text=e=>e?e.innerText:'';const hero=document.querySelector('#hero_block'),stats=document.querySelector('#stats'),control=document.querySelector('#control');const hp=pair(text(document.querySelector('#hk_health')),/Здоровье\\s+(\\d+)\\s*\\/\\s*(\\d+)/u);const prana=pair(text(control&&control.querySelector('.gp_val')),/^(\\d+)%$/u);const charges=pair(text(control&&control.querySelector('.acc_val')),/^(\\d+)$/u);const normalField=new RegExp(${JSON.stringify(NORMAL_FIELD_HEADING_PATTERN.source)},'u');const fieldMode=[...document.querySelectorAll('#news h2,#news h3,#news .block_title')].some(e=>normalField.test(text(e).trim()));let hash=2166136261;for(const row of [...document.querySelectorAll('#diary .d_line')].slice(0,4)){for(const ch of text(row.querySelector('.d_time'))+'\\n'+text(row.querySelector('.d_msg'))){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619)}}return JSON.stringify({origin:location.origin,path:location.pathname,ready:!!hero&&!!stats&&!!control,health:hp,pranaPercent:prana?prana[0]:null,charges:charges?charges[0]:null,fieldMode,diaryFingerprint:hash>>>0})})()`;
/** Fixed exact-control readiness reader. No policy text, selector, or code reaches this expression. */
export const GODVILLE_ENCOURAGE_TARGET_EXPRESSION = `(() => {const root=document.querySelector('#control');const label='Сделать хорошо';const links=root?[...root.querySelectorAll('a')].filter(a=>(a.innerText||'').trim()===label):[];if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),cx=r.left+r.width/2,cy=r.top+r.height/2,hit=document.elementFromPoint(cx,cy);const enabled=!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit));return JSON.stringify({ready:enabled,x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
/** After pointer movement this fixed expression verifies that the exact target is hovered. */
export const GODVILLE_ENCOURAGE_HOVER_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Сделать хорошо',links=root?[...root.querySelectorAll('a')].filter(a=>(a.innerText||'').trim()===label):[];return JSON.stringify({ready:location.origin==='https://godville.net'&&location.pathname==='/superhero'&&links.length===1&&links[0].matches(':hover')})})()`;

const systemClock: JigglerClock = { random: Math.random, now: () => new Date(), wait: (milliseconds, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("live adapter wait cancelled")); }, { once: true }); }) };
const defaultExecutor: OrcaLiveExecutor = async (command, args, options) => {
  const result = await execFileAsync(command, args, { timeout: options.timeout, maxBuffer: 16 * 1024, windowsHide: true });
  return { stdout: result.stdout };
};
const asRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function parseEval(stdout: string): Record<string, unknown> {
  let outer: unknown;
  try { outer = JSON.parse(stdout); } catch { throw new Error("live browser returned invalid JSON"); }
  const envelope = asRecord(outer), result = envelope && asRecord(envelope.result);
  if (!envelope || envelope.ok !== true || !result || typeof result.result !== "string") throw new Error("live browser returned an invalid response");
  try { const parsed = asRecord(JSON.parse(result.result)); if (!parsed) throw new Error(); return parsed; } catch { throw new Error("live browser returned an invalid response"); }
}
function parseMouse(stdout: string): void {
  try { const outer = asRecord(JSON.parse(stdout)); if (!outer || outer.ok !== true) throw new Error(); } catch { throw new Error("live browser pointer command failed"); }
}
function parseSnapshot(value: Record<string, unknown>, observedAt: string, heroId?: string): { observation: ObservationV1; diaryFingerprint: number } {
  const health = Array.isArray(value.health) && value.health.length === 2 && value.health.every(nonnegativeInteger) ? value.health as [number, number] : undefined;
  const prana = nonnegativeInteger(value.pranaPercent) && value.pranaPercent <= 100 ? value.pranaPercent : undefined;
  const charges = nonnegativeInteger(value.charges) ? value.charges : undefined;
  if (value.origin !== GODVILLE_ORIGIN || value.path !== "/superhero" || value.ready !== true || !health || health[1] <= 0 || health[0] > health[1] || prana === undefined || charges === undefined || typeof value.fieldMode !== "boolean" || !nonnegativeInteger(value.diaryFingerprint)) throw new Error("live Godville DOM contract is unknown");
  return {
    observation: { version: OBSERVATION_VERSION, observedAt, sourceVersion: "godville-dom/v1", freshness: "fresh", ...(heroId ? { heroId } : {}), mode: value.fieldMode ? "idle" : "unknown", capabilities: [], progressionKnown: false, prana: { current: prana, capacity: 100 }, charges, health: health[0] / health[1] >= 0.5 ? "known_safe" : "known_risk", healthPercent: Math.floor(100 * health[0] / health[1]), cooldowns: {}, rawShape: ["godville-superhero", "godville-control", "godville-diary"] },
    diaryFingerprint: value.diaryFingerprint,
  };
}
function parseTarget(value: Record<string, unknown>): { x: number; y: number; width: number; height: number } | undefined {
  return value.ready === true && nonnegativeInteger(value.x) && nonnegativeInteger(value.y) && nonnegativeInteger(value.width) && nonnegativeInteger(value.height) && value.width > 4 && value.height > 4 ? { x: value.x, y: value.y, width: value.width, height: value.height } : undefined;
}

class OrcaGodvilleAdapter implements LiveBrowserAdapter {
  private stableDiaryFingerprint: number | undefined;
  private readonly jiggler: Jiggler;
  constructor(private readonly pageId: string, private readonly command: "orca" | "orca-dev", private readonly executor: OrcaLiveExecutor, private readonly clock: JigglerClock, private readonly heroId: string | undefined, config?: JigglerConfig, fixtureMode = false) { this.jiggler = new Jiggler(clock, config, fixtureMode ? "fixture" : "production"); }
  private async exec(args: readonly string[]): Promise<string> { try { return (await this.executor(this.command, args, { timeout: MAX_TIMEOUT_MS })).stdout; } catch { throw new Error("live browser transport failed"); } }
  private async evaluate(expression: string): Promise<Record<string, unknown>> { return parseEval(await this.exec(["eval", "--page", this.pageId, "--expression", expression, "--json"])); }
  private async snapshot(): Promise<{ observation: ObservationV1; diaryFingerprint: number }> {
    const snapshot = parseSnapshot(await this.evaluate(GODVILLE_OBSERVE_EXPRESSION), this.clock.now().toISOString(), this.heroId);
    if (this.stableDiaryFingerprint === snapshot.diaryFingerprint) snapshot.observation = { ...snapshot.observation, eventId: `godville-diary-fnv1a32:${snapshot.diaryFingerprint}` };
    this.stableDiaryFingerprint = snapshot.diaryFingerprint;
    return snapshot;
  }
  async observe(): Promise<ObservationV1> {
    const first = await this.snapshot();
    if (first.observation.eventId) return first.observation;
    // A runner needs a stable event before it plans an intent. Confirm the
    // diary fingerprint with a second fresh read instead of treating one row
    // sample as an idempotency key.
    return (await this.snapshot()).observation;
  }
  async waitBetweenActions(): Promise<void> { await this.jiggler.waitBetweenActions(); }
  private async finish(options: LiveExecuteOptions, outcome: ClickOutcome): Promise<ClickOutcome> { await options.onOutcome?.(outcome); return outcome; }
  private async pointer(action: "move" | "down" | "up", point?: { x: number; y: number }): Promise<void> {
    // Orca accepts integer device coordinates only. The Jiggler point has an
    // inset of at least one CSS pixel, so rounding remains inside its target.
    const args = action === "move" ? ["mouse", "move", "--x", String(Math.round(point!.x)), "--y", String(Math.round(point!.y)), "--page", this.pageId, "--json"] : ["mouse", action, "--button", "left", "--page", this.pageId, "--json"];
    parseMouse(await this.exec(args));
  }
  async execute(commandId: LiveCommandId, options: LiveExecuteOptions): Promise<ClickOutcome> {
    const command = Object.hasOwn(LIVE_COMMANDS, commandId) ? LIVE_COMMANDS[commandId] : undefined;
    if (!command || !options.beforeClick) throw new Error("live browser execution requires a reviewed command and journal gate");
    let before: { observation: ObservationV1; diaryFingerprint: number };
    try { before = await this.snapshot(); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh live DOM observation is unavailable" }); }
    if (before.observation.mode !== "idle" || before.observation.prana?.current === undefined || before.observation.prana.current < command.maxPrana) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "normal field mode or known prana cost is unavailable" });
    await this.jiggler.waitReaction();
    let target: { x: number; y: number; width: number; height: number } | undefined;
    let rechecked: { observation: ObservationV1; diaryFingerprint: number };
    try { rechecked = await this.snapshot(); target = parseTarget(await this.evaluate(GODVILLE_ENCOURAGE_TARGET_EXPRESSION)); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "live DOM changed before exact action check" }); }
    if (!target || rechecked.observation.mode !== "idle" || rechecked.observation.prana?.current === undefined || rechecked.observation.prana.current < command.maxPrana) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "exact action preconditions changed before click" });
    const relative = this.jiggler.point(target); if (!relative) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "target geometry is too small for bounded pointer movement" });
    try {
      const first = this.jiggler.point(target); if (!first) throw new Error();
      await this.pointer("move", { x: target.x + first.x, y: target.y + first.y });
      await this.pointer("move", { x: target.x + relative.x, y: target.y + relative.y });
    } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "pointer could not reach the exact action" }); }
    try { if ((await this.evaluate(GODVILLE_ENCOURAGE_HOVER_EXPRESSION)).ready !== true) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "pointer is no longer over the exact action" }); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "final hit test is unavailable" }); }
    let finalSnapshot: { observation: ObservationV1; diaryFingerprint: number };
    try { finalSnapshot = await this.snapshot(); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "final fresh observation is unavailable" }); }
    if (finalSnapshot.observation.mode !== "idle" || finalSnapshot.observation.prana?.current === undefined || finalSnapshot.observation.prana.current < command.maxPrana) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh action preconditions changed before journal gate" });
    if (!(await options.beforeClick({ command, observation: finalSnapshot.observation }))) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "journal did not grant this intent" });
    let downAttempted = false;
    try { downAttempted = true; await this.pointer("down"); await this.pointer("up"); } catch {
      if (downAttempted) { try { await this.pointer("up"); } catch { /* best-effort release after an uncertain pointer failure */ } }
      return this.finish(options, { state: "AMBIGUOUS", clicked: downAttempted, confirmed: false, ambiguous: true, reason: "pointer action was authorized but its result is uncertain; do not retry" });
    }
    const started = this.clock.now().getTime();
    while (this.clock.now().getTime() - started <= POSTCONDITION_TIMEOUT_MS) {
      try {
        const after = await this.snapshot();
        const beforePrana = finalSnapshot.observation.prana!.current, afterPrana = after.observation.prana!.current;
        if (after.diaryFingerprint !== finalSnapshot.diaryFingerprint && beforePrana > afterPrana && beforePrana - afterPrana <= command.maxPrana) return this.finish(options, { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: "fresh diary event and bounded prana change confirm the influence", observation: after.observation });
      } catch { return this.finish(options, { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "post-click live DOM observation failed; do not retry" }); }
      await this.clock.wait(POSTCONDITION_POLL_MS);
    }
    return this.finish(options, { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "no verified influence postcondition arrived; do not retry" });
  }
}

/** Creates a fixed-command Godville adapter for an already-open authenticated Orca page. */
export function createLiveGodvilleAdapter(config: LiveGodvilleAdapterConfig): LiveBrowserAdapter {
  if (!PAGE_ID.test(config.pageId)) throw new Error("live browser page ID must be a UUID");
  const command = config.command ?? "orca";
  if (command !== "orca" && command !== "orca-dev") throw new Error("live browser command must be orca or orca-dev");
  if (config.heroId !== undefined && (!config.heroId.trim() || config.heroId.length > 160)) throw new Error("live browser hero ID is invalid");
  return new OrcaGodvilleAdapter(config.pageId, command, config.executor ?? defaultExecutor, config.clock ?? systemClock, config.heroId, config.jigglerConfig, config.fixtureMode === true);
}
