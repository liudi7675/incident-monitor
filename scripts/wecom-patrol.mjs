/**
 * wecom-patrol.mjs —— 纯云端重大事件巡检推送（GitHub Actions 定时运行，不依赖本机）
 *
 * 逻辑（2026-09-21 用户规则收紧）：
 *  1. 信源只收官方：谷歌新闻 RSS 限定 site:news.cn(新华网) / site:gov.cn(政府网) / site:mem.gov.cn(应急部)
 *  2. 重点关键词：X死、X伤、X失联、火灾、爆炸、重大灾害、中央领导批示指示
 *  3. 推送门槛：死亡+受伤+失联 合计 ≥2 人；批示/指示/重大事故不论伤亡
 *  4. 过程报道/科普/救援进展类（无伤亡数字）一律不推；同事件伤亡数字无变化不重推
 *
 * 消息五要素：标题 + 伤亡统计 + 发布时间 + 地址（从标题提取省市县）+ 来源渠道。
 * 运行：node scripts/wecom-patrol.mjs （需环境变量 WECOM_WEBHOOK）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', 'data', 'wecom-patrol-state.json');
const WEBHOOK = (process.env.WECOM_WEBHOOK || '').trim();
const DRY_RUN = process.env.PATROL_DRY_RUN === '1'; // 干跑模式：只打日志不发群（测试期用）
const MAX_PUSH = 3;          // 每轮最多推送条数（防刷屏）
const FRESH_HOURS = 2;       // 只推最近 N 小时内发布的消息（覆盖上一小时 + 冗余，去重保证不重推）
const STATE_TTL_MS = 7 * 86400000; // 去重状态保留7天

if (!WEBHOOK) {
  console.log('未配置 WECOM_WEBHOOK，跳过推送');
  process.exit(0);
}

/* ---------------- 数据源（只收官方：新华网 / 政府网 / 应急管理部） ---------------- */
const Q = (q) => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q);
const CN = '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';
const SITE_LIMIT = '(site:news.cn OR site:xinhuanet.com OR site:gov.cn OR site:mem.gov.cn)';
const SOURCES = [
  { name: 'fire-blast', url: Q(`火灾 OR 爆炸 OR 起火 OR 燃爆 OR 坍塌 OR 塌方 when:2d ${SITE_LIMIT}`) + CN },
  { name: 'casualty', url: Q(`死亡 OR 遇难 OR 失联 OR 失踪 OR 伤亡 OR 被困 when:2d ${SITE_LIMIT}`) + CN },
  { name: 'leader-response', url: Q(`批示 OR 重要指示 OR 重大事故 OR 特别重大 OR 国务院工作组 OR 应急响应 when:2d ${SITE_LIMIT}`) + CN },
];

