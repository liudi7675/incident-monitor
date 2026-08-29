/**
 * fetch-news.mjs
 * 重大突发事件快讯自动抓取脚本（GitHub Actions 定时运行）
 *
 * 数据源：Google News RSS（免费、无需 API Key）
 * 输出：data/flashes.json —— 网页前端读取的最新快讯列表
 *
 * 运行：node scripts/fetch-news.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'data', 'flashes.json');

/* ---------------- 数据源（可随时增删） ---------------- */
const SOURCES = [
  {
    name: 'dom',
    label: '国内要闻',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('火灾 OR 爆炸 OR 燃爆 OR 泥石流 OR 滑坡 OR 洪水 OR 地震 OR 溃坝 OR 坍塌 OR 矿难 OR 透水 OR 事故 遇难 失联') +
      '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  },
  {
    name: 'dom-instr',
    label: '领导批示',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('(习近平 OR 李强 OR 中央领导) (批示 OR 指示 OR 部署) (灾害 OR 事故 OR 救援 OR 安全生产)') +
      '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  },
  {
    name: 'intl',
    label: '国际事故',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('(fire OR explosion OR landslide OR flood OR earthquake OR collapse OR mine) deaths killed') +
      '&hl=en-US&gl=US&ceid=US:en',
  },
];

/* 关键词过滤器：标题命中任一关键词才收录 */
const KEY_RE = /(火灾|爆炸|燃爆|泥石流|滑坡|洪水|地震|溃坝|坍塌|崩塌|矿难|透水|倾覆|侧翻|坠机|车祸|遇难|失联|伤亡|受伤|批示|指示|督办|问责|killed|deaths|dead|explosion|fire|landslide|flood|earthquake|collapse|mudslide|crash|deadly|fatal)/i;

/* 排除明显无关词（避免把正常新闻当事故） */
const SKIP_RE = /(游戏|电影|电视剧|股价|足球|篮球|世界杯|演唱会|剧集|综艺|转会|联名|评测|优惠|降价|发布|销量|财报|电影票房|收视)/i;

const MAX_ITEMS = 60; // 最多保留 60 条

function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function pickType(title) {
  if (/爆炸|燃爆|explosion|blast/i.test(title)) return 'blast';
  if (/火|fire|blaze/i.test(title)) return 'fire';
  if (/泥石流|滑坡|mudslide|landslide|洪水|flood|地震|earthquake|溃坝/i.test(title)) return 'geo';
  if (/坍塌|崩塌|collapse|坍塌|矿难|透水|mine/i.test(title)) return 'collapse';
  return 'other';
}

async function fetchRss(src) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IncidentMonitor/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${src.label} HTTP ${res.status}`);
  const xml = await res.text();

  const items = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const b of blocks) {
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const link = (b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || '';
    const pubDate = (b.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/) || [])[1] || '';
    if (!title) continue;
    const clean = title
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    if (!KEY_RE.test(clean)) continue;
    if (SKIP_RE.test(clean)) continue;
    items.push({ title: clean, link, pubDate, src: src.name });
  }
  return items;
}

async function main() {
  const results = [];
  for (const src of SOURCES) {
    try {
      const items = await fetchRss(src);
      console.log(`[ok] ${src.label}: ${items.length} 条`);
      results.push(...items);
    } catch (e) {
      console.log(`[warn] ${src.label}: ${e.message}`);
    }
  }

  // 按标题去重（保留最早出现）
  const seen = new Set();
  const items = [];
  for (const it of results) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    items.push({
      id: 'FL-' + hash(it.title),
      date: (() => { const t = Date.parse(it.pubDate); return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); })(),
      dateISO: it.pubDate,
      scope: it.src === 'intl' ? 'intl' : 'dom',
      type: pickType(it.title),
      title: it.title,
      url: it.link || '#',
    });
    if (items.length >= MAX_ITEMS) break;
  }

  // 按发布时间倒序（粗略按 ISO 字符串倒序）
  items.sort((a, b) => (b.dateISO || '').localeCompare(a.dateISO || ''));

  const payload = {
    updated: new Date().toISOString(),
    note: '由 GitHub Actions 自动生成，请勿手工修改；修改请编辑仓库内 index.html 的 INCIDENTS 核心事件库。',
    items,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  const oldRaw = (() => { try { return readFileSync(OUT_FILE, 'utf8'); } catch { return ''; } })();
  const newRaw = JSON.stringify(payload, null, 2);

  if (oldRaw === newRaw) {
    console.log('数据无变化，跳过写入');
    return;
  }
  writeFileSync(OUT_FILE, newRaw, 'utf8');
  console.log(`已写入 ${OUT_FILE}，共 ${items.length} 条快讯`);
}

main().catch((e) => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
