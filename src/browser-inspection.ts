import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * This is deliberately a constant, reviewed expression. It serializes only
 * structural booleans/counts and address components; it does not inspect text,
 * form values, cookies, HTML, local storage, or account data.
 */
export const ORCA_INSPECTION_EXPRESSION = `(() => JSON.stringify({origin:location.origin,path:location.pathname,passwordFieldPresent:document.querySelector('input[type="password"]')!==null,heroStructurePresent:document.querySelector('#hero_block')!==null&&document.querySelector('#stats')!==null&&document.querySelector('#control')!==null,observationContractCount:document.querySelectorAll('[data-agent-observation]').length,candidateButtonCount:Math.min(100,document.querySelectorAll('button,input[type="submit"],[role="button"]').length)}))()`;

export interface OrcaInspection {
  origin: string;
  path: string;
  passwordFieldPresent: boolean;
  /** Current Godville structural marker, useful for diagnostics only—not action permission. */
  heroStructurePresent: boolean;
  observationContractCount: number;
  candidateButtonCount: number;
}
export interface OrcaExecResponse { stdout: string; }
export type OrcaExecutor = (command: "orca" | "orca-dev", args: readonly string[], options: { timeout: number }) => Promise<OrcaExecResponse>;
export interface OrcaInspectionOptions {
  pageId: string;
  /** Only `orca` and `orca-dev` are accepted; never a shell command or path. */
  command?: string;
  timeoutMs?: number;
  executor?: OrcaExecutor;
}
const defaultExecutor: OrcaExecutor = async (command, args, options) => {
  const result = await execFileAsync(command, args, { timeout: options.timeout, maxBuffer: 16 * 1024, windowsHide: true });
  return { stdout: result.stdout };
};
const asRecord = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegativeBoundedInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

function safeCommand(value: string | undefined): "orca" | "orca-dev" {
  if (value === undefined || value === "orca") return "orca";
  if (value === "orca-dev") return "orca-dev";
  throw new Error("Orca inspection command must be orca or orca-dev");
}
function safeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 250 || value > MAX_TIMEOUT_MS) throw new Error("Orca inspection timeout is outside the safe range");
  return value;
}
function parseOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Orca inspection returned an invalid response");
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error("Orca inspection returned an invalid response"); }
}
function parsePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 256 || value.includes("?") || value.includes("#")) throw new Error("Orca inspection returned an invalid response");
  return value;
}
/** Parses only the known, nested JSON shape returned by `orca eval --json`. */
export function parseOrcaInspection(stdout: string): OrcaInspection {
  let outer: unknown;
  try { outer = JSON.parse(stdout); } catch { throw new Error("Orca inspection returned invalid JSON"); }
  const envelope = asRecord(outer), result = envelope && asRecord(envelope.result);
  if (!envelope || envelope.ok !== true || !result || typeof result.result !== "string") throw new Error("Orca inspection returned an invalid response");
  let payload: unknown;
  try { payload = JSON.parse(result.result); } catch { throw new Error("Orca inspection returned an invalid response"); }
  const value = asRecord(payload);
  if (!value || !Object.keys(value).every((key) => ["origin", "path", "passwordFieldPresent", "heroStructurePresent", "observationContractCount", "candidateButtonCount"].includes(key)) || typeof value.passwordFieldPresent !== "boolean" || (value.heroStructurePresent !== undefined && typeof value.heroStructurePresent !== "boolean") || !nonnegativeBoundedInteger(value.observationContractCount) || (value.candidateButtonCount !== undefined && !nonnegativeBoundedInteger(value.candidateButtonCount))) throw new Error("Orca inspection returned an invalid response");
  return {
    origin: parseOrigin(value.origin), path: parsePath(value.path), passwordFieldPresent: value.passwordFieldPresent,
    heroStructurePresent: value.heroStructurePresent ?? false,
    observationContractCount: value.observationContractCount,
    candidateButtonCount: value.candidateButtonCount ?? 0,
  };
}

/** Read-only diagnostic transport for one already-open Orca embedded-browser page. */
export async function inspectOrcaPage(options: OrcaInspectionOptions): Promise<OrcaInspection> {
  if (!PAGE_ID.test(options.pageId)) throw new Error("Orca inspection page ID must be a UUID");
  const command = safeCommand(options.command), timeout = safeTimeout(options.timeoutMs), executor = options.executor ?? defaultExecutor;
  const args = ["eval", "--page", options.pageId, "--expression", ORCA_INSPECTION_EXPRESSION, "--json"] as const;
  let response: OrcaExecResponse;
  try { response = await executor(command, args, { timeout }); } catch { throw new Error("Orca inspection transport failed"); }
  return parseOrcaInspection(response.stdout);
}