/* ---------------- 过滤规则 ---------------- */
/* 境外地名（命中即视为国外事件不推） */
const FOREIGN_RE = /(尼泊尔|不丹|孟加拉|斯里兰卡|马尔代夫|巴基斯坦|印度尼西亚|印尼|印度|日本|韩国|朝鲜|蒙古|越南|老挝|柬埔寨|泰国|缅甸|马来西亚|新加坡|菲律宾|文莱|东帝汶|哈萨克斯坦|乌兹别克斯坦|吉尔吉斯|塔吉克斯坦|土库曼斯坦|阿富汗|伊朗|伊拉克|叙利亚|黎巴嫩|约旦|以色列|巴勒斯坦|沙特|阿联酋|卡塔尔|科威特|巴林|阿曼|也门|土耳其|格鲁吉亚|亚美尼亚|阿塞拜疆|俄罗斯|俄远东|乌克兰|白俄罗斯|波兰|芬兰|瑞典|挪威|丹麦|英国|爱尔兰|法国|德国|荷兰|比利时|瑞士|奥地利|捷克|匈牙利|罗马尼亚|塞尔维亚|希腊|意大利|西班牙|葡萄牙|美国|加拿大|墨西哥|古巴|哥伦比亚|委内瑞拉|秘鲁|巴西|智利|阿根廷|澳大利亚|新西兰|斐济|埃及|利比亚|苏丹|埃塞俄比亚|肯尼亚|南非|尼日利亚|津巴布韦|赞比亚|莫桑比克|马达加斯加|地中海|红海|波斯湾|黑海|波罗的海|太平洋|大西洋|印度洋|阿拉斯加|夏威夷|鹿特丹|柏林|慕尼黑|巴黎|伦敦|纽约|洛杉矶|东京|大阪|名古屋|首尔|曼谷|河内|仰光|雅加达|马尼拉|吉隆坡|新德里|孟买|加德满都|达卡|喀布尔|德黑兰|巴格达|迪拜|伊斯坦布尔|开罗|内罗毕|莫斯科|圣彼得堡|基辅|华沙|维也纳|罗马|米兰|马德里|雅典)/;
/* 边境例外：境外灾害波及我国边境的事件仍算国内 */
const CHINA_BORDER_EV_RE = /(吉隆|西藏|日喀则|樟木|普兰|亚东|霍尔果斯|瑞丽|磨憨|凭祥|东兴|丹东|绥芬河|黑河|满洲里|二连浩特)/;

/* 事件类型词（必须是"一件事故/灾害"才会推） */
const EV_TYPE_RE2 = /(火灾|起火|燃爆|爆炸|泥石流|土石流|山体滑坡|滑坡|崩塌|塌方|坍塌|倒塌|地面塌陷|地震|海啸|溃坝|矿难|透水|冒顶|沉船|翻船|倾覆|侧翻|踩踏|坠机|空难|山洪|洪涝|洪水|台风|龙卷风|事故)/i;

/* 重大程度判定：满足其一即"重大" */
/* 伤亡数字解析：兼容「8人遇难」「遇难8人」「8人死亡」「死亡8人」「8死1伤」「致8死」等常见写法 */
const NUM_DEATH_RE = [
  /(\d+)\s*人?(?:不幸)?遇难/.source,
  /遇难[^0-9]{0,6}(\d+)/.source,
  /(\d+)\s*人死亡/.source,
  /(?:死亡|罹难)\s*(\d+)\s*人/.source,
  /(\d+)\s*死(?:\d+\s*伤)?/.source,
].map(s => new RegExp(s));
const NUM_MISSING_RE = [/(\d+)\s*人?(?:仍然)?失联/.source, /失联\s*(\d+)\s*人/.source, /(\d+)\s*人失踪/.source, /失踪\s*(\d+)\s*人/.source].map(s => new RegExp(s));
/* 受伤人数：「1人受伤」「受伤3人」「8死1伤」「重伤5人」 */
const NUM_INJURED_RE = [/(\d+)\s*人(?:受|轻|重)伤/.source, /(?:受|轻|重)伤\s*(\d+)\s*人/.source, /(\d+)\s*伤/.source].map(s => new RegExp(s));
const MAJOR_WORD_RE = /(特别重大|重大(事故|灾害|火灾|爆炸|交通事故|生产安全事故)|较大事故|Ⅰ级响应|Ⅱ级响应|国家防总|国务院(工作组|调查组|安委会)|国家消防救援局|应急管理部(工作组|启动)|习近平|李强|批示|重要指示|提级调查|挂牌督办)/i;
const CASUALTY_WORD_RE = /(遇难|失联|失踪|死亡|罹难|伤亡|被困|牺牲|殉职|受伤|重伤)/i;

