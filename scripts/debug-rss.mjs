/**
 * debug-rss.mjs —— 诊断脚本（只读，不推送、不写状态）
 * 目的：复刻 wecom-patrol.mjs 的完整过滤漏斗，逐层打印"每条被抓到的标题卡在哪一步"，
 *       用于排查"0 候选"到底是时间窗问题还是过滤规则问题。
 * 运行：node scripts/debug-rss.mjs
 */
const Q = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q);
const CN = '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const SITE_NEWS = '(site:news.cn OR site:xinhuanet.com OR site:mem.gov.cn)';

/* 与线上巡检完全一致的 5 个信源（2026-10-08 版） */
const SOURCES = [
  { name: 'casualty', url: Q(`("遇难" OR "死亡" OR "失联" OR "受伤" OR "被困") (事故 OR 火灾 OR 爆炸 OR 泥石流 OR 滑坡 OR 山洪 OR 洪水 OR 台风 OR 地震 OR 坍塌) when:3d ${SITE_NEWS}`) + CN },
  { name: 'accident', url: Q(`(火灾 OR 爆炸 OR 燃爆 OR 坍塌 OR 塌方 OR 矿难 OR 透水 OR 沉船 OR 坠机 OR 事故) (致|造成|已致|伤亡) when:3d ${SITE_NEWS}`) + CN },
  { name: 'disaster', url: Q(`(泥石流 OR 山体滑坡 OR 山洪 OR 洪水 OR 台风 OR 地震 OR 溃坝 OR 龙卷风) (遇难 OR 死亡 OR 失联 OR 受伤 OR 转移 OR 救援) when:3d ${SITE_NEWS}`) + CN },
  { name: 'leader', url: Q(`(习近平 OR 李强 OR 张国清 OR 国务院安委会 OR 应急管理部) (批示 OR 重要指示 OR 作出指示 OR 挂牌督办 OR 提级调查) (事故 OR 灾害 OR 救援) when:3d ${SITE_NEWS}`) + CN },
  { name: 'gov-notice', url: Q(`(事故 OR 灾害) ("遇难" OR "死亡" OR "失联" OR "受伤") when:3d site:gov.cn`) + CN },
];

