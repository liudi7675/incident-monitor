/**
 * wecom-flash.mjs — 企业微信群机器人推送（全面模式，GitHub Actions 每10分钟运行）
 * 固定模板：
 *   {事件名}，XX人遇难、XX人失联、XX人受伤。地址：XX省XX市XX县/区/镇，请及时排查承保保单和理赔报案情况。
 *   事发时间：XXXX年X月X日 HH:MM
 *   详情：{官网链接}
 * 规则：
 *   1. 只推「新」消息：读 data/flashes.json + data/wecom-state.json 去重，旧闻不推
 *   2. 只推「官网」来源：Google News 跳转链接解码为真实发布页，域名必须在官方白名单
 *      （gov.cn/news.cn/people.com.cn/cctv.com/gmw.cn 等），否则跳过不推
 *   3. 国内 + 标题命中严重性词 + 最近3天，每次最多3条
 *   4. 快讯数据暂无伤亡/地址明细时按模板显示"伤亡情况核实中/具体地点核实中"，
 *      由每2小时巡检入库后补充；已入库事件匹配到 short/伤亡/地址则用真实数据
 *   5. 首次运行（无状态文件）只登记现状不推送，防旧闻轰炸
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { formatIncidentMsg, resolveOfficialUrl, isOfficialUrl } from './wecom-template.mjs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const STATE_FILE = new URL('../data/wecom-state.json', import.meta.url);
const FLASH_FILE = new URL('../data/flashes.json', import.meta.url);
const INDEX_FILE = new URL('../index.html', import.meta.url);
const MAX_PER_RUN = 3;
const SEVERE_RE = /(遇难|失联|失踪|被困|牺牲|殉职|死亡|伤亡|倒塌|坍塌|燃爆|爆炸|泥石流|溃坝|习近平|李强|批示|重要指示|国务院|工作组|调查组|挂牌督办|应急响应|Ⅰ级|Ⅱ级|Ⅲ级)/;
const CUTOFF_MS = Date.now() - 3 * 86400000;

if (!WEBHOOK) {
  console.log('未配置 WECOM_WEBHOOK，跳过企业微信推送');
  process.exit(0);
}

/* 加载事件库（用于给快讯匹配真实伤亡/地址/精简名） */
function loadIncidents() {
  try {
    const html = readFileSync(INDEX_FILE, 'utf8');
    const m = html.match(/const INCIDENTS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
    return m ? eval(m[1]) : [];
  } catch { return []; }
}
/* 快讯标题与事件的简单匹配：事件库城市/地名出现在快讯标题且日期接近 */
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
  // 1. 解析官网链接；解析不到官方域名的一律跳过（用户要求：链接必须是官网发布的）
  const officialUrl = await resolveOfficialUrl(it.url);
  if (!officialUrl) {
    notified.add(it.id); // 标记已处理，避免每轮重复解码失败
    console.log('跳过（非官网来源/解码失败）:', it.title);
    continue;
  }
  // 2. 组装固定模板消息
  const matched = matchIncident(incidents, it);
  const content = matched
    ? formatIncidentMsg(matched, { url: officialUrl })
    : formatIncidentMsg({
        title: it.title, date: (it.date || '').slice(0, 10),
        deaths: null, injured: null, missing: null, place: '', prov: '', city: '',
      }, { url: officialUrl });
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
    console.log('已推送:', it.title, '→', officialUrl);
  } else {
    console.error('推送失败:', JSON.stringify(j), it.title);
    break; // 失败即停，下轮重试
  }
  await new Promise((r) => setTimeout(r, 800));
}

state.notified = [...notified].slice(-500);
state.updated = new Date().toISOString();
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log(`本轮推送 ${pushed} 条，剩余待推 ${Math.max(0, candidates.length - pushed)} 条`);