/* 评论/过程报道/科普类排除（用户点名：救援过程、"跑赢泥石流的23分钟"类特写、科普等不推） */
const COMMENT_RE = /(视频｜|视频\||评论|警示|启示|盘点|解读|综述|一周|回眸|回顾|观察|思考|反思|探访|记者走进|追忆|缅怀|亲历者|讲述|逃生者|之问|如何看|为何|说明了什么|背后|23分钟|特写|侧记|手记|日记|现场直击)/i;
/* 非事件活动类排除（演练/科普/培训/预警/会议等） */
const NON_EVENT_RE = /(演练|演习|科普|培训|动员|部署会|工作会议|推进会|直播丨|直播\||专栏|访谈|百日攻坚|群防群治|气象(灾害)?(风险)?预警|预警发布|风险提示|紧急提示|安全知识|防范|避险|自救|逃生技巧|宣传|王維洛|大纪元|通话|慰问|回应|表态|的可能性|或将)/i;

/* 标题清洗：去掉谷歌新闻的"XXX消息丨"前缀和结尾" - 来源" */
function cleanTitle(t) {
  return t
    .replace(/^[^丨|]{0,12}消息\s*[丨|]\s*/, '')
    .replace(/\s+-\s+[A-Za-z0-9.\u4e00-\u9fa5（）()]{2,20}\s*$/, '')
    .trim();
}
/* 例行天气预报 */
const ROUTINE_RE = /(天气预报|天气趋势|未来三天|未来几日|未来十天|蓝色预警|黄色预警|橙色预警|红色预警|发布预警|预警发布|预计.{0,6}(有|出现)|气温)/i;

/* 官方媒体白名单（来源域名 + 媒体名双判） */
const OFFICIAL_DOMAINS = /(cctv\.com|cntv\.cn|news\.cn|xinhuanet\.com|people\.com\.cn|gov\.cn|chinanews\.com\.cn|gmw\.cn|mem\.gov\.cn|cneb\.gov\.cn|china\.com\.cn|cnr\.cn|legaldaily\.com\.cn|chinawater\.com\.cn|cma\.gov\.cn|cea\.gov\.cn|xhby\.net|yicai\.com$)/i;
const OFFICIAL_NAME_RE = /(央视|新华|人民网|人民日报|中国政府网|中国新闻网|中新网|光明|应急管理部|央广|经济日报|法治日报|环球时报|中国应急管理|央视新闻|新华社)/i;

