/**
 * debug-rss.mjs —— 诊断脚本（只读，不推送、不写状态）
 * 目的：确认 Google News RSS 在 Actions 环境下到底返回了哪些标题，
 *       以及"顺德火灾"这类事件在哪一层被丢弃。
 * 运行：node scripts/debug-rss.mjs
 */
const Q = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q);
const CN = '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const QUERIES = [
  { name: 'patrol-natural', url: Q('暴雨 OR 洪涝 OR 山洪 OR 台风 OR 龙卷风 OR 泥石流 OR 山体滑坡 OR 滑坡 OR 崩塌 OR 塌方 OR 地震 OR 溃坝 OR 坍塌 OR 倒塌') + CN },
  { name: 'patrol-accident', url: Q('火灾 OR 爆炸 OR 燃爆 OR 踩踏 OR 坠机 OR 空难 OR 沉船 OR 翻船 OR 矿难 OR 透水 OR 危化品事故 OR 起火') + CN },
  { name: 'patrol-casualty', url: Q('(遇难 OR 失联 OR 失踪 OR 伤亡 OR 被困) (洪水 OR 台风 OR 地震 OR 泥石流 OR 滑坡 OR 火灾 OR 爆炸 OR 矿难 OR 事故 OR 灾害)') + CN },
  { name: 'patrol-response', url: Q('"Ⅰ级响应" OR "Ⅱ级响应" OR 国家防总 OR 特大自然灾害 OR 重大事故 OR 国务院工作组 OR 国家消防救援局') + CN },
  { name: 'debug-shunde', url: Q('顺德 OR 纺织厂 OR 佛山火灾') + CN },
  { name: 'debug-fire-when', url: Q('火灾 when:2d') + CN },
];

const KEYWORD_RE = /(顺德|纺织|佛山|均安|火灾|起火|爆炸)/;

function parseItems(xml) {
  const items = [];
  for (const b of (xml.match(/<item>([\s\S]*?)<\/item>/g) || [])) {
    const title = ((b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const pubDate = (b.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/) || [])[1] || '';
    items.push({ title, ts: Date.parse(pubDate) || 0, pubDate });
  }
  return items;
}

for (const src of QUERIES) {
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IncidentMonitor/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    console.log(`\n===== [${src.name}] HTTP ${res.status} =====`);
    if (!res.ok) continue;
    const items = parseItems(await res.text());
    console.log(`共 ${items.length} 条`);
    const hits = items.filter(it => KEYWORD_RE.test(it.title));
    console.log(`命中关键词(火灾/顺德/佛山等) ${hits.length} 条：`);
    for (const h of hits) {
      console.log(`  - ${h.pubDate} | ${h.title.slice(0, 70)}`);
    }
    // 最早的5条，看时间覆盖范围
    const sorted = [...items].sort((a, b) => a.ts - b.ts);
    console.log('时间最早的5条：');
    for (const it of sorted.slice(0, 5)) console.log(`  * ${it.pubDate} | ${it.title.slice(0, 50)}`);
  } catch (e) {
    console.log(`\n===== [${src.name}] 失败: ${e.message} =====`);
  }
  await new Promise(r => setTimeout(r, 1500));
}
console.log('\n诊断完成');
