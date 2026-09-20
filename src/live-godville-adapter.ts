import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClickOutcome } from "./browser.js";
import { Jiggler, type JigglerClock, type JigglerConfig } from "./jiggler.js";
import { planDungeonStrategy, type DungeonDirection, type DungeonMap } from "./dungeon-strategy.js";
import { isZpgEntryWindow } from "./arena-window.js";
import { OBSERVATION_VERSION, type ObservationV1 } from "./types.js";

const execFileAsync = promisify(execFile);
const PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GODVILLE_ORIGIN = "https://godville.net";
const MAX_TIMEOUT_MS = 5_000;
const POSTCONDITION_TIMEOUT_MS = 15_000;
const POSTCONDITION_POLL_MS = 250;
export const NORMAL_FIELD_HEADING_PATTERN = /^(?:Бой\s+на\s+\d+-м\s+столбе|Дорога\s+мимо\s+\d+-го\s+столба|Геройство\s+на\s+\d+-м\s+столбе)$/u;
export const DUNGEON_HEADING_PATTERN = /^Авантюра\s+на\s+\d+-м\s+столбе$/u;

export type LiveCommandId = "hero.encourage" | "hero.restore_prana" | "adventure.dungeon.start" | "adventure.polygon.start" | "arena.zpg.start" | "dungeon.move.auto" | "polygon.move.safe";
export interface ReviewedLiveCommand {
  id: LiveCommandId;
  /** A reviewed upper bound on the immediate resource debit. */
  maxPrana: number;
  maxCharges: number;
  /** A control may only be used while the independently observed mode matches. */
  allowedModes: readonly ObservationV1["mode"][];
}
export const LIVE_COMMANDS: Readonly<Record<LiveCommandId, ReviewedLiveCommand>> = {
  "hero.encourage": { id: "hero.encourage", maxPrana: 25, maxCharges: 0, allowedModes: ["idle", "dungeon"] },
  // The live tooltip on #acc_links_wrap confirms one accumulator charge for +50 prana.
  "hero.restore_prana": { id: "hero.restore_prana", maxPrana: 0, maxCharges: 1, allowedModes: ["idle"] },
  // Entry cost is documented as 50%; target uses the exact observed visible label.
  "adventure.dungeon.start": { id: "adventure.dungeon.start", maxPrana: 50, maxCharges: 0, allowedModes: ["idle"] },
  "adventure.polygon.start": { id: "adventure.polygon.start", maxPrana: 50, maxCharges: 0, allowedModes: ["idle"] },
  "arena.zpg.start": { id: "arena.zpg.start", maxPrana: 50, maxCharges: 0, allowedModes: ["idle"] },
  "dungeon.move.auto": { id: "dungeon.move.auto", maxPrana: 5, maxCharges: 0, allowedModes: ["dungeon"] },
  // Polygon map actions are rendered only when the reviewed 15-prana gate is met.
  "polygon.move.safe": { id: "polygon.move.safe", maxPrana: 15, maxCharges: 0, allowedModes: ["polygon"] },
};
export interface LiveExecuteOptions {
  beforeClick: (input: { command: ReviewedLiveCommand; observation: ObservationV1 }) => Promise<boolean>;
  denialReason?: () => string | undefined;
  beforePhysicalClick?: () => boolean;
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
  zpgEnabled?: boolean;
  zpgWindow?: { minOffsetSeconds: number; maxOffsetSeconds: number };
}