/* ---------------- 地址提取（标题 → 省市区） ---------------- */
const PROVINCES = ['黑龙江','内蒙古','河北','山西','辽宁','吉林','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','新疆','西藏','宁夏','广西','北京','天津','上海','重庆','香港','澳门'];
const CITIES = ['石家庄','太原','呼和浩特','沈阳','长春','哈尔滨','南京','杭州','合肥','福州','南昌','济南','郑州','武汉','长沙','广州','南宁','海口','成都','贵阳','昆明','拉萨','西安','兰州','西宁','银川','乌鲁木齐','深圳','东莞','佛山','珠海','中山','惠州','汕头','湛江','茂名','肇庆','江门','韶关','清远','揭阳','潮州','汕尾','河源','阳江','云浮','梅州','唐山','保定','邯郸','秦皇岛','张家口','承德','沧州','廊坊','衡水','邢台','大同','阳泉','长治','晋城','朔州','晋中','运城','忻州','临汾','吕梁','大连','鞍山','抚顺','本溪','丹东','锦州','营口','阜新','辽阳','盘锦','铁岭','朝阳','葫芦岛','四平','辽源','通化','白山','松原','白城','延吉','齐齐哈尔','鸡西','鹤岗','双鸭山','大庆','伊春','佳木斯','七台河','牡丹江','黑河','绥化','无锡','徐州','常州','苏州','南通','连云港','淮安','盐城','扬州','镇江','泰州','宿迁','宁波','温州','嘉兴','湖州','绍兴','金华','衢州','舟山','台州','丽水','芜湖','蚌埠','淮南','马鞍山','淮北','铜陵','安庆','黄山','滁州','阜阳','宿州','六安','亳州','池州','宣城','厦门','莆田','三明','泉州','漳州','南平','龙岩','宁德','九江','景德镇','萍乡','新余','鹰潭','赣州','吉安','宜春','抚州','上饶','青岛','淄博','枣庄','东营','烟台','潍坊','济宁','泰安','威海','日照','临沂','德州','聊城','滨州','菏泽','开封','洛阳','平顶山','安阳','鹤壁','新乡','焦作','濮阳','许昌','漯河','三门峡','南阳','商丘','信阳','周口','驻马店','黄石','十堰','宜昌','襄阳','鄂州','荆门','孝感','荆州','黄冈','咸宁','随州','株洲','湘潭','衡阳','邵阳','岳阳','常德','张家界','益阳','郴州','永州','怀化','娄底','柳州','桂林','梧州','北海','防城港','钦州','贵港','玉林','百色','贺州','河池','来宾','崇左','三亚','三沙','自贡','攀枝花','泸州','德阳','绵阳','广元','遂宁','内江','乐山','南充','眉山','宜宾','广安','达州','雅安','巴中','资阳','六盘水','遵义','安顺','铜仁','曲靖','玉溪','保山','昭通','丽江','普洱','临沧','宝鸡','咸阳','铜川','渭南','延安','汉中','榆林','安康','商洛','嘉峪关','金昌','白银','天水','武威','张掖','平凉','酒泉','庆阳','定西','陇南','格尔木','海东','石河子','吐鲁番','哈密','库尔勒','阿克苏','喀什','伊宁','昌吉','日喀则','阿里','林芝','山南','那曲','和田','赤峰','通辽','鄂尔多斯','呼伦贝尔','巴彦淖尔','乌兰察布','乌海'];
/* 省直辖县级行政区（标题中通常不带"县/市"后缀） */
const DIRECT_COUNTIES = ['保亭','五指山','琼海','文昌','万宁','东方','儋州','定安','屯昌','澄迈','临高','白沙','昌江','乐东','陵水','琼中','济源','仙桃','潜江','天门'];
const CITY_RE = new RegExp('(' + CITIES.join('|') + ')');
const DCOUNTY_RE = new RegExp('(' + DIRECT_COUNTIES.join('|') + ')');
const PROV_RE = new RegExp('(' + PROVINCES.join('|') + ')');
/* 县/区/旗：匹配"XX县/旗"，"区"需紧跟在城市后且排除灾区/山区等泛称 */
const COUNTY_RE = /([\u4e00-\u9fa5]{2,3}(?:县|旗))/;
const DISTRICT_BAD = /(灾|山|城|社|景|园|矿|库|林|地|老|新|郊|军|港|湾|海|湖|江|河|桥|小|商|街)区$/;

function extractAddr(title) {
  const parts = [];
  let idx = 0;
  const prov = title.match(PROV_RE);
  if (prov) { parts.push(prov[1]); idx = prov.index + prov[1].length; }
  let rest = title.slice(idx);
  const city = rest.match(CITY_RE);
  const dcounty = !city ? rest.match(DCOUNTY_RE) : null;
  let tail = rest;
  if (city) {
    let name = city[1];
    tail = rest.slice(city.index + name.length);
    if (/^区/.test(tail)) { name += '区'; tail = tail.slice(1); } // 北京朝阳区
    parts.push(name);
  } else if (dcounty) {
    parts.push(dcounty[1]);
    tail = rest.slice(dcounty.index + dcounty[1].length);
  } else {
    const fc = tail.match(/([\u4e00-\u9fa5]{2,3}市)/); // 县级市兜底：湖南资兴市
    if (fc && !/(上市|城市|都市|超市|夜市|市场|菜市|门市|集市|开市|收市|闹市)/.test(fc[1])) {
      parts.push(fc[1]);
      tail = tail.slice(fc.index + fc[1].length);
    }
  }
  if (parts.length) {
    const cty = tail.match(COUNTY_RE);
    if (cty) {
      parts.push(cty[1].replace(/^(自治州|自治县|地区|地区?|盟|州|市|区)/, '')); // "阿克苏地区沙雅县"→"沙雅县"
    } else if (city) {
      const d = tail.match(/^([\u4e00-\u9fa5]{2,4}区)/);
      if (d && !DISTRICT_BAD.test(d[1])) parts.push(d[1]);
    }
  }
  return parts.join('');
}

