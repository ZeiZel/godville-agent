import assert from "node:assert/strict";
import test from "node:test";
import { inspectOrcaPage, ORCA_INSPECTION_EXPRESSION, parseOrcaInspection, type OrcaExecutor } from "../src/browser-inspection.js";

const pageId = "123e4567-e89b-42d3-a456-426614174000";
const observedResponse = JSON.stringify({ ok: true, result: { result: JSON.stringify({ observationContractCount: 0, origin: "https://godville.net", passwordFieldPresent: true, path: "/login" }), origin: "https://godville.net/login" } });

test("parses Orca's nested eval response without exposing page content", () => {
  assert.deepEqual(parseOrcaInspection(observedResponse), { origin: "https://godville.net", path: "/login", passwordFieldPresent: true, heroStructurePresent: false, observationContractCount: 0, candidateButtonCount: 0 });
  assert.equal(ORCA_INSPECTION_EXPRESSION.includes("textContent"), false);
  assert.equal(ORCA_INSPECTION_EXPRESSION.includes("cookie"), false);
  assert.equal(ORCA_INSPECTION_EXPRESSION.includes("value"), false);
});
test("recognizes only the verified Godville structure as a diagnostic marker", () => {
  const response = JSON.stringify({ ok: true, result: { result: JSON.stringify({ origin: "https://godville.net", path: "/superhero", passwordFieldPresent: false, heroStructurePresent: true, observationContractCount: 0, candidateButtonCount: 3 }) } });
  assert.deepEqual(parseOrcaInspection(response), { origin: "https://godville.net", path: "/superhero", passwordFieldPresent: false, heroStructurePresent: true, observationContractCount: 0, candidateButtonCount: 3 });
});
test("uses a fixed expression and rejects command/page injection", async () => {
  let captured: { command: string; args: readonly string[]; timeout: number } | undefined;
  const executor: OrcaExecutor = async (command, args, options) => { captured = { command, args, timeout: options.timeout }; return { stdout: observedResponse }; };
  const result = await inspectOrcaPage({ pageId, command: "orca", timeoutMs: 1000, executor });
  assert.equal(result.path, "/login");
  assert.deepEqual(captured, { command: "orca", args: ["eval", "--page", pageId, "--expression", ORCA_INSPECTION_EXPRESSION, "--json"], timeout: 1000 });
  await assert.rejects(() => inspectOrcaPage({ pageId: "x; click", executor }), /page ID/);
  await assert.rejects(() => inspectOrcaPage({ pageId, command: "orca --evil", executor }), /command/);
});
test("reports transport failures without forwarding stderr", async () => {
  const executor: OrcaExecutor = async () => { throw new Error("private stderr with page data"); };
  await assert.rejects(() => inspectOrcaPage({ pageId, executor }), (error: Error) => error.message === "Orca inspection transport failed");
});