/** Fixed DOM reader: outputs only parsed numeric state and a non-reversible diary fingerprint. */
export const GODVILLE_OBSERVE_EXPRESSION = `(() => {const pair=(s,r)=>{const m=typeof s==='string'?s.match(r):null;return m?[Number(m[1]),Number(m[2])]:null};const text=e=>e?e.innerText:'';const hero=document.querySelector('#hero_block'),stats=document.querySelector('#stats'),idleControl=document.querySelector('#control'),activeControl=document.querySelector('#m_control'),control=idleControl||document.querySelector('#cntrl');const hp=pair(text(document.querySelector('#hk_health')),/Здоровье\\s+(\\d+)\\s*\\/\\s*(\\d+)/u);const prana=pair(text((activeControl||control)&&((activeControl||control).querySelector('.gp_val'))),/^(\\d+)%$/u);const charges=pair(text((activeControl||control)&&((activeControl||control).querySelector('.acc_val'))),/^(\\d+)$/u);const normalField=new RegExp(${JSON.stringify(NORMAL_FIELD_HEADING_PATTERN.source)},'u'),dungeonHeading=new RegExp(${JSON.stringify(DUNGEON_HEADING_PATTERN.source)},'u');const headings=[...document.querySelectorAll('h1,h2,h3,h4,.block_title')].map(e=>text(e).trim()),fieldMode=headings.some(h=>normalField.test(h)),dungeonMode=headings.some(h=>dungeonHeading.test(h)),dungeonWaiting=dungeonMode&&/соединение со спутниками/u.test(text(document.querySelector('#news_pb'))),turnText=headings.find(h=>/^Хроника (?:подземелья|боя)/u.test(h))||'',turnMatch=turnText.match(/\\(шаг\\s+(\\d+)\\)/u),dungeonCombat=headings.includes('Карта')&&headings.some(h=>/^Хроника боя/u.test(h))&&!!turnMatch,dungeonActive=headings.includes('Карта')&&(headings.includes('Пульт')||dungeonCombat)&&!!turnMatch,dungeonTurn=turnMatch?Number(turnMatch[1]):null,polygonText=headings.find(h=>/^Полигон\\s*\\(шаг\\s+\\d+\\)$/u.test(h))||'',polygonMatch=polygonText.match(/\\(шаг\\s+(\\d+)\\)/u),polygonActive=!!polygonMatch&&!!document.querySelector('#r_map')&&!!activeControl&&!!document.querySelector('#bosses')&&!!document.querySelector('#b_info'),polygonTurn=polygonMatch?Number(polygonMatch[1]):null,battleHref=(document.querySelector('#fbclink')||{}).getAttribute?.('href')||null,battleId=typeof battleHref==='string'&&/^\\/duels\\/log\\/[a-z0-9]+$/i.test(battleHref)?battleHref:null,visible=a=>{for(let n=a,i=0;n&&i<4;n=n.parentElement,i++){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||n.classList.contains('disabled'))return false}return true},dungeonLinks=idleControl?[...idleControl.querySelectorAll('.chf_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()==='Направить в подземелье'&&visible(a)&&!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'):[],dungeonAvailable=dungeonLinks.length===1;let hash=2166136261;for(const row of [...document.querySelectorAll('#diary .d_line')].slice(0,4)){for(const ch of text(row.querySelector('.d_time'))+'\\n'+text(row.querySelector('.d_msg'))){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619)}}return JSON.stringify({origin:location.origin,path:location.pathname,ready:polygonActive?!!activeControl:!!hero&&(!dungeonActive?!!stats&&!!idleControl:!!activeControl||!!control),health:hp,pranaPercent:prana?prana[0]:null,charges:charges?charges[0]:null,fieldMode,dungeonMode,dungeonWaiting,dungeonActive,dungeonCombat,dungeonTurn,polygonActive,polygonTurn,battleId,dungeonAvailable,diaryFingerprint:hash>>>0})})()`;
/** Fixed exact-control readiness reader. No policy text, selector, or code reaches this expression. */
export const GODVILLE_ENCOURAGE_TARGET_EXPRESSION = `(() => {const label='Сделать хорошо',links=[...document.querySelectorAll('#control a.enc_link.div_link,#cntrl a.enc_link')].filter(a=>(a.innerText||'').trim()===label);if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),cx=r.left+r.width/2,cy=r.top+r.height/2,hit=document.elementFromPoint(cx,cy);const enabled=!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit));return JSON.stringify({ready:enabled,x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
/** After pointer movement this fixed expression verifies that the exact target is hovered. */
export const GODVILLE_ENCOURAGE_HOVER_EXPRESSION = `(() => {const label='Сделать хорошо',links=[...document.querySelectorAll('#control a.enc_link.div_link,#cntrl a.enc_link')].filter(a=>(a.innerText||'').trim()===label);return JSON.stringify({ready:location.origin==='https://godville.net'&&location.pathname==='/superhero'&&links.length===1&&links[0].matches(':hover')})})()`;
/** The only other reviewed live control: its tooltip was observed as "1 charge → +50 prana". */
export const GODVILLE_RESTORE_PRANA_TARGET_EXPRESSION = `(() => {const root=document.querySelector('#control'),links=root?[...root.querySelectorAll('#acc_links_wrap a.dch_link.div_link')]:[];if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),visible=e=>{for(let n=e,i=0;n&&i<4;n=n.parentElement,i++){const q=getComputedStyle(n);if(q.display==='none'||q.visibility==='hidden'||Number(q.opacity)===0)return false}return true},cx=r.left+r.width/2,cy=r.top+r.height/2,hit=document.elementFromPoint(cx,cy);const enabled=!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&visible(a)&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit));return JSON.stringify({ready:enabled,x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
export const GODVILLE_RESTORE_PRANA_HOVER_EXPRESSION = `(() => {const root=document.querySelector('#control'),links=root?[...root.querySelectorAll('#acc_links_wrap a.dch_link.div_link')]:[];return JSON.stringify({ready:location.origin==='https://godville.net'&&location.pathname==='/superhero'&&links.length===1&&links[0].matches(':hover')})})()`;
export const GODVILLE_DUNGEON_TARGET_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Направить в подземелье',links=root?[...root.querySelectorAll('.chf_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),visible=e=>{for(let n=e,i=0;n&&i<4;n=n.parentElement,i++){const q=getComputedStyle(n);if(q.display==='none'||q.visibility==='hidden'||Number(q.opacity)===0||n.classList.contains('disabled'))return false}return true},cx=r.left+r.width/2,cy=r.top+r.height/2,hit=document.elementFromPoint(cx,cy);const enabled=!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&visible(a)&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit));return JSON.stringify({ready:enabled,x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
export const GODVILLE_DUNGEON_HOVER_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Направить в подземелье',links=root?[...root.querySelectorAll('.chf_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];return JSON.stringify({ready:location.origin==='https://godville.net'&&location.pathname==='/superhero'&&links.length===1&&links[0].matches(':hover')})})()`;
export const GODVILLE_POLYGON_TARGET_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Посетить полигон',links=root?[...root.querySelectorAll('.chf_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return JSON.stringify({ready:!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit)),x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
export const GODVILLE_POLYGON_HOVER_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Посетить полигон',links=root?[...root.querySelectorAll('.chf_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];return JSON.stringify({ready:links.length===1&&links[0].matches(':hover')})})()`;
/** Single-use native-prompt shim. It accepts only the reviewed polygon confirmation and restores the original immediately after the click. */
export const GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION = `(() => {const key='__godville_polygon_confirm_v1',marker='__godville_polygon_confirm_handled_v1',ttl=10000,prior=window[key];if(prior&&window.confirm===prior.wrapper){window.confirm=prior.original;delete window[key]}else if(prior)return JSON.stringify({ready:false});const original=window.confirm,deadline=Date.now()+ttl;const restore=state=>{if(window.confirm===state.wrapper)window.confirm=state.original;if(window[key]===state)delete window[key]};const state={original,wrapper:null,deadline};state.wrapper=function(message){if(Date.now()>state.deadline){restore(state);return original.call(window,message)}const normalized=String(message).replace(/\\s+/gu,' ').trim();const allowed=/^Отправить босса на полигон\\? В ближайшие \\d+ ч \\d+ мин в книгу можно гарантированно записать два слога-боссонима\\.$/u.test(normalized);if(allowed){restore(state);window[marker]=true;return true}return original.call(window,message)};Object.defineProperty(window,key,{value:state,configurable:true});window.confirm=state.wrapper;return JSON.stringify({ready:true,deadline})})()`;
export const GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION = `(() => {const key='__godville_polygon_confirm_v1',marker='__godville_polygon_confirm_handled_v1',state=window[key],handled=window[marker]===true;if(state){if(window.confirm===state.wrapper)window.confirm=state.original;if(window[key]===state)delete window[key]}delete window[marker];return JSON.stringify({handled})})()`;
/** The arena's first confirmation is a static client prompt. A later server prompt remains manual. */
export const GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION = `(() => {const key='__godville_arena_confirm_v1',ttl=10000,prior=window[key];if(prior&&window.confirm===prior.wrapper){window.confirm=prior.original;delete window[key]}else if(prior)return JSON.stringify({ready:false});const original=window.confirm,deadline=Date.now()+ttl;const restore=state=>{if(window.confirm===state.wrapper)window.confirm=state.original;if(window[key]===state)delete window[key]};const state={original,wrapper:null,deadline};state.wrapper=function(message){if(Date.now()>state.deadline){restore(state);return original.call(window,message)}const normalized=String(message).replace(/\\s+/gu,' ').trim();if(normalized==='Отправить героя на арену для дуэли с другим игроком?'){restore(state);return true}return original.call(window,message)};Object.defineProperty(window,key,{value:state,configurable:true});window.confirm=state.wrapper;return JSON.stringify({ready:true,deadline})})()`;
export const GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION = `(() => {const key='__godville_arena_confirm_v1',state=window[key];if(state){if(window.confirm===state.wrapper)window.confirm=state.original;if(window[key]===state)delete window[key]}return JSON.stringify({ready:true})})()`;
export const GODVILLE_ARENA_TARGET_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Отправить на арену',links=root?[...root.querySelectorAll('.arena_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];if(location.origin!=='https://godville.net'||location.pathname!=='/superhero'||links.length!==1)return JSON.stringify({ready:false});const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return JSON.stringify({ready:!a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit)),x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
export const GODVILLE_ARENA_HOVER_EXPRESSION = `(() => {const root=document.querySelector('#control'),label='Отправить на арену',links=root?[...root.querySelectorAll('.arena_link_wrap > a.to_arena.div_link')].filter(a=>(a.innerText||'').trim()===label):[];return JSON.stringify({ready:links.length===1&&links[0].matches(':hover')})})()`;
/** One read-only idle scan avoids three separate Orca round trips on every poll. */
export const GODVILLE_IDLE_READINESS_EXPRESSION = `(() => {const root=document.querySelector('#control'),ready=(selector,label)=>{const links=root?[...root.querySelectorAll(selector)].filter(a=>(a.innerText||'').trim()===label):[];if(links.length!==1)return false;const a=links[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !a.hasAttribute('disabled')&&a.getAttribute('aria-disabled')!=='true'&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit))};return JSON.stringify({arena:ready('.arena_link_wrap > a.to_arena.div_link','Отправить на арену'),polygon:ready('.chf_link_wrap > a.to_arena.div_link','Посетить полигон')})})()`;
/** Structural normal-field contract admits city/rest headings without admitting retained hidden field controls in a fight. */
export const GODVILLE_FIELD_STATE_EXPRESSION = `(() => {const visible=e=>{if(!e)return false;for(let n=e,i=0;n&&i<5;n=n.parentElement,i++){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false}const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const baseline=['#hero_block','#stats','#control','#news'].every(s=>visible(document.querySelector(s))),active=['#m_control','#m_fight_log','#m_info','#o_info','#opps','#alls','#map','#s_map','#r_map'].some(s=>visible(document.querySelector(s)));return JSON.stringify({idle:baseline&&!active})})()`;
/** Strict arena-state reader used only to fail closed when the primary field reader sees an unknown view. */
export const GODVILLE_ARENA_STATE_EXPRESSION = `(() => {const visible=e=>{if(!e)return false;for(let n=e,i=0;n&&i<5;n=n.parentElement,i++){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false}const r=e.getBoundingClientRect();return r.width>0&&r.height>0};const heading=(document.querySelector('#m_fight_log .block_title')?.innerText||'').trim(),turn=heading.match(/^Вести с арены\\s*\\(шаг\\s+(\\d+)\\)$/u),href=(document.querySelector('#fbclink')||{}).getAttribute?.('href')||null,active=!!turn&&typeof href==='string'&&/^\\/duels\\/log\\/[a-z0-9]+$/i.test(href)&&['#m_info','#o_info','#m_fight_log','#m_control'].every(s=>visible(document.querySelector(s))),blocked=[...document.querySelectorAll('.r_blocked')].some(e=>visible(e)&&(e.innerText||'').trim()==='Для вашего героя бой окончен');return JSON.stringify({active,terminal:active&&blocked,turn:turn?Number(turn[1]):null,battleId:active?href:null})})()`;
/** Polygon controller deliberately exposes only adjacent repair-kit or bit pushes. */
export const GODVILLE_POLYGON_STATE_EXPRESSION = `(() => {const text=e=>(e?.innerText||'').trim(),heading=text(document.querySelector('#r_map .block_title')),turn=heading.match(/^Полигон\\s*\\(шаг\\s+(\\d+)\\)$/u),href=(document.querySelector('#fbclink')||{}).getAttribute?.('href')||null,hp=text(document.querySelector('#hk_bhp')).match(/Здоровье\\s+(\\d+)\\s*\\/\\s*(\\d+)/u),active=!!turn&&typeof href==='string'&&/^\\/duels\\/log\\/[a-z0-9]+$/i.test(href)&&!!document.querySelector('#r_map')&&!!document.querySelector('#m_control')&&!!document.querySelector('#bosses')&&!!document.querySelector('#b_info'),direction={север:'north',юг:'south',восток:'east',запад:'west'},moves=[];for(const cell of document.querySelectorAll('#r_map .rmc.rmv[role="gridcell"]')){const title=(cell.querySelector(':scope > .in_c')?.getAttribute('title')||'').trim(),m=title.match(/^Толкнуть на (север|юг|восток|запад); (ремкомплект|бит)$/u);if(m)moves.push({direction:direction[m[1]],kind:m[2]})}return JSON.stringify({ready:active&&!!hp&&Number(hp[1])>0,turn:turn?Number(turn[1]):null,battleId:active?href:null,moves})})()`;
export const GODVILLE_DUNGEON_STATE_EXPRESSION = `(() => {const text=e=>e?e.innerText:'';const heading=text(document.querySelector('#m_fight_log .block_title')).trim(),m=heading.match(/^Хроника подземелья\\s*\\(шаг\\s+(\\d+)\\)$/u),battle=(document.querySelector('#fbclink')||{}).getAttribute?.('href')||null,rows=[...document.querySelectorAll('#map .dml')],cells=[];let position=null;for(const [y,row] of rows.entries())for(const [x,cell] of [...row.querySelectorAll(':scope > .dmc')].entries()){const child=cell.querySelector(':scope > div'),title=(child?.getAttribute('title')||'').trim(),klass=cell.className||'',entry={x,y,text:text(child).trim(),title,wall:/(^|\\s)dmw(\\s|$)/.test(klass),unknown:title.startsWith('Пока не открыто')};cells.push(entry);if(title==='Команда героев')position={x,y}}const legal=[];for(const cell of cells){const m=cell.title.match(/Идите на (север|юг|восток|запад)/u);if(m){const direction={север:'north',юг:'south',восток:'east',запад:'west'}[m[1]];if(direction)legal.push({direction,x:cell.x,y:cell.y})}}return JSON.stringify({ready:!!m&&typeof battle==='string'&&/^\\/duels\\/log\\/[a-z0-9]+$/i.test(battle)&&!!position,turn:m?Number(m[1]):null,battleId:battle,position,cells,legalMoves:legal})})()`;