function extractNum(title, res) {
  for (const re of res) {
    const m = title.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

function pickDeaths(title) {
  let d = extractNum(title, NUM_DEATH_RE);
  if (!d) {
    const m2 = title.match(/遇难[^0-9]{0,6}(\d+)/);
    if (m2) d = parseInt(m2[1], 10);
  }
  return d || 0;
}

/* 重大程度判定（2026-09-21 用户规则）：
 * ① 伤亡案件：死亡+受伤+失联 合计 ≥2 人即推
 * ② 中央领导批示/指示、重大事故、Ⅰ·Ⅱ级响应 —— 不论伤亡
 * 注：地质灾害不再免数字直推（过程报道/科普类靠"无数字不过门槛"自然挡住） */
function isMajor(title) {
  const deaths = pickDeaths(title);
  const missing = extractNum(title, NUM_MISSING_RE);
  const injured = extractNum(title, NUM_INJURED_RE);
  const cas = deaths + missing + injured;
  if (cas >= 2) return { major: true, deaths, missing, injured, cas, why: '人身伤亡' };
  if (MAJOR_WORD_RE.test(title)) return { major: true, deaths, missing, injured, cas, why: '批示/重大事故/响应' };
  return { major: false, deaths, missing, injured, cas };
}

/* 标题相似分组键（跨媒体同事件标题前缀通常一致） */
function titleKey(t) {
  return t.replace(/[\s\p{P}\p{S}]+/gu, '').replace(/（[^）]*）|\([^)]*\)/g, '').slice(0, 22);
}

function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

async function fetchRss(src) {
  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IncidentMonitor/1.0)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const b of (xml.match(/<item>([\s\S]*?)<\/item>/g) || [])) {
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const pubDate = (b.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/) || [])[1] || '';
    const clean = cleanTitle(title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim());
    if (!clean) continue;
    const siteM = b.match(/<source url="([^"]+)">([^<]+)<\/source>/);
    items.push({
      title: clean,
      pubDate,
      ts: Date.parse(pubDate) || 0,
      site: siteM ? siteM[2].trim() : '',
      siteUrl: siteM ? siteM[1].trim() : '',
    });
  }
  return items;
}

async function sendWecom(md) {
  if (DRY_RUN) {
    console.log('[DRY-RUN] 干跑模式，不发送群消息。将推送内容如下：\n' + md);
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md } }),
    signal: AbortSignal.timeout(15000),
  });
  const out = await res.json().catch(() => ({}));
  if (out.errcode !== 0) throw new Error('wecom errcode ' + out.errcode + ' ' + (out.errmsg || ''));
}

