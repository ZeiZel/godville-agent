import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { GODVILLE_ARENA_STATE_EXPRESSION, GODVILLE_OBSERVE_EXPRESSION } from "../src/live-godville-adapter.js";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const smoke = test("fixed live observation expression parses synthetic field, queue, dungeon, and boss DOMs", { skip: !existsSync(chrome) }, async () => {
  const profile = mkdtempSync(join("/tmp", "godville-dom-smoke-"));
  const context = await chromium.launchPersistentContext(profile, { executablePath: chrome, headless: true });
  try {
    const cases = [
      { name: "field", html: pageHtml({ headings: ["Бой на 1-м столбе"] }), check: (value: any) => { assert.equal(value.fieldMode, true); assert.equal(value.dungeonMode, false); assert.equal(value.dungeonActive, false); } },
      { name: "queue", html: pageHtml({ headings: ["Авантюра на 1-м столбе"], news: "соединение со спутниками" }), check: (value: any) => { assert.equal(value.dungeonMode, true); assert.equal(value.dungeonWaiting, true); assert.equal(value.dungeonActive, false); } },
      { name: "dungeon", html: pageHtml({ headings: ["Авантюра на 1-м столбе", "Карта", "Пульт", "Хроника подземелья (шаг 2)"], battle: true }), check: (value: any) => { assert.equal(value.dungeonActive, true); assert.equal(value.dungeonTurn, 2); assert.equal(value.battleId, "/duels/log/synthetic"); } },
      { name: "boss", html: pageHtml({ headings: ["Авантюра на 1-м столбе", "Карта", "Хроника боя (шаг 3)"], battle: true }), check: (value: any) => { assert.equal(value.dungeonActive, true); assert.equal(value.dungeonCombat, true); assert.equal(value.dungeonTurn, 3); } },
    ];
    for (const scenario of cases) {
      const page = await context.newPage();
      await page.route("https://godville.net/superhero", async (route) => route.fulfill({ status: 200, contentType: "text/html", body: scenario.html }));
      await page.goto("https://godville.net/superhero");
      const value = JSON.parse(await page.evaluate(GODVILLE_OBSERVE_EXPRESSION) as string) as Record<string, unknown>;
      assert.equal(value.origin, "https://godville.net", scenario.name);
      assert.equal(value.path, "/superhero", scenario.name);
      assert.equal(value.ready, true, scenario.name);
      assert.deepEqual(value.health, [80, 100], scenario.name);
      assert.equal(value.pranaPercent, 70, scenario.name);
      assert.equal(value.charges, 123, scenario.name);
      scenario.check(value);
      await page.close();
    }
    const arena = await context.newPage();
    await arena.setContent(arenaHtml());
    const raw = JSON.parse(await arena.evaluate(GODVILLE_OBSERVE_EXPRESSION) as string) as Record<string, unknown>;
    const state = JSON.parse(await arena.evaluate(GODVILLE_ARENA_STATE_EXPRESSION) as string) as Record<string, unknown>;
    assert.equal(raw.ready, false, "arena deliberately does not masquerade as normal field DOM");
    assert.equal(state.active, true, `strict arena panels, chronicle, and battle link are required: ${JSON.stringify(state)}`);
    assert.equal(state.terminal, false);
    await arena.close();
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

function pageHtml(options: { headings: string[]; news?: string; battle?: boolean }): string {
  const headings = options.headings.map((heading) => `<h2>${heading}</h2>`).join("");
  const battle = options.battle ? '<a id="fbclink" href="/duels/log/synthetic">log</a>' : "";
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="hero_block"></div><div id="stats"></div><div id="control"><span class="gp_val">70%</span><span class="acc_val">123</span></div><div id="m_control"><span class="gp_val">70%</span><span class="acc_val">123</span></div><div id="hk_health">Здоровье 80 / 100</div><div id="news">${headings}</div><div id="news_pb">${options.news ?? ""}</div>${battle}<div id="diary"><div class="d_line"><span class="d_time">12:00</span><span class="d_msg">synthetic</span></div></div></body></html>`;
}

function arenaHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="m_info"><div id="hk_health">Здоровье 80 / 100</div></div><div id="o_info">opponent</div><div id="m_control"><span class="gp_val">70%</span><span class="acc_val">123</span></div><div id="m_fight_log"><h2 class="block_title">Вести с арены (шаг 4)</h2></div><a id="fbclink" href="/duels/log/synthetic">log</a><div id="diary"><div class="d_line"><span class="d_time">12:00</span><span class="d_msg">synthetic</span></div></div></body></html>`;
}

void smoke;
