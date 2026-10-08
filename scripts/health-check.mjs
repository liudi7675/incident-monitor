#!/usr/bin/env node
/**
 * health-check.mjs —— 「重大突发事件监测」全链路体检
 *
 * 用途：每 10 天自动跑一遍，判断监测工具是否正常运转；
 *      任一关键环节异常即输出 `RESULT: FAIL`，供上层自动化向用户推送告警。
 *
 * 检查项：
 *   1. FastCron 外部定时任务存在、参数正确（每 15 分钟 POST dispatch）
 *   2. FastCron 最近执行心跳（最近一次执行时间 + 近 2 小时执行次数）
 *   3. GitHub 巡检工作流 wecom-patrol 心跳（最近一次运行时间/结论 + 近 2 小时运行次数）
 *   4. 巡检是否处于正式推送模式（PATROL_DRY_RUN=0），防止被改回演练模式而不推群
 *   5. 快讯数据管道 update-data 最近一次运行结论 + data/flashes.json 新鲜度与条数
 *   6. 巡检去重状态 data/wecom-patrol-state.json 是否在正常刷新
 *   7. 线上页面可访问
 *   8. 企业微信 webhook 是否仍有效（空 body 探测，不向群里发消息）
 *
 * 用法：
 *   node scripts/health-check.mjs
 *
 * 退出码：0 = 正常/仅警告；2 = 存在异常项
 *
 * 环境变量（一般不用设，默认自动定位工作区 .workbuddy/ 下的 token 文件）：
 *   GH_ACTIONS_TOKEN_FILE   细粒度 PAT 文件路径
 *   FASTCRON_TOKEN_FILE     FastCron API token 文件路径
 *   WECOM_WEBHOOK_FILE      企微 webhook 文件路径
 *   GH_OWNER / GH_REPO      默认 liudi7675 / incident-monitor
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = join(__dirname, '..', '..');            // 工作区根目录
const REPO_DIR = join(__dirname, '..');

const OWNER = process.env.GH_OWNER || 'liudi7675';
const REPO = process.env.GH_REPO || 'incident-monitor';
const PAGES = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
const FASTCRON_JOB_ID = Number(process.env.FASTCRON_JOB_ID || 21028587);

/* ===== 期望值与阈值 =====
 * 外部定时器每 15 分钟触发 → 2 小时理论 8 次
 * 人为留出余量：<3 次判异常，<6 次判警告
 */
const HEARTBEAT_WINDOW_MIN = 120;
const HB_FAIL_COUNT = 3;
const HB_WARN_COUNT = 6;
const LAST_FAIL_MIN = 60;          // 最近一次心跳距今超过 60 分钟 → 异常
const LAST_WARN_MIN = 25;          // 超过 25 分钟 → 警告
const FLASH_WARN_H = 12;           // 快讯超过 12 小时未更新 → 警告
const FLASH_FAIL_H = 36;           // 超过 36 小时 → 异常
const STATE_WARN_H = 8;            // 状态文件超过 8 小时未提交 → 警告
const STATE_FAIL_H = 26;           // 超过 26 小时 → 异常
const FB_NET_NOTE = '（网络不可达，已重试并尝试 curl 兜底）';

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail });
  const icon = level === 'PASS' ? '✅' : level === 'WARN' ? '⚠️' : '❌';
  console.log(`${icon} ${name}：${detail}`);
}
const mins = ms => Math.round(ms / 60000);
const fmtTs = ms => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function readToken(envKey, candidates) {
  const paths = process.env[envKey] ? [process.env[envKey]] : candidates;
  for (const p of paths) {
    try { if (existsSync(p)) { const v = readFileSync(p, 'utf8').trim(); if (v) return v; } } catch { /* ignore */ }
  }
  return '';
}

const GH_TOKEN = readToken('GH_ACTIONS_TOKEN_FILE', [
  join(WS, '.workbuddy', 'gh-actions.token'),
  join(WS, '.workbuddy', 'gh.token'),
]);
const FC_TOKEN = readToken('FASTCRON_TOKEN_FILE', [join(WS, '.workbuddy', 'fastcron.token')]);
const WECOM_HOOK = readToken('WECOM_WEBHOOK_FILE', [
  join(WS, '.workbuddy', 'wecom-webhook.txt'),
  join(REPO_DIR, '.workbuddy', 'wecom-webhook.txt'),
]);