async function main() {
  // 1. 抓取
  const all = [];
  for (const src of SOURCES) {
    try {
      const items = await fetchRss(src);
      console.log(`[ok] ${src.name}: ${items.length} 条`);
      all.push(...items);
    } catch (e) {
      console.log(`[warn] ${src.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  // 2. 逐条过滤：国内 + 事件类型 + 伤亡门槛 + 非过程/科普 + 时效
  const minTs = Date.now() - FRESH_HOURS * 3600000;
  const candidates = [];
  const seenTitle = new Set();
  for (const it of all) {
    if (seenTitle.has(it.title)) continue;
    seenTitle.add(it.title);
    if (!it.ts || it.ts < minTs) continue;                    // 超过时间窗的旧闻不推
    if (COMMENT_RE.test(it.title)) continue;                  // 评论/过程报道/特写类
    if (ROUTINE_RE.test(it.title)) continue;                  // 例行预报
    if (FOREIGN_RE.test(it.title) && !CHINA_BORDER_EV_RE.test(it.title)) continue; // 国外事件
    if (!EV_TYPE_RE2.test(it.title)) continue;                // 必须是事故/灾害类
    if (NON_EVENT_RE.test(it.title)) continue;                // 演练/科普/预警/培训类
    const { major, deaths, missing, injured, cas } = isMajor(it.title);
    if (!major) {
      console.log(`[skip] 未达门槛(死${deaths}+伤${injured}+失联${missing}): ${it.title.slice(0, 45)}`); // 留痕便于排查漏判
      continue;                                               // 伤亡合计<2 且非批示/重大事故
    }
    candidates.push({ ...it, deaths, missing, injured, cas, key: titleKey(it.title), id: 'PT-' + hash(titleKey(it.title)) });
  }
  console.log(`候选重大事件: ${candidates.length} 条`);

  // 3. 可信度把关：信源已限定官方站点，仍按域名/媒体名双判，非官方来源一律不推
  const trusted = candidates.filter(c => {
    c.official = (c.siteUrl && OFFICIAL_DOMAINS.test(c.siteUrl)) || OFFICIAL_NAME_RE.test(c.site || '');
    return c.official;
  });
  console.log(`通过真实性把关: ${trusted.length} 条`);
  for (const c of candidates) {
    console.log(`[候选] ${c.official ? '官方源' : '非官方'}|死${c.deaths}伤${c.injured}失联${c.missing}|${c.title.slice(0, 45)}`);
  }

  // 5. 去重状态
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  let state = { updated: '', pushed: {} };
  try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch { /* 首次运行 */ }
  const now = Date.now();
  for (const [id, info] of Object.entries(state.pushed)) {
    if (now - info.ts > STATE_TTL_MS) delete state.pushed[id];
  }

  // 按伤亡合计降序 + 时间新优先
  trusted.sort((a, b) => b.cas - a.cas || b.ts - a.ts);

  // 6. 推送（每轮最多 MAX_PUSH 条；同事件伤亡数字无变化不重推，数字增加才推进展）
  let pushed = 0;
  for (const c of trusted) {
    if (pushed >= MAX_PUSH) break;
    const prev = state.pushed[c.id];
    if (prev && !DRY_RUN) { // 干跑模式忽略去重，完整预览将推内容
      if (!(c.cas > (prev.cas || 0))) continue; // 已推过且伤亡数字无变化 → 不重复推
      console.log(`事件进展重推: ${c.title.slice(0, 30)} (${prev.cas || 0} → ${c.cas})`);
    }
    const srcNote = c.site || '官方媒体';
    const addr = extractAddr(c.title) || '详见标题';
    const casParts = [];
    if (c.deaths) casParts.push(`${c.deaths}人遇难`);
    if (c.missing) casParts.push(`${c.missing}人失联`);
    if (c.injured) casParts.push(`${c.injured}人受伤`);
    const casText = casParts.length ? `${casParts.join('、')}（以官方通报为准）` : '人员伤亡情况以官方通报为准';
    const when = new Date(c.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const md = [
      `**${c.title}**`,
      `伤亡：${casText}`,
      `时间：${when}`,
      `地址：${addr}`,
      `来源：${srcNote}`,
    ].join('\n');
    try {
      await sendWecom(md);
      pushed++;
      if (!DRY_RUN) state.pushed[c.id] = { ts: now, cas: c.cas, title: c.title.slice(0, 60) };
      console.log(`${DRY_RUN ? '[DRY-RUN] 模拟推送' : '已推送'}: ${c.title.slice(0, 40)} | ${srcNote}`);
    } catch (e) {
      console.log(`推送失败: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!pushed) console.log('本轮无新增重大事件，不推送');

  // 7. 写状态（无论是否推送都更新，供工作流 commit 去重持久化）
  state.updated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`状态已写入，累计已推 ${Object.keys(state.pushed).length} 个事件`);
}

main().catch((e) => {
  console.error('巡检失败:', e);
  process.exit(1);
});
