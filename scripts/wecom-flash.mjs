/**
 * wecom-flash.mjs — 企业微信群机器人推送（全面模式，GitHub Actions 每10分钟运行）
 * 固定模板：
 *   {事件名}，XX人遇难、XX人失联、XX人受伤。地址：XX省XX市XX县/区/镇，请及时排查承保保单和理赔报案情况。
 *   事发时间：XXXX年X月X日
 *   来源：{官方媒体}（官网）
 *   详情：https://liudi7675.github.io/incident-monitor/
 * 规则：
 *   1. 只推「新」消息：data/wecom-state.json 去重，旧闻不推；每次最多3条
 *   2. 只推「官方媒体」发布的快讯：来源域名必须在官网白名单（央视网/新华网/人民网/中国政府网等）
 *   3. 快讯数据无伤亡/地址明细时按模板显示"核实中"；匹配到事件库（INCIDENTS）则用真实数据，
 *      详情链接用事件库中的官网原文链接（如 gov.cn）
 *   4. 首次运行只登记现状不推送，防旧闻轰炸
 *   注：谷歌新闻聚合源不提供可机器解析的官网原文直链（已实测），故快讯详情链接指向简报主页；
 *      重大事件入库（2小时巡检）推送时使用巡检修索到的官网原文链接。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { formatIncidentMsg, isOfficialUrl } from './wecom-template.mjs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const STATE_FILE = new URL('../data/wecom-state.json', import.meta.url);
const FLASH_FILE = new URL('../data/flashes.json', import.meta.url);
const INDEX_FILE = new URL('../index.html', import.meta.url);
const URL_HOME = 'https://liudi7675.github.io/incident-monitor/';
const MAX_PER_RUN = 3;
const SEVERE_RE = /(遇难|失联|失踪|被困|牺牲|殉职|死亡|伤亡|倒塌|坍塌|燃爆|爆炸|泥石流|溃坝|习近平|李强|批示|重要指示|国务院|工作组|调查组|挂牌督办|应急响应|Ⅰ级|Ⅱ级|Ⅲ级)/;
const CUTOFF_MS = Date.now() - 3 * 86400000;

/* 官方媒体白名单：来源域名或来源名命中其一即可 */
const OFFICIAL_SITE_RE = /(央视网|央视新闻|新华网|新华社|人民网|中国政府网|光明网|中国新闻网|中新网|应急管理部|经济日报|法治日报|工人日报|央广网|中国网|中国应急管理|中国政府|央视|新华)/;

if (!WEBHOOK) {
  console.log('未配置 WECOM_WEBHOOK，跳过企业微信推送');
  process.exit(0);
}

function loadIncidents() {
  try {
    const html = readFileSync(INDEX_FILE, 'utf8');
    const m = html.match(/const INCIDENTS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
    return m ? eval(m[1]) : [];
  } catch { return []; }
}

/* 快讯与事件库匹配：城市/省份关键词命中且日期接近 */
function matchIncident(incidents, flash) {
  const fd = (flash.date || '').slice(0, 10);
  for (const e of incidents) {
    if (e.scope !== 'dom') continue;
    const kw = [e.city, e.prov, (e.place || '').slice(0, 6)].filter(Boolean);
    if (!kw.some((k) => flash.title.includes(k))) continue;
    const days = Math.abs((Date.parse(fd) - Date.parse(e.date)) / 86400000);
    if (days <= 5) return e;
  }
  return null;
}

let flashes;
try {
  flashes = JSON.parse(readFileSync(FLASH_FILE, 'utf8'));
} catch {
  console.log('flashes.json 不存在，跳过');
  process.exit(0);
}
const firstRun = !existsSync(STATE_FILE);
let state = { notified: [] };
if (!firstRun) {
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { state = { notified: [] }; }
}
const notified = new Set(state.notified || []);

const incidents = loadIncidents();
const candidates = (flashes.items || []).filter((it) => {
  if (it.scope !== 'dom') return false;
  if (!SEVERE_RE.test(it.title)) return false;
  if (notified.has(it.id)) return false;
  // 只推官方媒体来源（域名或媒体名命中白名单）
  const siteOk = OFFICIAL_SITE_RE.test(it.site || '') || isOfficialUrl(it.siteUrl || '');
  if (!siteOk) return false;
  const ts = it.ts || Date.parse(it.dateISO || '') || 0;
  if (ts && ts < CUTOFF_MS) return false;
  return true;
});

if (firstRun) {
  const ids = (flashes.items || []).map((i) => i.id);
  writeFileSync(STATE_FILE, JSON.stringify({ notified: ids, updated: new Date().toISOString() }, null, 2));
  console.log(`首次运行：登记 ${ids.length} 条现状，不推送`);
  process.exit(0);
}

let pushed = 0;
for (const it of candidates.slice(0, MAX_PER_RUN)) {
  const matched = matchIncident(incidents, it);
  let content;
  if (matched) {
    content = formatIncidentMsg(matched); // 真实伤亡/地址/官网原文链接
  } else {
    content = formatIncidentMsg({
      title: it.title, date: (it.date || '').slice(0, 10),
      deaths: null, injured: null, missing: null, place: '', prov: '', city: '',
    }, { url: URL_HOME });
    content = content.replace('详情：', `来源：${it.site || '官方媒体'}（官网）\n详情：`);
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (j.errcode === 0) {
    notified.add(it.id);
    pushed++;
    console.log('已推送:', it.title, matched ? '(匹配事件库)' : '');
  } else {
    console.error('推送失败:', JSON.stringify(j), it.title);
    break;
  }
  await new Promise((r) => setTimeout(r, 800));
}

state.notified = [...notified].slice(-500);
state.updated = new Date().toISOString();
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log(`本轮推送 ${pushed} 条，剩余待推 ${Math.max(0, candidates.length - pushed)} 条`);