const ghHeaders = {
  'Authorization': `Bearer ${GH_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'incident-monitor-health-check',
};

/* ---------- HTTP 层：fetch 重试 + curl 兜底（本机走代理，node fetch 偶发失败） ---------- */
function curlJson(url, headers, method = 'GET', body = null) {
  const args = ['-sS', '--max-time', '30'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (method !== 'GET') {
    args.push('-X', method);
    if (body !== null) args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 40000 });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

async function httpJson(url, headers = {}, { retries = 3, timeout = 25000, method = 'GET', body = null } = {}) {
  let lastErr = 'unknown';
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method, headers, body,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      const json = (() => { try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 200) }; } })();
      return { status: res.status, json, via: 'fetch' };
    } catch (e) {
      lastErr = e.message + (e.cause?.message ? ` / ${e.cause.message}` : '');
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  const j = curlJson(url, headers, method, body);       // 兜底：curl 走系统代理
  if (j) return { status: 200, json: j, via: 'curl' };
  throw new Error(lastErr);
}

async function httpStatus(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    return res.status;
  } catch {
    const args = ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '30', url];
    const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 40000 });
    const code = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isFinite(code) ? code : 0;
  }
}

async function fcCall(fn, body) {
  if (!FC_TOKEN) throw new Error('缺少 FastCron token');
  const { json } = await httpJson(`https://www.fastcron.com/api/v1/${fn}`, {
    'Authorization': `Bearer ${FC_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'incident-monitor-health-check',
  }, { retries: 2, method: 'POST', body: JSON.stringify(body || {}) });
  return json;
}

/* ---------- 心跳判定：最近一次时间 + 近窗口内次数 ---------- */
function assessHeartbeat(name, timesAsc, extra = '') {
  if (!timesAsc.length) {
    record('FAIL', name, `窗口内没有任何记录${extra}，触发链路可能已中断`);
    return;
  }
  const last = timesAsc[timesAsc.length - 1];
  const age = mins(Date.now() - last);
  const since = Date.now() - HEARTBEAT_WINDOW_MIN * 60000;
  const count = timesAsc.filter(t => t >= since).length;

  if (age > LAST_FAIL_MIN) {
    record('FAIL', name, `最近一次在 ${age} 分钟前（${fmtTs(last)}），超过 ${LAST_FAIL_MIN} 分钟阈值，触发链路已中断${extra}`);
  } else if (count < HB_FAIL_COUNT) {
    record('FAIL', name, `近 2 小时仅 ${count} 次（预期 8 次），节奏已严重变慢${extra}`);
  } else if (age > LAST_WARN_MIN) {
    record('WARN', name, `最近一次在 ${age} 分钟前，比预期的 15 分钟间隔偏慢${extra}`);
  } else if (count < HB_WARN_COUNT) {
    record('WARN', name, `近 2 小时 ${count} 次，略少于预期的 8 次${extra}`);
  } else {
    record('PASS', name, `正常：最近一次 ${age} 分钟前（${fmtTs(last)}），近 2 小时 ${count} 次${extra}`);
  }
}

async function main() {
  console.log('===== 重大突发事件监测 · 全链路体检 =====');
  console.log('时间:', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  console.log('仓库:', `${OWNER}/${REPO}`);
  console.log('');

  /* ---------- 1 & 2. FastCron 外部定时器 ---------- */
  try {
    const list = await fcCall('cron_list', {});
    const jobs = Array.isArray(list.data) ? list.data : [];
    const job = jobs.find(j => Number(j.id) === FASTCRON_JOB_ID) || null;
    if (list.status !== 'success') {
      record('FAIL', 'FastCron 任务配置', `读取任务列表失败：${list.message || JSON.stringify(list).slice(0, 150)}`);
    } else if (!job) {
      record('FAIL', 'FastCron 任务配置', `任务 id=${FASTCRON_JOB_ID} 不存在（可能被删除或停用），外部定时触发已失效`);
    } else {
      const expectUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/wecom-patrol.yml/dispatches`;
      const bad = [];
      if (job.url !== expectUrl) bad.push(`URL 被改为 ${job.url}`);
      if (String(job.httpMethod).toUpperCase() !== 'POST') bad.push(`请求方法为 ${job.httpMethod}，应为 POST`);
      if (!/^\*\/15\b/.test(String(job.expression))) bad.push(`频率为 ${job.expression}，应为 */15`);
      if (bad.length) record('FAIL', 'FastCron 任务配置', bad.join('；'));
      else record('PASS', 'FastCron 任务配置', `id=${job.id} 正常（${job.expression} / ${job.timezone} / POST）`);
    }

    const logs = await fcCall('cron_logs', { id: FASTCRON_JOB_ID });
    const rows = (Array.isArray(logs.data) ? logs.data : []).map(r => r.result || r);
    const times = rows.map(r => Number(r.time) * 1000).filter(t => t > 0).sort((a, b) => a - b);
    assessHeartbeat('FastCron 执行心跳', times);

    const recentBad = rows.filter(r => Number(r.httpStatus) !== 204 && Number(r.time) * 1000 >= Date.now() - 86400000);
    if (recentBad.length) {
      const b = recentBad[recentBad.length - 1];
      record('WARN', 'FastCron 返回码', `近 24h 有 ${recentBad.length} 次未返回 204（最近：HTTP ${b.httpStatus} ${b.error || ''}）`);
    } else {
      record('PASS', 'FastCron 返回码', '近 24h 执行均返回 204（GitHub 已受理触发）');
    }
  } catch (e) {
    record('WARN', 'FastCron 检查', `请求失败${FB_NET_NOTE}：${e.message}`);
  }

  /* ---------- 3 & 4. GitHub 巡检工作流 ---------- */
  try {
    const { json } = await httpJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/wecom-patrol.yml/runs?per_page=60`,
      ghHeaders,
    );
    const runs = Array.isArray(json.workflow_runs) ? json.workflow_runs : [];
    if (!runs.length) {
      record('FAIL', 'GitHub 巡检运行', '查询不到任何巡检运行记录（工作流可能被删除或被禁用）');
    } else {
      const last = runs[0];
      const lastAge = mins(Date.now() - new Date(last.created_at).getTime());
      if (last.conclusion && last.conclusion !== 'success') {
        record('FAIL', '最近一次巡检结论', `结论为 ${last.conclusion}（${fmtTs(new Date(last.created_at).getTime())}），巡检脚本报错：${last.html_url}`);
      } else {
        record('PASS', '最近一次巡检结论', `成功（${lastAge} 分钟前，event=${last.event}）`);
      }
      const times = runs.map(r => new Date(r.created_at).getTime()).sort((a, b) => a - b);
      assessHeartbeat('GitHub 巡检心跳', times);
    }
  } catch (e) {
    record('WARN', 'GitHub 巡检检查', `请求失败${FB_NET_NOTE}：${e.message}`);
  }

  // 4. 是否处于正式推送模式
  try {
    const { json } = await httpJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/.github/workflows/wecom-patrol.yml`,
      ghHeaders,
    );
    const content = json.content ? Buffer.from(json.content, 'base64').toString('utf8') : '';
    if (!content) record('WARN', '推送模式', '读取工作流文件失败，无法确认是否处于正式推送模式');
    else if (/PATROL_DRY_RUN:\s*'?0'?/.test(content)) record('PASS', '推送模式', 'PATROL_DRY_RUN=0（正式推送到企微群）');
    else record('FAIL', '推送模式', '工作流里 PATROL_DRY_RUN 不是 0 —— 巡检会跑但不会往群里推送');
  } catch (e) {
    record('WARN', '推送模式检查', `失败${FB_NET_NOTE}：${e.message}`);
  }

  /* ---------- 5. 快讯数据管道 + flashes 新鲜度 ---------- */
  try {
    const { json } = await httpJson(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/update-data.yml/runs?per_page=1`,
      ghHeaders,
    );
    const last = (json.workflow_runs || [])[0];
    if (!last) record('WARN', '快讯抓取管道', '查询不到 update-data 运行记录');
    else if (last.conclusion !== 'success') record('FAIL', '快讯抓取管道', `最近一次运行结论为 ${last.conclusion}：${last.html_url}`);
    else record('PASS', '快讯抓取管道', `最近一次运行成功（${mins(Date.now() - new Date(last.created_at).getTime())} 分钟前）`);
  } catch (e) {
    record('WARN', '快讯抓取管道', `检查失败${FB_NET_NOTE}：${e.message}`);
  }

  try {
    const { json } = await httpJson(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/data/flashes.json`,
      { 'User-Agent': 'incident-monitor-health-check' },
    );
    const items = Array.isArray(json.items) ? json.items.length : 0;
    const raw = json.updated || json.generatedAt || '';
    const ts = raw ? new Date(raw).getTime() : 0;
    const ageH = ts ? (Date.now() - ts) / 3600000 : Infinity;
    if (!items) record('FAIL', '快讯数据', 'flashes.json 里 0 条快讯，抓取管道异常');
    else if (!ts) record('WARN', '快讯数据', `${items} 条快讯，但无法解析更新时间字段（updated=${raw || '缺失'}）`);
    else if (ageH > FLASH_FAIL_H) record('FAIL', '快讯数据', `${items} 条快讯，但已 ${ageH.toFixed(1)} 小时未更新（超过 ${FLASH_FAIL_H}h）`);
    else if (ageH > FLASH_WARN_H) record('WARN', '快讯数据', `${items} 条快讯，已 ${ageH.toFixed(1)} 小时未更新（网页快讯可能偏旧）`);
    else record('PASS', '快讯数据', `${items} 条快讯，更新于 ${ageH.toFixed(1)} 小时前`);
  } catch (e) {
    record('WARN', '快讯数据', `读取失败${FB_NET_NOTE}：${e.message}`);
  }

  /* ---------- 6. 巡检去重状态 ---------- */
  try {
    const { json } = await httpJson(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/data/wecom-patrol-state.json`,
      { 'User-Agent': 'incident-monitor-health-check' },
    );
    const lastRunTs = Number(json.lastRunTs) || 0;
    const pushedN = Object.keys(json.pushed || {}).length;
    const ageH = lastRunTs ? (Date.now() - lastRunTs) / 3600000 : Infinity;
    if (!lastRunTs) record('WARN', '巡检去重状态', '状态文件里没有 lastRunTs 字段');
    else if (ageH > STATE_FAIL_H) record('FAIL', '巡检去重状态', `状态已 ${ageH.toFixed(1)} 小时未刷新（超过 ${STATE_FAIL_H}h），巡检实际未在运行`);
    else if (ageH > STATE_WARN_H) record('WARN', '巡检去重状态', `状态已 ${ageH.toFixed(1)} 小时未刷新（正常应约 6 小时内刷新一次）`);
    else record('PASS', '巡检去重状态', `${ageH.toFixed(1)} 小时前刷新过（累计已推 ${pushedN} 个事件）`);
  } catch (e) {
    record('WARN', '巡检去重状态', `读取失败${FB_NET_NOTE}：${e.message}`);
  }

  /* ---------- 7. 线上页面 ---------- */
  try {
    const code = await httpStatus(PAGES);
    if (code === 200) record('PASS', '线上页面', '可正常访问（HTTP 200）');
    else if (code === 0) record('WARN', '线上页面', `访问失败${FB_NET_NOTE}`);
    else record('FAIL', '线上页面', `返回 HTTP ${code}`);
  } catch (e) {
    record('WARN', '线上页面', `访问失败${FB_NET_NOTE}：${e.message}`);
  }

  /* ---------- 8. 企业微信 webhook ---------- */
  if (!WECOM_HOOK) {
    record('FAIL', '企微 webhook', '未找到 .workbuddy/wecom-webhook.txt，无法验证推送通道');
  } else {
    try {
      const { json, via } = await httpJson(WECOM_HOOK, { 'Content-Type': 'application/json' }, {
        retries: 2, method: 'POST', body: '{}',   // 空 body：不会往群里发消息，但能区分 key 是否被接受
      });
      const code = Number(json.errcode);
      if (code === 40008 || code === 40006) record('PASS', '企微 webhook', '有效（空内容探测返回 40008，说明 key 被接受）');
      else if (code === 93000) record('FAIL', '企微 webhook', '已失效（invalid webhook url），群机器人可能被删除或重置，需重新获取 webhook');
      else if (json._raw !== undefined) record('WARN', '企微 webhook', `返回非 JSON：${String(json._raw).slice(0, 120)}（via ${via}）`);
      else record('WARN', '企微 webhook', `返回未预期结果：errcode=${json.errcode} ${json.errmsg || ''}`);
    } catch (e) {
      record('WARN', '企微 webhook', `探测失败${FB_NET_NOTE}：${e.message}`);
    }
  }

  /* ---------- 汇总 ---------- */
  const fails = results.filter(r => r.level === 'FAIL');
  const warns = results.filter(r => r.level === 'WARN');
  const verdict = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'OK';

  console.log('');
  console.log('===== 体检结论 =====');
  console.log(`通过 ${results.filter(r => r.level === 'PASS').length} 项，警告 ${warns.length} 项，异常 ${fails.length} 项`);
  if (fails.length) {
    console.log('需要后台修正：');
    for (const f of fails) console.log(`  ❌ ${f.name}：${f.detail}`);
  }
  if (warns.length) {
    console.log('次要提示：');
    for (const w of warns) console.log(`  ⚠️ ${w.name}：${w.detail}`);
  }
  console.log(`RESULT: ${verdict}`);
  process.exit(verdict === 'FAIL' ? 2 : 0);
}

main().catch(e => {
  console.log('');
  console.log('❌ 体检脚本自身异常:', e.message);
  console.log('RESULT: FAIL');
  process.exit(2);
});
