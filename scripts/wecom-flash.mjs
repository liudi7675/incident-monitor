/**
 * wecom-flash.mjs — 企业微信群机器人推送（全面模式，GitHub Actions 每10分钟运行）
 * 逻辑：
 *   1. 读 data/flashes.json（fetch-news.mjs 产物）+ data/wecom-state.json（已推送状态）
 *   2. 筛选：国内 && 标题命中严重性词（伤亡/批示/响应）&& 最近3天 && 未推送过
 *   3. 最多推 3 条/次（避免刷屏），markdown 消息
 *   4. 更新状态文件（随 flashes.json 一起 commit，实现幂等去重）
 * 首次运行（无状态文件）只记录现状不推送，防止把存量旧闻轰炸进群。
 * Webhook 从环境变量 WECOM_WEBHOOK 读取（GitHub Secrets），缺失则跳过。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WEBHOOK = process.env.WECOM_WEBHOOK || '';
const STATE_FILE = new URL('../data/wecom-state.json', import.meta.url);
const FLASH_FILE = new URL('../data/flashes.json', import.meta.url);
const MAX_PER_RUN = 3;
const SEVERE_RE = /(遇难|失联|失踪|被困|牺牲|殉职|死亡|伤亡|倒塌|坍塌|燃爆|爆炸|泥石流|溃坝|习近平|李强|批示|重要指示|国务院|工作组|调查组|挂牌督办|应急响应|Ⅰ级|Ⅱ级|Ⅲ级)/;
const CUTOFF_MS = Date.now() - 3 * 86400000;

if (!WEBHOOK) {
  console.log('未配置 WECOM_WEBHOOK，跳过企业微信推送');
  process.exit(0);
}

let flashes, state;
try {
  flashes = JSON.parse(readFileSync(FLASH_FILE, 'utf8'));
} catch {
  console.log('flashes.json 不存在，跳过');
  process.exit(0);
}
const firstRun = !existsSync(STATE_FILE);
try {
  state = firstRun ? { notified: [] } : JSON.parse(readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = { notified: [] };
}
const notified = new Set(state.notified || []);

const candidates = (flashes.items || []).filter((it) => {
  if (it.scope !== 'dom') return false;
  if (!SEVERE_RE.test(it.title)) return false;
  if (notified.has(it.id)) return false;
  const ts = it.ts || Date.parse(it.dateISO || '') || 0;
  if (ts && ts < CUTOFF_MS) return false;
  return true;
});

if (firstRun) {
  // 首次运行：只登记现状，不推送（防存量旧闻刷屏）
  const ids = (flashes.items || []).map((i) => i.id);
  writeFileSync(STATE_FILE, JSON.stringify({ notified: ids, updated: new Date().toISOString() }, null, 2));
  console.log(`首次运行：登记 ${ids.length} 条现状，不推送`);
  process.exit(0);
}

let pushed = 0;
for (const it of candidates.slice(0, MAX_PER_RUN)) {
  const content = [
    `**🚨 重大突发事件快讯（自动抓取）**`,
    `${it.title}`,
    `${it.date || ''} · 来源见链接`,
    `[查看原文](${it.url || '#'}) · [简报主页](https://liudi7675.github.io/incident-monitor/)`,
  ].join('\n');
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
    console.log('已推送:', it.title);
  } else {
    console.error('推送失败:', JSON.stringify(j), it.title);
    break; // 失败即停，下轮重试
  }
  await new Promise((r) => setTimeout(r, 800)); // 轻微限速
}

state.notified = [...notified].slice(-500); // 状态最多保留500条
state.updated = new Date().toISOString();
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log(`本轮推送 ${pushed} 条，剩余待推 ${Math.max(0, candidates.length - pushed)} 条`);
