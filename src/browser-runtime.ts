import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { PlaywrightAdapter, type BrowserClock, type BrowserExecutionOptions, type ClickOutcome, type FreshReader, type UiPage } from "./browser.js";
import { findEnabledHandler, type HandlerCatalog, type HandlerDefinition } from "./handlers.js";
import { OBSERVATION_VERSION, type ObservationV1 } from "./types.js";

interface RuntimePage extends UiPage {
  goto(url: string): Promise<unknown>;
  locator(selector: string): { textContent(): Promise<string | null> };
}
interface RuntimeContext { pages(): RuntimePage[]; newPage(): Promise<RuntimePage>; close(): Promise<void>; }
interface RuntimeBrowser { newContext(): Promise<RuntimeContext>; close(): Promise<void>; }
interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<RuntimeBrowser>;
    launchPersistentContext(directory: string, options: { headless: boolean }): Promise<RuntimeContext>;
  };
}
export interface BrowserRuntimeOptions extends BrowserExecutionOptions {
  /** A catalog produced by parseHandlerCatalog; the runtime resolves this entry from it. */
  catalog: HandlerCatalog;
  handler: HandlerDefinition;
  /** Fixture file URL or explicitly approved target URL. No login/cookie automation is supplied. */
  url?: string;
  /** Optional local Playwright profile directory; no credentials are read or configured by this module. */
  userDataDir?: string;
  headless?: boolean;
  /** Required for any URL other than localhost or file:. It is false by default. */
  allowRemoteUrl?: boolean;
  readFresh?: FreshReader;
  clock?: BrowserClock;
}
const fixtureUrl = pathToFileURL(resolve("fixtures/browser.html")).href;
function allowedUrl(raw: string, allowRemoteUrl: boolean): boolean {
  try {
    const url = new URL(raw);
    return allowRemoteUrl || url.protocol === "file:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch { return false; }
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
/** Strict DOM contract for local fixtures. Arbitrary page script is never evaluated. */
export function parseAgentObservation(source: string): ObservationV1 {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("data-agent-observation is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("data-agent-observation must be an object");
  const record = value as Record<string, unknown>;
  const allowedModes = new Set(["idle", "arena", "dungeon", "sailing", "raid_boss", "personal_boss", "polygon", "shop", "unknown"]);
  const allowedFreshness = new Set(["fresh", "stale", "expired", "auth_degraded"]);
  const allowedHealth = new Set(["known_safe", "known_risk", "unknown"]);
  if (record.version !== OBSERVATION_VERSION || typeof record.observedAt !== "string" || Number.isNaN(Date.parse(record.observedAt)) || typeof record.sourceVersion !== "string" || !allowedFreshness.has(String(record.freshness)) || !allowedModes.has(String(record.mode)) || !stringArray(record.capabilities) || typeof record.progressionKnown !== "boolean" || !allowedHealth.has(String(record.health)) || !isStringRecord(record.cooldowns) || !stringArray(record.rawShape)) throw new Error("data-agent-observation has an unknown schema");
  const prana = record.prana;
  if (prana !== undefined && (!isFinitePair(prana))) throw new Error("data-agent-observation has invalid prana");
  if (record.charges !== undefined && (!Number.isInteger(record.charges) || (record.charges as number) < 0)) throw new Error("data-agent-observation has invalid charges");
  return record as unknown as ObservationV1;
}
function isStringRecord(value: unknown): value is Record<string, string> { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"); }
function isFinitePair(value: unknown): value is { current: number; capacity: number } { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const pair = value as Record<string, unknown>; return typeof pair.current === "number" && Number.isFinite(pair.current) && typeof pair.capacity === "number" && Number.isFinite(pair.capacity) && pair.current >= 0 && pair.capacity >= pair.current; }
function domReader(page: RuntimePage): FreshReader { return async () => { const text = await page.locator("[data-agent-observation]").textContent(); if (text === null) throw new Error("missing data-agent-observation DOM contract"); return parseAgentObservation(text); }; }

/**
 * Runs only a supplied, validated handler against a Page. Playwright remains an
 * optional dependency and is loaded only when this opt-in runtime is called.
 * The default URL is the checked-in local fixture; real game DOM is unsupported
 * until a separately reviewed DOM contract is supplied.
 */
export async function executeBrowserHandler(options: BrowserRuntimeOptions): Promise<ClickOutcome> {
  if (options.allowUnsafeTestClick === true) throw new Error("allowUnsafeTestClick is forbidden in the browser runtime");
  if (!options.beforeClick) throw new Error("browser runtime requires an action-journal beforeClick callback");
  const handler = findEnabledHandler(options.catalog, options.handler.handler, options.handler.version);
  if (!handler) throw new Error("handler is absent or disabled in the validated catalog");
  const target = options.url ?? fixtureUrl;
  if (!allowedUrl(target, options.allowRemoteUrl === true)) throw new Error("remote browser target requires explicit allowRemoteUrl");
  const moduleName = "playwright";
  let playwright: PlaywrightModule;
  try { playwright = await import(moduleName) as unknown as PlaywrightModule; } catch { throw new Error("browser runtime requires the optional playwright dependency"); }
  let browser: RuntimeBrowser | undefined;
  let context: RuntimeContext | undefined;
  try {
    if (options.userDataDir) context = await playwright.chromium.launchPersistentContext(options.userDataDir, { headless: options.headless !== false });
    else { browser = await playwright.chromium.launch({ headless: options.headless !== false }); context = await browser.newContext(); }
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(target);
    const reader = options.readFresh ?? domReader(page);
    // Only a local file fixture may use sub-production test timing. Every
    // remote/hosted target receives production timing validation.
    const fixtureMode = new URL(target).protocol === "file:" ? "fixture" : "production";
    return await new PlaywrightAdapter(page, reader, options.clock, undefined, fixtureMode).execute(handler, options);
  } finally {
    await context?.close();
    await browser?.close();
  }
}
