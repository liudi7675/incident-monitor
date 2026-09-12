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

/* ---------------- 数据源（可随时增删） ----------------
 * 按四类关键词设计查询组：自然灾害 / 意外事件 / 程度与响应 / 政府应对
 * 另设官方网站限定组（site: 检索 gov.cn、news.cn、people.com.cn 等权威源）
 * 组间间隔 1.2 秒，避免 Google News 限流
 * ------------------------------------------------ */
const Q = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q);
const CN = '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const EN = '&hl=en-US&gl=US&ceid=US:en';

const SOURCES = [
  // —— 1. 自然灾害（气象类）——
  {
    name: 'dom-natural', label: '国内·气象灾害',
    url: Q('暴雨 OR 强降雨 OR 洪涝 OR 山洪 OR 台风 OR 龙卷风 OR 冰雹 OR 沙尘暴 OR 暴雪 OR 寒潮 OR 冻灾 OR 旱灾 OR 干旱 OR 强对流天气 OR 极端天气 OR 高温预警 OR 海啸') + CN,
  },
  // —— 2. 自然灾害（地质地震类）——
  {
    name: 'dom-geo', label: '国内·地质地震',
    url: Q('泥石流 OR 山体滑坡 OR 滑坡 OR 崩塌 OR 塌方 OR 地面塌陷 OR 地面下陷 OR 地震 OR 震级 OR 溃坝 OR 坍塌 OR 倒塌') + CN,
  },
  // —— 3. 意外事件 ——
  {
    name: 'dom-accident', label: '国内·意外事故',
    url: Q('火灾 OR 爆炸 OR 燃爆 OR 踩踏 OR 坠落 OR 坠崖 OR 坠河 OR 坠机 OR 空难 OR 发射失利 OR 翻船 OR 沉船 OR 脱轨 OR 矿难 OR 透水 OR 危化品 OR 食物中毒 OR 中毒事故 OR 泄漏事故 OR 起火') + CN,
  },
  // —— 4. 程度与应急响应 ——
  {
    name: 'dom-response', label: '国内·应急响应',
    url: Q('"Ⅰ级响应" OR "Ⅱ级响应" OR "Ⅲ级响应" OR "Ⅳ级响应" OR "启动应急响应" OR "国家防总" OR "国家消防救援局" OR "特大自然灾害" OR "重大事故"') + CN,
  },
  // —— 5. 伤亡程度（与事件词联合收窄）——
  {
    name: 'dom-casualty', label: '国内·伤亡事件',
    url: Q('(遇难 OR 失联 OR 失踪 OR 被困 OR 伤亡 OR 牺牲 OR 殉职) (洪水 OR 台风 OR 地震 OR 泥石流 OR 滑坡 OR 火灾 OR 爆炸 OR 矿难 OR 事故 OR 灾害 OR 救援)') + CN,
  },
  // —— 6. 政府应对：领导批示 ——
  {
    name: 'dom-instr', label: '国内·领导批示',
    url: Q('(习近平 OR 李强 OR 国务院 OR 中央领导) (批示 OR 重要指示 OR 部署 OR 救灾 OR 抢险 OR 工作组) (灾害 OR 事故 OR 救援 OR 安全 OR 防汛 OR 地震)') + CN,
  },
  // —— 7. 官方网站限定检索（权威源直取）——
  {
    name: 'gov-sites', label: '官方通报',
    url: Q('(site:gov.cn OR site:news.cn OR site:people.com.cn OR site:cctv.com OR site:chinanews.com.cn OR site:gmw.cn OR site:cneb.gov.cn OR site:chinawater.com.cn OR site:legaldaily.com.cn) (灾害 OR 事故 OR 预警 OR 应急响应 OR 抢险救援 OR 伤亡 OR 转移安置 OR 停运 OR 停课 OR 停工)') + CN,
  },
  // —— 8. 国际事故 ——
  {
    name: 'intl', label: '国际事故',
    url: Q('(fire OR explosion OR flood OR earthquake OR landslide OR mudslide OR typhoon OR hurricane OR tornado OR blizzard OR drought OR tsunami OR derailment OR "plane crash" OR "mine accident" OR dam collapse) (killed OR dead OR deaths OR missing OR injured OR evacuated OR rescue)') + EN,
  },
];

/* 关键词过滤器：标题命中任一关键词才收录（第二道过滤，按用户四类关键词维护） */
const KEY_RE = /(暴雨|强降雨|洪涝|洪水|山洪|台风|飓风|龙卷风|冰雹|沙尘暴|暴雪|寒潮|冻灾|旱灾|干旱|强对流|极端天气|泥石流|滑坡|山体滑坡|崩塌|塌方|坍塌|倒塌|地面塌陷|地面下陷|地面沉陷|地震|海啸|雷击|火灾|燃爆|爆炸|踩踏|坠落|坠崖|坠河|坠机|空难|发射失利|翻船|沉船|脱轨|矿难|透水|危化品|食物中毒|中毒|泄漏|泄露|疫情|溃坝|倾覆|侧翻|遇难|失联|失踪|伤亡|受伤|重伤|被困|牺牲|殉职|死亡|重大财产损失|疏散|撤离|转移|安置|停运|停课|停工|损毁|Ⅰ级响应|Ⅱ级响应|Ⅲ级响应|Ⅳ级响应|应急响应|特大自然灾害|重大事故|习近平|李强|国务院|国家防总|国家消防救援|应急管理部|中央气象台|地震台网|批示|重要指示|救灾|抢险|工作组|调查组|指导组|问责|追责|killed|dead|deaths|missing|injured|evacuated|explosion|blast|fire|flood|earthquake|quake|landslide|mudslide|typhoon|hurricane|tornado|tsunami|derail|crash|deadly|fatal)/i;

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
    await new Promise(r => setTimeout(r, 1200)); // 组间限速，防 Google News 限流
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
