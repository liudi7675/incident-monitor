/**
 * wecom-template.mjs — 企业微信固定模板消息生成器
 * 模板：{事件名}，XX人遇难、XX人失联、XX人受伤。地址：{省市区}，请及时排查承保保单和理赔报案情况。
 *       事发时间：XXXX年X月X日 HH:MM
 *       详情：{官网链接}
 *
 * 用法：
 *   node scripts/wecom-template.mjs QD-0910   → 按事件 id 输出模板消息
 *   node scripts/wecom-template.mjs --all     → 输出全部国内事件
 * 也可 import：formatIncidentMsg / shortName / resolveOfficialUrl / isOfficialUrl
 */
import { readFileSync } from 'node:fs';

const URL_HOME = 'https://liudi7675.github.io/incident-monitor/';

/** 官方网站域名白名单（仅这些来源的链接可作为推送"详情"） */
export const OFFICIAL_DOMAINS = [
  'gov.cn', 'www.gov.cn', 'mem.gov.cn', 'mps.gov.cn', '119.gov.cn', 'cneb.gov.cn',
  'news.cn', 'xinhuanet.com', 'people.com.cn', 'cctv.com', 'cctv.cn',
  'chinanews.com.cn', 'gmw.cn', 'legaldaily.com.cn', 'chinawater.com.cn',
  'china.com.cn', 'ce.cn', 'workercn.cn', 'cnr.cn', 'cetv.cn',
];

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isOfficialUrl(u) {
  if (!u) return false;
  const d = domainOf(u);
  return OFFICIAL_DOMAINS.some((o) => d === o.replace(/^www\./, '') || d.endsWith('.' + o.replace(/^www\./, '')));
}

/**
 * 解析 Google News 跳转链接为真实发布页（仅 Actions 云端可访问 news.google.com）
 * 成功返回真实 URL；失败或非官方域名返回 null
 */
export async function resolveOfficialUrl(u) {
  if (!u) return null;
  if (!u.includes('news.google.com')) return isOfficialUrl(u) ? u : null;
  const gnId = u.split('/articles/')[1]?.split('?')[0];
  if (!gnId) return null;
  try {
    const req = JSON.stringify([['garturlreq', JSON.stringify([
      ['zh-CN', 'CN', ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'], null, null, 1, 1, 'CN', null, 180, null, null, null, null, 0, null, null, [1608992183, 723341000]],
      'zh-CN', 'CN', 1, [2, 3, 4, 8], 1, 0, 655000, 'CN', null, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]), gnId]]);
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(JSON.stringify([['Fbv4je', req]])),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const m = text.match(/(https?:\\?\/\\?\/[^"\\\s]+)/);
    if (!m) return null;
    const real = m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    return isOfficialUrl(real) ? real : null;
  } catch {
    return null;
  }
}

/** 事件短名：优先用事件库 short 字段；否则去掉开头的省级行政区前缀和书名号引号 */
const PROV_RE = /^(山东|西藏|河北|山西|湖南|四川|福建|广西|青海|云南|贵州|湖北|河南|陕西|甘肃|江西|安徽|浙江|江苏|广东|辽宁|吉林|黑龙江|内蒙古|宁夏|新疆|海南|北京|天津|上海|重庆)(?=[\u4e00-\u9fa5]{2})/;
export function shortName(e) {
  let t = (e.title || '未知事件').replace(/["""「」]/g, '');
  if (e.short) return e.short;
  // 仅当紧跟的是城市名（已知场景：山东青岛→青岛）才裁剪省级前缀
  if (PROV_RE.test(t) && e.city && t.startsWith(PROV_RE.exec(t)[1] + (e.city === e.prov ? '' : e.city))) {
    t = t.replace(PROV_RE, '');
  }
  return t;
}

function fmtDate(date, time) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  const base = `${y}年${m}月${d}日`;
  return time ? `${base} ${time}` : base;
}

function fmtCasualties(e) {
  const d = e.deaths, m = e.missing, j = e.injured;
  const known = [d, m, j].some((v) => v !== null && v !== undefined);
  if (!known) return '伤亡情况核实中';
  const parts = [];
  if (d > 0) parts.push(`${d}人遇难`);
  if (m > 0) parts.push(`${m}人失联`);
  if (j > 0) parts.push(`${j}人受伤`);
  if (!parts.length) return '暂无人员伤亡报告';
  return parts.join('、');
}

function fmtAddr(e) {
  if (e.place) return e.place;
  if (e.prov || e.city) return `${e.prov || ''}${e.city || ''}`;
  return '具体地点核实中';
}

/**
 * 生成固定模板消息。opts.url 可覆盖详情链接（默认用事件库 url，需为官方域名）
 */
export function formatIncidentMsg(e, opts = {}) {
  const url = (opts.url && isOfficialUrl(opts.url)) ? opts.url
    : (isOfficialUrl(e.url) ? e.url : URL_HOME);
  return [
    `${shortName(e)}，${fmtCasualties(e)}。地址：${fmtAddr(e)}，请及时排查承保保单和理赔报案情况。`,
    `事发时间：${fmtDate(e.date, e.time)}`,
    `详情：${url}`,
  ].join('\n');
}

/* ---------- CLI ---------- */
if (process.argv[1] && process.argv[1].endsWith('wecom-template.mjs')) {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const m = html.match(/const INCIDENTS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  if (!m) { console.error('INCIDENTS not found'); process.exit(1); }
  const list = eval(m[1]);
  const arg = process.argv[2];
  const dom = list.filter((e) => e.scope === 'dom');
  const targets = (!arg || arg === '--all') ? dom : dom.filter((e) => e.id === arg);
  for (const e of targets) {
    console.log('--- ' + e.id + ' ---');
    console.log(formatIncidentMsg(e));
  }
}