/* 与线上一致的过滤规则（只做诊断，不参与推送） */
const FOREIGN_RE = /(尼泊尔|不丹|孟加拉|斯里兰卡|马尔代夫|巴基斯坦|印度尼西亚|印尼|印度|日本|韩国|朝鲜|蒙古|越南|老挝|柬埔寨|泰国|缅甸|马来西亚|新加坡|菲律宾|文莱|东帝汶|哈萨克斯坦|乌兹别克斯坦|吉尔吉斯|塔吉克斯坦|土库曼斯坦|阿富汗|伊朗|伊拉克|叙利亚|黎巴嫩|约旦|以色列|巴勒斯坦|沙特|阿联酋|卡塔尔|科威特|巴林|阿曼|也门|土耳其|格鲁吉亚|亚美尼亚|阿塞拜疆|俄罗斯|俄远东|乌克兰|白俄罗斯|波兰|芬兰|瑞典|挪威|丹麦|英国|爱尔兰|法国|德国|荷兰|比利时|瑞士|奥地利|捷克|匈牙利|罗马尼亚|塞尔维亚|希腊|意大利|西班牙|葡萄牙|美国|加拿大|墨西哥|古巴|哥伦比亚|委内瑞拉|秘鲁|巴西|智利|阿根廷|澳大利亚|新西兰|斐济|埃及|利比亚|苏丹|埃塞俄比亚|肯尼亚|南非|尼日利亚|津巴布韦|赞比亚|莫桑比克|马达加斯加|地中海|红海|波斯湾|黑海|波罗的海|太平洋|大西洋|印度洋|阿拉斯加|夏威夷|鹿特丹|柏林|慕尼黑|巴黎|伦敦|纽约|洛杉矶|东京|大阪|名古屋|首尔|曼谷|河内|仰光|雅加达|马尼拉|吉隆坡|新德里|孟买|加德满都|达卡|喀布尔|德黑兰|巴格达|迪拜|伊斯坦布尔|开罗|内罗毕|莫斯科|圣彼得堡|基辅|华沙|维也纳|罗马|米兰|马德里|雅典)/;
const CHINA_BORDER_EV_RE = /(吉隆|西藏|日喀则|樟木|普兰|亚东|霍尔果斯|瑞丽|磨憨|凭祥|东兴|丹东|绥芬河|黑河|满洲里|二连浩特)/;
const EV_TYPE_RE2 = /(火灾|起火|燃爆|爆炸|泥石流|土石流|山体滑坡|滑坡|崩塌|塌方|坍塌|倒塌|地面塌陷|地震|海啸|溃坝|矿难|透水|冒顶|沉船|翻船|倾覆|侧翻|踩踏|坠机|空难|山洪|洪涝|洪水|台风|龙卷风|事故)/i;
const NUM_DEATH_RE = [/(\d+)\s*人?(?:不幸)?遇难/, /遇难[^0-9]{0,6}(\d+)/, /(\d+)\s*人死亡/, /(?:死亡|罹难)\s*(\d+)\s*人/, /(\d+)\s*死(?:\d+\s*伤)?/];
const NUM_MISSING_RE = [/(\d+)\s*人?(?:仍然)?失联/, /失联\s*(\d+)\s*人/, /(\d+)\s*人失踪/, /失踪\s*(\d+)\s*人/];
const NUM_INJURED_RE = [/(\d+)\s*人(?:受|轻|重)伤/, /(?:受|轻|重)伤\s*(\d+)\s*人/, /(\d+)\s*伤/];
const MAJOR_WORD_RE = /(特别重大|重大(事故|灾害|火灾|爆炸|交通事故|生产安全事故)|较大事故|Ⅰ级响应|Ⅱ级响应|国家防总|国务院(工作组|调查组|安委会)|国家消防救援局|应急管理部(工作组|启动)|习近平|李强|批示|重要指示|提级调查|挂牌督办)/i;
const COMMENT_RE = /(视频｜|视频\||评论|警示|启示|盘点|解读|综述|一周|回眸|回顾|观察|思考|反思|探访|记者走进|追忆|缅怀|亲历者|讲述|逃生者|之问|如何看|为何|说明了什么|背后|23分钟|特写|侧记|手记|日记|现场直击)/i;
const NON_EVENT_RE = /(演练|演习|科普|培训|动员|部署会|工作会议|推进会|常委会|政治局|党组会|直播丨|直播\||专栏|访谈|百日攻坚|群防群治|气象(灾害)?(风险)?预警|预警发布|风险提示|紧急提示|安全知识|防范|避险|自救|逃生技巧|宣传|王維洛|大纪元|通话|慰问|回应|表态|的可能性|或将)/i;
const DOC_RE = /(隐患|整改|清单|公示|公告|公开目录|调查报告|回溯调查|事故认定|批复|招标|采购|中标|考核|表彰|评选|问责情况|处理结果|宣判|起诉|判决|工作方案|实施方案|应急预案|条例|办法|标准|规划|通知|通报制度|检查计划|双随机)/i;
const FOLLOWUP_RE = /(调查报告|回溯|追忆|回顾|纪念|一周年|两周年|警示录|以案促改|举一反三)/i;
const ROUTINE_RE = /(天气预报|天气趋势|未来三天|未来几日|未来十天|蓝色预警|黄色预警|橙色预警|红色预警|发布预警|预警发布|预计.{0,6}(有|出现)|气温)/i;
const OFFICIAL_DOMAINS = /(cctv\.com|cntv\.cn|news\.cn|xinhuanet\.com|people\.com\.cn|gov\.cn|chinanews\.com\.cn|gmw\.cn|mem\.gov\.cn|cneb\.gov\.cn|china\.com\.cn|cnr\.cn|legaldaily\.com\.cn|chinawater\.com\.cn|cma\.gov\.cn|cea\.gov\.cn|xhby\.net|yicai\.com$)/i;
const OFFICIAL_NAME_RE = /(央视|新华|人民网|人民日报|中国政府网|中国新闻网|中新网|光明|应急管理部|央广|经济日报|法治日报|环球时报|中国应急管理|央视新闻|新华社)/i;

function cleanTitle(t) {
  return t
    .replace(/^[^丨|]{0,12}消息\s*[丨|]\s*/, '')
    .replace(/\s+-\s+[A-Za-z0-9.\u4e00-\u9fa5（）()]{2,20}\s*$/, '')
    .trim();
}
const pick = (t, res) => { for (const r of res) { const m = t.match(r); if (m) return parseInt(m[1], 10) || 0; } return 0; };