const systemClock: JigglerClock = { random: Math.random, now: () => new Date(), wait: (milliseconds, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("live adapter wait cancelled")); }, { once: true }); }) };
const defaultExecutor: OrcaLiveExecutor = async (command, args, options) => {
  const result = await execFileAsync(command, args, { timeout: options.timeout, maxBuffer: 128 * 1024, windowsHide: true });
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
function parseSnapshot(value: Record<string, unknown>, observedAt: string, heroId?: string): { observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; polygonTurn?: number; battleId?: string } {
  const health = Array.isArray(value.health) && value.health.length === 2 && value.health.every(nonnegativeInteger) ? value.health as [number, number] : undefined;
  const prana = nonnegativeInteger(value.pranaPercent) && value.pranaPercent <= 100 ? value.pranaPercent : undefined;
  const charges = nonnegativeInteger(value.charges) ? value.charges : undefined;
  const dungeonTurn = value.dungeonTurn === null ? undefined : nonnegativeInteger(value.dungeonTurn) ? value.dungeonTurn : undefined;
  const polygonTurn = value.polygonTurn === null ? undefined : nonnegativeInteger(value.polygonTurn) ? value.polygonTurn : undefined;
  const battleId = typeof value.battleId === "string" && /^\/duels\/log\/[a-z0-9]+$/i.test(value.battleId) ? value.battleId : undefined;
  const polygonActive = value.polygonActive === true;
  if (value.origin !== GODVILLE_ORIGIN || value.path !== "/superhero" || value.ready !== true || (!health && !polygonActive) || (health && (health[1] <= 0 || health[0] > health[1])) || prana === undefined || charges === undefined || typeof value.fieldMode !== "boolean" || typeof value.dungeonMode !== "boolean" || typeof value.dungeonWaiting !== "boolean" || typeof value.dungeonActive !== "boolean" || typeof value.dungeonCombat !== "boolean" || (value.polygonActive !== undefined && typeof value.polygonActive !== "boolean") || (value.dungeonActive === true && (dungeonTurn === undefined || battleId === undefined)) || (polygonActive && (polygonTurn === undefined || battleId === undefined)) || typeof value.dungeonAvailable !== "boolean" || !nonnegativeInteger(value.diaryFingerprint)) throw new Error("live Godville DOM contract is unknown");
  // "Авантюра" is a shared transition heading. It identifies a queue but not its
  // adventure kind, which is persisted by the launch operation rather than guessed here.
  // The baseline hero/stats/control contract is a normal field state even when
  // its localized heading changes after city, death, or adventure transitions.
  const mode: ObservationV1["mode"] = polygonActive ? "polygon" : value.dungeonActive ? "dungeon" : (value.dungeonWaiting || value.dungeonMode) ? "adventure_queue" : value.fieldMode ? "idle" : "unknown";
  return {
    observation: { version: OBSERVATION_VERSION, observedAt, sourceVersion: "godville-dom/v1", freshness: "fresh", ...(heroId ? { heroId } : {}), ...(battleId ? { battleId } : {}), mode, capabilities: [], progressionKnown: false, prana: { current: prana, capacity: 100 }, charges, health: !health ? "unknown" : health[0] / health[1] >= 0.5 ? "known_safe" : "known_risk", ...(health ? { healthPercent: Math.floor(100 * health[0] / health[1]) } : {}), cooldowns: {}, rawShape: ["godville-superhero", "godville-control", "godville-diary", ...(value.dungeonActive ? ["dungeon-active"] : []), ...(value.dungeonCombat ? ["dungeon-combat"] : []), ...(value.dungeonActive && !value.dungeonCombat ? ["dungeon-navigation-ready"] : []), ...(polygonActive ? ["polygon-active"] : []), ...(value.dungeonMode ? ["adventure-queue"] : []), ...(value.dungeonWaiting ? ["adventure-connection-wait"] : []), ...(value.dungeonAvailable ? ["dungeon-ready"] : [])] },
    diaryFingerprint: value.diaryFingerprint, ...(dungeonTurn === undefined ? {} : { dungeonTurn }), ...(polygonTurn === undefined ? {} : { polygonTurn }), ...(battleId === undefined ? {} : { battleId }),
  };
}

/** Active arena omits the field's `#stats/#control` baseline, so it has a strict fallback contract. */
function parseArenaFallback(value: Record<string, unknown>, arena: Record<string, unknown>, observedAt: string, heroId?: string): { observation: ObservationV1; diaryFingerprint: number; battleId?: string } | undefined {
  const health = Array.isArray(value.health) && value.health.length === 2 && value.health.every(nonnegativeInteger) ? value.health as [number, number] : undefined;
  const prana = nonnegativeInteger(value.pranaPercent) && value.pranaPercent <= 100 ? value.pranaPercent : undefined;
  const charges = nonnegativeInteger(value.charges) ? value.charges : undefined;
  const battleId = typeof arena.battleId === "string" && /^\/duels\/log\/[a-z0-9]+$/i.test(arena.battleId) ? arena.battleId : undefined;
  if (arena.active !== true || value.origin !== GODVILLE_ORIGIN || value.path !== "/superhero" || !health || health[1] <= 0 || health[0] > health[1] || prana === undefined || charges === undefined || !battleId || !nonnegativeInteger(value.diaryFingerprint)) return undefined;
  return { observation: { version: OBSERVATION_VERSION, observedAt, sourceVersion: "godville-dom/v1", freshness: "fresh", ...(heroId ? { heroId } : {}), battleId, mode: "arena", capabilities: [], progressionKnown: false, prana: { current: prana, capacity: 100 }, charges, health: health[0] / health[1] >= 0.5 ? "known_safe" : "known_risk", healthPercent: Math.floor(100 * health[0] / health[1]), cooldowns: {}, rawShape: ["godville-superhero", "arena-active", ...(arena.terminal === true ? ["arena-terminal"] : [])] }, diaryFingerprint: value.diaryFingerprint, battleId };
}
function parseTarget(value: Record<string, unknown>): { x: number; y: number; width: number; height: number } | undefined {
  return value.ready === true && nonnegativeInteger(value.x) && nonnegativeInteger(value.y) && nonnegativeInteger(value.width) && nonnegativeInteger(value.height) && value.width > 4 && value.height > 4 ? { x: value.x, y: value.y, width: value.width, height: value.height } : undefined;
}

function commandDom(command: ReviewedLiveCommand): { target: string; hover: string } {
  if (command.id === "hero.encourage") return { target: GODVILLE_ENCOURAGE_TARGET_EXPRESSION, hover: GODVILLE_ENCOURAGE_HOVER_EXPRESSION };
  if (command.id === "hero.restore_prana") return { target: GODVILLE_RESTORE_PRANA_TARGET_EXPRESSION, hover: GODVILLE_RESTORE_PRANA_HOVER_EXPRESSION };
  if (command.id === "adventure.polygon.start") return { target: GODVILLE_POLYGON_TARGET_EXPRESSION, hover: GODVILLE_POLYGON_HOVER_EXPRESSION };
  if (command.id === "arena.zpg.start") return { target: GODVILLE_ARENA_TARGET_EXPRESSION, hover: GODVILLE_ARENA_HOVER_EXPRESSION };
  return { target: GODVILLE_DUNGEON_TARGET_EXPRESSION, hover: GODVILLE_DUNGEON_HOVER_EXPRESSION };
}

function polygonMoveDom(direction: DungeonDirection): { target: string; hover: string } {
  const word: Record<DungeonDirection, string> = { north: "север", south: "юг", east: "восток", west: "запад" };
  const label = word[direction];
  const cells = `const cells=[...document.querySelectorAll('#r_map .rmc.rmv[role="gridcell"]')].filter(c=>new RegExp('^Толкнуть на ${label}; (?:ремкомплект|бит)$','u').test((c.querySelector(':scope > .in_c')?.getAttribute('title')||'').trim()));`;
  const target = `(() => {${cells}if(cells.length!==1)return JSON.stringify({ready:false});const a=cells[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return JSON.stringify({ready:s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit)),x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
  const hover = `(() => {${cells}return JSON.stringify({ready:cells.length===1&&cells[0].matches(':hover')})})()`;
  return { target, hover };
}

type PolygonMove = { direction: DungeonDirection; kind: "ремкомплект" | "бит" };
function parsePolygonState(value: Record<string, unknown>): { turn: number; battleId: string; moves: PolygonMove[] } | undefined {
  if (value.ready !== true || !nonnegativeInteger(value.turn) || typeof value.battleId !== "string" || !/^\/duels\/log\/[a-z0-9]+$/i.test(value.battleId) || !Array.isArray(value.moves)) return undefined;
  const moves = value.moves.flatMap((item) => { const r = asRecord(item); return r && (r.direction === "north" || r.direction === "south" || r.direction === "east" || r.direction === "west") && (r.kind === "ремкомплект" || r.kind === "бит") ? [{ direction: r.direction as DungeonDirection, kind: r.kind as PolygonMove["kind"] }] : []; });
  if (moves.length === 0) return undefined;
  moves.sort((left, right) => (left.kind === "ремкомплект" ? -1 : 0) - (right.kind === "ремкомплект" ? -1 : 0) || ["north", "east", "south", "west"].indexOf(left.direction) - ["north", "east", "south", "west"].indexOf(right.direction));
  return { turn: value.turn, battleId: value.battleId, moves };
}

function dungeonMoveDom(direction: DungeonDirection): { target: string; hover: string } {
  const word: Record<DungeonDirection, string> = { north: "север", south: "юг", east: "восток", west: "запад" };
  const label = word[direction];
  const target = `(() => {const cells=[...document.querySelectorAll('#map .dml > .dmc.em_font.dmv[role="gridcell"]')].filter(c=>new RegExp('Идите на ${label}','u').test((c.querySelector(':scope > div')?.getAttribute('title')||'')));if(cells.length!==1)return JSON.stringify({ready:false});const a=cells[0],r=a.getBoundingClientRect(),s=getComputedStyle(a),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return JSON.stringify({ready:s.display!=='none'&&s.visibility!=='hidden'&&r.width>4&&r.height>4&&!!hit&&(hit===a||a.contains(hit)),x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)})})()`;
  const hover = `(() => {const cells=[...document.querySelectorAll('#map .dml > .dmc.em_font.dmv[role="gridcell"]')].filter(c=>new RegExp('Идите на ${label}','u').test((c.querySelector(':scope > div')?.getAttribute('title')||'')));return JSON.stringify({ready:cells.length===1&&cells[0].matches(':hover')})})()`;
  return { target, hover };
}

function parseDungeonState(value: Record<string, unknown>): DungeonMap | undefined {
  if (value.ready !== true || !nonnegativeInteger(value.turn) || typeof value.battleId !== "string" || !/^\/duels\/log\/[a-z0-9]+$/i.test(value.battleId) || !asRecord(value.position) || !Array.isArray(value.cells) || !Array.isArray(value.legalMoves)) return undefined;
  const point = (item: unknown): { x: number; y: number } | undefined => { const r = asRecord(item); return r && nonnegativeInteger(r.x) && nonnegativeInteger(r.y) ? { x: r.x, y: r.y } : undefined; };
  const position = point(value.position); if (!position) return undefined;
  const cells = value.cells.flatMap((item) => { const r = asRecord(item), p = point(item); return r && p && typeof r.text === "string" && typeof r.title === "string" && typeof r.wall === "boolean" && typeof r.unknown === "boolean" ? [{ ...p, text: r.text, title: r.title, wall: r.wall, unknown: r.unknown }] : []; });
  const legalMoves = value.legalMoves.flatMap((item) => { const r = asRecord(item), p = point(item); return r && p && (r.direction === "north" || r.direction === "south" || r.direction === "east" || r.direction === "west") ? [{ ...p, direction: r.direction as DungeonDirection }] : []; });
  return { cells, legalMoves, position, turn: value.turn, battleId: value.battleId, otherGodDirected: false };
}

function hasResources(observation: ObservationV1, command: ReviewedLiveCommand): boolean {
  return observation.prana !== undefined && observation.prana.current >= command.maxPrana
    && observation.charges !== undefined && observation.charges >= command.maxCharges + (command.maxCharges > 0 ? 100 : 0);
}

class OrcaGodvilleAdapter implements LiveBrowserAdapter {
  private stableEventFingerprint: string | undefined;
  private readonly jiggler: Jiggler;
  constructor(private readonly pageId: string, private readonly command: "orca" | "orca-dev", private readonly executor: OrcaLiveExecutor, private readonly clock: JigglerClock, private readonly heroId: string | undefined, private readonly zpgEnabled: boolean, private readonly zpgWindow: { minOffsetSeconds: number; maxOffsetSeconds: number } | undefined, config?: JigglerConfig, fixtureMode = false) { this.jiggler = new Jiggler(clock, config, fixtureMode ? "fixture" : "production"); }
  private async exec(args: readonly string[]): Promise<string> { try { return (await this.executor(this.command, args, { timeout: MAX_TIMEOUT_MS })).stdout; } catch { throw new Error("live browser transport failed"); } }
  private async evaluate(expression: string): Promise<Record<string, unknown>> { return parseEval(await this.exec(["eval", "--page", this.pageId, "--expression", expression, "--json"])); }
  private async snapshot(): Promise<{ observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; polygonTurn?: number; battleId?: string }> {
    const raw = await this.evaluate(GODVILLE_OBSERVE_EXPRESSION);
    let snapshot: { observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; polygonTurn?: number; battleId?: string };
    try { snapshot = parseSnapshot(raw, this.clock.now().toISOString(), this.heroId); }
    catch {
      const arena = await this.evaluate(GODVILLE_ARENA_STATE_EXPRESSION);
      const fallback = parseArenaFallback(raw, arena, this.clock.now().toISOString(), this.heroId);
      if (!fallback) throw new Error("live Godville DOM contract is unknown");
      snapshot = fallback;
    }
    // Headings are localized and vary during city/rest cycles. Conversely, hidden
    // field roots can remain mounted during active adventures. Reconcile the
    // heading parser against the reviewed structural field contract.
    if (snapshot.observation.mode === "idle" || snapshot.observation.mode === "unknown") {
      try {
        const field = await this.evaluate(GODVILLE_FIELD_STATE_EXPRESSION);
        if (field.idle === true && snapshot.observation.mode === "unknown") snapshot.observation = { ...snapshot.observation, mode: "idle", rawShape: [...snapshot.observation.rawShape, "field-structure"] };
        if (field.idle !== true && snapshot.observation.mode === "idle") snapshot.observation = { ...snapshot.observation, mode: "unknown", rawShape: [...snapshot.observation.rawShape, "field-structure-mismatch"] };
      } catch { snapshot.observation = { ...snapshot.observation, mode: "unknown", rawShape: [...snapshot.observation.rawShape, "field-structure-unavailable"] }; }
    }
    if (snapshot.observation.mode === "unknown") {
      try {
        const arena = await this.evaluate(GODVILLE_ARENA_STATE_EXPRESSION);
        if (arena.active === true) snapshot.observation = { ...snapshot.observation, mode: "arena", rawShape: [...snapshot.observation.rawShape, "arena-active", ...(arena.terminal === true ? ["arena-terminal"] : [])] };
      } catch { /* unknown active pages remain fail-closed */ }
    }
    if (snapshot.observation.mode === "idle") {
      try {
        const readiness = await this.evaluate(GODVILLE_IDLE_READINESS_EXPRESSION);
        const shape = [...snapshot.observation.rawShape];
        if (readiness.polygon === true) shape.push("polygon-ready");
        if (this.zpgEnabled && readiness.arena === true && isZpgEntryWindow(this.clock.now(), this.zpgWindow)) shape.push("zpg-ready", "zpg-arena");
        if (this.zpgEnabled && readiness.arena === true && this.clock.now().getUTCMinutes() >= 55) shape.push("arena-window-reserved");
        snapshot.observation = { ...snapshot.observation, rawShape: shape };
      } catch { /* cooldown, hidden control, or unknown DOM means no polygon readiness */ }
    }
    const eventFingerprint = snapshot.dungeonTurn !== undefined ? `dungeon-turn:${snapshot.battleId!}:${snapshot.dungeonTurn}` : snapshot.polygonTurn !== undefined ? `polygon-turn:${snapshot.battleId!}:${snapshot.polygonTurn}` : `diary:${snapshot.diaryFingerprint}`;
    if (this.stableEventFingerprint === eventFingerprint) snapshot.observation = { ...snapshot.observation, eventId: snapshot.dungeonTurn !== undefined || snapshot.polygonTurn !== undefined ? `godville-${eventFingerprint}` : `godville-diary-fnv1a32:${snapshot.diaryFingerprint}` };
    this.stableEventFingerprint = eventFingerprint;
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
    if (command.id === "arena.zpg.start" && (!this.zpgEnabled || !isZpgEntryWindow(this.clock.now(), this.zpgWindow))) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: this.zpgEnabled ? "ZPG first-minute entry window is closed" : "ZPG is disabled by runtime configuration" });
    let before: { observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; battleId?: string };
    try { before = await this.snapshot(); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh live DOM observation is unavailable" }); }
    if (!command.allowedModes.includes(before.observation.mode) || !hasResources(before.observation, command)) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "observed mode or fixed command resources are unavailable" });
    await this.jiggler.waitReaction();
    let target: { x: number; y: number; width: number; height: number } | undefined;
    let rechecked: { observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; battleId?: string };
    let dom = commandDom(command);
    let dungeonTurn: number | undefined, dungeonBattleId: string | undefined = before.battleId;
    let polygonTurn: number | undefined, polygonBattleId: string | undefined, polygonDirection: DungeonDirection | undefined;
    try {
      rechecked = await this.snapshot(); dungeonBattleId ??= rechecked.battleId;
      if (command.id === "dungeon.move.auto") {
        const state = parseDungeonState(await this.evaluate(GODVILLE_DUNGEON_STATE_EXPRESSION));
        if (!state) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh legal dungeon map is unavailable" });
        const choice = planDungeonStrategy(state);
        if (!choice.direction) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: choice.reason });
        dungeonTurn = state.turn; dungeonBattleId = state.battleId; dom = dungeonMoveDom(choice.direction);
      }
      if (command.id === "polygon.move.safe") {
        const state = parsePolygonState(await this.evaluate(GODVILLE_POLYGON_STATE_EXPRESSION));
        if (!state) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "no reviewed adjacent polygon repair or bit push is available" });
        polygonTurn = state.turn; polygonBattleId = state.battleId; polygonDirection = state.moves[0]!.direction; dom = polygonMoveDom(polygonDirection);
      }
      target = parseTarget(await this.evaluate(dom.target));
    } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "live DOM changed before exact action check" }); }
    if (!target || !command.allowedModes.includes(rechecked.observation.mode) || !hasResources(rechecked.observation, command)) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "exact action preconditions changed before click" });
    const relative = this.jiggler.point(target); if (!relative) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "target geometry is too small for bounded pointer movement" });
    try {
      const first = this.jiggler.point(target); if (!first) throw new Error();
      await this.pointer("move", { x: target.x + first.x, y: target.y + first.y });
      await this.pointer("move", { x: target.x + relative.x, y: target.y + relative.y });
    } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "pointer could not reach the exact action" }); }
    try { if ((await this.evaluate(dom.hover)).ready !== true) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "pointer is no longer over the exact action" }); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "final hit test is unavailable" }); }
    let finalSnapshot: { observation: ObservationV1; diaryFingerprint: number; dungeonTurn?: number; battleId?: string };
    try { finalSnapshot = await this.snapshot(); } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "final fresh observation is unavailable" }); }
    dungeonBattleId ??= finalSnapshot.battleId;
    if (!command.allowedModes.includes(finalSnapshot.observation.mode) || !hasResources(finalSnapshot.observation, command)) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh action preconditions changed before journal gate" });
    if (command.id === "dungeon.move.auto" && (!dungeonTurn || !dungeonBattleId || !finalSnapshot.observation.eventId?.endsWith(`:${dungeonTurn}`))) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "dungeon turn changed before journal gate" });
    if (command.id === "polygon.move.safe") {
      try {
        const state = parsePolygonState(await this.evaluate(GODVILLE_POLYGON_STATE_EXPRESSION));
        if (!state || state.turn !== polygonTurn || state.battleId !== polygonBattleId || !polygonDirection || !state.moves.some((move) => move.direction === polygonDirection)) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "polygon turn, boss health, or reviewed adjacent target changed before journal gate" });
      } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "fresh polygon state is unavailable before journal gate" }); }
    }
    if (!(await options.beforeClick({ command, observation: finalSnapshot.observation }))) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: options.denialReason?.() ?? "journal did not grant this intent" });
    // Journal persistence is asynchronous. Rebind the exact reviewed target after
    // it completes so a rerender cannot turn a previously-safe pointer into a click
    // on a different control or map cell.
    try {
      const rebound = parseTarget(await this.evaluate(dom.target));
      if (!rebound || rebound.x !== target.x || rebound.y !== target.y || rebound.width !== target.width || rebound.height !== target.height || (await this.evaluate(dom.hover)).ready !== true) {
        return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "exact target changed after journal gate" });
      }
    } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "exact target could not be rebound after journal gate" }); }
    let polygonPromptArmed = false;
    if (command.id === "adventure.polygon.start" || command.id === "arena.zpg.start") {
      try {
        const arm = command.id === "adventure.polygon.start" ? GODVILLE_POLYGON_CONFIRM_ARM_EXPRESSION : GODVILLE_ARENA_CONFIRM_ARM_EXPRESSION;
        polygonPromptArmed = (await this.evaluate(arm)).ready === true;
        if (!polygonPromptArmed) return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "reviewed native confirmation handler could not be armed" });
      } catch { return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: "reviewed native confirmation handler is unavailable" }); }
    }
    const restorePolygonPrompt = async (): Promise<void> => {
      if (!polygonPromptArmed) return;
      try { await this.evaluate(command.id === "arena.zpg.start" ? GODVILLE_ARENA_CONFIRM_RESTORE_EXPRESSION : GODVILLE_POLYGON_CONFIRM_RESTORE_EXPRESSION); } catch { /* a blocked native dialog is handled by the bounded one-shot shim */ }
      polygonPromptArmed = false;
    };
    let downAttempted = false;
    if ((options.beforePhysicalClick && !options.beforePhysicalClick()) || (command.id === "arena.zpg.start" && !isZpgEntryWindow(this.clock.now(), this.zpgWindow))) {
      await restorePolygonPrompt();
      return this.finish(options, { state: "SKIPPED", clicked: false, confirmed: false, ambiguous: false, reason: command.id === "arena.zpg.start" && !isZpgEntryWindow(this.clock.now(), this.zpgWindow) ? "ZPG entry window closed before physical click" : "writer lease or stop signal changed before physical click" });
    }
    try { downAttempted = true; await this.pointer("down"); await this.pointer("up"); } catch {
      if (downAttempted) { try { await this.pointer("up"); } catch { /* best-effort release after an uncertain pointer failure */ } }
      await restorePolygonPrompt();
      return this.finish(options, { state: "AMBIGUOUS", clicked: downAttempted, confirmed: false, ambiguous: true, reason: "pointer action was authorized but its result is uncertain; do not retry" });
    }
    const started = this.clock.now().getTime();
    while (this.clock.now().getTime() - started <= POSTCONDITION_TIMEOUT_MS) {
      try {
        const after = await this.snapshot();
        const beforePrana = finalSnapshot.observation.prana!.current, afterPrana = after.observation.prana!.current;
        const beforeCharges = finalSnapshot.observation.charges!, afterCharges = after.observation.charges!;
        const encouraged = command.id === "hero.encourage" && beforePrana - afterPrana === 25 && (after.diaryFingerprint !== finalSnapshot.diaryFingerprint || (after.observation.mode === "dungeon" && after.observation.eventId?.startsWith(`godville-dungeon-turn:${dungeonBattleId}:`) === true));
        // Restoration affects the god resource, which need not add a hero diary row.
        const restored = command.id === "hero.restore_prana" && afterPrana === Math.min(100, beforePrana + 50) && beforeCharges - afterCharges === 1;
        const dungeonStarted = (command.id === "adventure.dungeon.start" || command.id === "adventure.polygon.start" || command.id === "arena.zpg.start") && after.observation.mode !== "idle" && after.diaryFingerprint !== finalSnapshot.diaryFingerprint && (beforePrana - afterPrana === 50 || beforePrana - afterPrana === 25);
        // Party turns advance autonomously, so a later turn alone cannot confirm a map click.
        // The immediate observed five-prana debit on the same battle is the reviewed action evidence.
        const dungeonMoved = command.id === "dungeon.move.auto" && after.observation.mode === "dungeon" && beforePrana - afterPrana === 5 && after.observation.eventId?.startsWith(`godville-dungeon-turn:${dungeonBattleId}:`) === true;
        let polygonMoved = false;
        if (command.id === "polygon.move.safe" && polygonTurn !== undefined && polygonBattleId !== undefined) polygonMoved = after.observation.mode === "polygon" && after.observation.battleId === polygonBattleId && beforePrana - afterPrana === 15;
        if (encouraged || restored || dungeonStarted || dungeonMoved || polygonMoved) {
          await restorePolygonPrompt();
          return this.finish(options, { state: "CONFIRMED", clicked: true, confirmed: true, ambiguous: false, reason: restored ? "one accumulator charge and exact bounded prana restoration confirm recharge" : dungeonMoved ? "same-battle five-prana debit confirms the reviewed legal grid movement" : polygonMoved ? "same-polygon fifteen-prana debit confirms the reviewed adjacent push" : dungeonStarted ? "new non-field state, diary event, and reviewed dungeon-entry debit confirm launch" : "fresh diary event and bounded prana change confirm the influence", observation: after.observation });
        }
      } catch {
        // A transient render or transport error after a click is not evidence of failure.
        // Keep polling read-only until the bounded confirmation window expires.
      }
      await this.clock.wait(POSTCONDITION_POLL_MS);
    }
    await restorePolygonPrompt();
    return this.finish(options, { state: "AMBIGUOUS", clicked: true, confirmed: false, ambiguous: true, reason: "no verified influence postcondition arrived; do not retry" });
  }
}

/** Creates a fixed-command Godville adapter for an already-open authenticated Orca page. */
export function createLiveGodvilleAdapter(config: LiveGodvilleAdapterConfig): LiveBrowserAdapter {
  if (!PAGE_ID.test(config.pageId)) throw new Error("live browser page ID must be a UUID");
  const command = config.command ?? "orca";
  if (command !== "orca" && command !== "orca-dev") throw new Error("live browser command must be orca or orca-dev");
  if (config.heroId !== undefined && (!config.heroId.trim() || config.heroId.length > 160)) throw new Error("live browser hero ID is invalid");
  return new OrcaGodvilleAdapter(config.pageId, command, config.executor ?? defaultExecutor, config.clock ?? systemClock, config.heroId, config.zpgEnabled === true, config.zpgWindow, config.jigglerConfig, config.fixtureMode === true);
}