function parseItems(xml) {
  const out = [];
  for (const b of (xml.match(/<item>([\s\S]*?)<\/item>/g) || [])) {
    const raw = ((b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const pubDate = (b.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/) || [])[1] || '';
    const siteM = b.match(/<source url="([^"]+)">([^<]+)<\/source>/);
    out.push({
      title: cleanTitle(raw), pubDate, ts: Date.parse(pubDate) || 0,
      site: siteM ? siteM[2].trim() : '', siteUrl: siteM ? siteM[1].trim() : '',
    });
  }
  return out;
}

const now = Date.now();
const all = [];
for (const src of SOURCES) {
  try {
    const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IncidentMonitor/1.0)' }, signal: AbortSignal.timeout(20000) });
    console.log(`\n===== [${src.name}] HTTP ${res.status} =====`);
    if (!res.ok) continue;
    const items = parseItems(await res.text());
    const ages = items.map(i => (now - i.ts) / 3600000);
    const within = (h) => ages.filter(a => a >= 0 && a <= h).length;
    const newest = items.reduce((a, b) => (b.ts > a.ts ? b : a), items[0] || {});
    console.log(`共 ${items.length} 条 | 2h内 ${within(2)} 条 | 6h内 ${within(6)} 条 | 24h内 ${within(24)} 条 | 最新一条 ${((now - (newest.ts || 0)) / 3600000).toFixed(1)}h 前`);
    console.log(`最新 3 条: ${items.slice(0, 3).map(i => `${((now - i.ts) / 3600000).toFixed(1)}h | ${i.title.slice(0, 40)}`).join('  //  ')}`);
    all.push(...items.map(i => ({ ...i, src: src.name })));
  } catch (e) {
    console.log(`\n===== [${src.name}] 失败: ${e.message} =====`);
  }
  await new Promise(r => setTimeout(r, 1500));
}

console.log('\n############ 漏斗诊断（24h 内条目逐条判定，不计时间窗）############');
const seen = new Set();
let n24 = 0;
const stage = { 评论过程: 0, 例行预报: 0, 公文后续: 0, 境外: 0, 非事件类型: 0, 演练科普: 0, 门槛不足: 0 };
const survivors = [];
for (const it of all) {
  if (seen.has(it.title)) continue;
  seen.add(it.title);
  const ageH = (now - it.ts) / 3600000;
  if (ageH > 24 || ageH < 0) continue;
  n24++;
  let verdict = null;
  if (COMMENT_RE.test(it.title)) { stage.评论过程++; verdict = '评论/过程报道'; }
  else if (ROUTINE_RE.test(it.title)) { stage.例行预报++; verdict = '例行预报'; }
  else if (DOC_RE.test(it.title) || FOLLOWUP_RE.test(it.title)) { stage.公文后续++; verdict = '公文/后续报道'; }
  else if (FOREIGN_RE.test(it.title) && !CHINA_BORDER_EV_RE.test(it.title)) { stage.境外++; verdict = '境外事件'; }
  else if (!EV_TYPE_RE2.test(it.title)) { stage.非事件类型++; verdict = '非事故/灾害类型'; }
  else if (NON_EVENT_RE.test(it.title)) { stage.演练科普++; verdict = '演练/科普/预警'; }
  else {
    const deaths = pick(it.title, NUM_DEATH_RE), missing = pick(it.title, NUM_MISSING_RE), injured = pick(it.title, NUM_INJURED_RE);
    const cas = deaths + missing + injured;
    const major = cas >= 2 || MAJOR_WORD_RE.test(it.title);
    if (!major) { stage.门槛不足++; verdict = `门槛不足(死${deaths}伤${injured}失联${missing})`; }
    else {
      const official = (it.siteUrl && OFFICIAL_DOMAINS.test(it.siteUrl)) || OFFICIAL_NAME_RE.test(it.site);
      verdict = `✅可推(死${deaths}伤${injured}失联${missing}) 官方源=${official}`;
      survivors.push({ ...it, deaths, missing, injured, official, ageH });
    }
  }
  if (verdict.startsWith('✅') || verdict.startsWith('门槛')) console.log(`  [${ageH.toFixed(1)}h][${it.src}] ${verdict} | ${it.title.slice(0, 55)}`);
}
console.log(`\n24h 内条目: ${n24} 条`);
console.log('各层丢弃统计:', JSON.stringify(stage, null, 0));
console.log(`最终可推事件: ${survivors.length} 条`);
for (const s of survivors) console.log(`  → ${s.title.slice(0, 60)} | 来源 ${s.site}`);
console.log('\n诊断完成');
