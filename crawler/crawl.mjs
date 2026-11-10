// 持仓新闻爬虫 —— 零 npm 依赖，纯 Node 内置 fetch + 正则解析。
// 数据源策略（按优先级兜底）：
//   1) Google News RSS 直连（XML 自解析）
//   2) Google News RSS 经 rss2json
//   3) 百度新闻 RSS 直连
//   4) 百度新闻 RSS 经 rss2json
// 后端无跨域限制，因此不依赖任何公共 CORS 代理。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOLDINGS_PATH = join(ROOT, "holdings.json");
const OUT_DIR = join(ROOT, "data");
const OUT_PATH = join(OUT_DIR, "news.json");

const CONFIG = {
  timeoutMs: 20000,
  requestDelayMs: 800,
  rss2jsonBase: "https://api.rss2json.com/v1/api.json?rss_url=",
  perCompanyCap: 60,        // 单家公司最多保留条数，避免一家刷屏
  quoteTimeoutMs: 8000,     // 行情接口超时
};

// 行情代码映射（腾讯免费接口 qt.gtimg.cn，无 key）
// A股: sh/sz 前缀；港股: r_hk 前缀；美股: us 前缀
const QUOTE_CODES = {
  "贵州茅台": "sh600519",
  "五粮液": "sz000858",
  "泸州老窖": "sz000568",
  "腾讯控股": "r_hk00700",
  "拼多多": "usPDD",
  "泡泡玛特": "r_hk09992",
  "中远海控": "sh601919",
};

// 币种映射（targetPrice 字段已按各家币种存）
const QUOTE_CCY = {
  "贵州茅台": "CNY",
  "五粮液": "CNY",
  "泸州老窖": "CNY",
  "腾讯控股": "HKD",
  "拼多多": "USD",
  "泡泡玛特": "HKD",
  "中远海控": "CNY",
};

// 抓取实时行情（GBK 编码，用 TextDecoder 解码）
async function fetchQuotes(holdings) {
  const codes = holdings.map(h => QUOTE_CODES[h.name]).filter(Boolean);
  if (!codes.length) return {};
  const url = "https://qt.gtimg.cn/q=" + codes.join(",");
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(CONFIG.quoteTimeoutMs),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = await r.arrayBuffer();
    // 腾讯接口返回 GBK
    const dec = new TextDecoder("gbk");
    const text = dec.decode(buf);
    const out = {};
    const re = /v_([^=]+)="([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const sym = m[1];           // 例如 sh600519 / r_hk00700 / usPDD
      const parts = m[2].split("~");
      if (parts.length < 4) continue;
      // 字段说明见 https://qt.gtimg.cn 约定：下标 0 未知/类型, 1 名称, 2 代码, 3 现价, ...
      const price = parseFloat(parts[3]);
      if (!isFinite(price) || price <= 0) continue;
      // 时间戳：A股是连续数字（如 20260724161433），港股是 "2026/07/24 16:08:10"，美股是 "2026-07-24 09:36:20"
      const tsRaw = parts[30] || "";
      out[sym] = { price, tsRaw };
    }
    return out;
  } catch (e) {
    console.warn("quote fetch failed:", e.message);
    return {};
  }
}

// 预警词：价值投资者关注信号（去掉短期波动：大涨/涨停/大跌/跌停/暴跌/异动/主力）
const ALERT = {
  pos: [
    // 业绩
    "预增", "预盈", "扭亏", "超预期", "业绩亮眼", "营收增长", "净利润增长", "毛利率提升",
    // 资本回报/股东动作
    "回购", "增持", "股东增持", "管理层增持", "举牌", "收购", "股权激励", "员工持股",
    "分红", "派息", "高送转", "特别分红", "现金分红",
    // 经营/业务
    "中标", "签约", "新签大单", "市占率提升", "机构调研", "获批", "创历史新高",
    "龙头", "独家", "首次突破", "订单饱满", "供不应求"
  ],
  neg: [
    // 业绩
    "预减", "预亏", "业绩变脸", "亏损扩大", "低于预期",
    // 资本/股东
    "减持", "股东减持", "管理层减持", "控股股东减持", "套现", "清仓式减持",
    // 经营风险
    "暴雷", "商誉减值", "应收坏账", "客户流失", "停工", "关店", "降价促销",
    // 法律/监管
    "违约", "立案", "处罚", "问询", "监管函", "警示", "诉讼", "被查",
    // 市场风险
    "退市", "风险", "推迟", "下调", "停产", "解禁", "终止"
  ],
};

// 分类规则（命中即归类，按序优先）
const CAT_RULES = [
  { key: "业绩", words: ["业绩", "财报", "营收", "净利润", "利润", "预增", "预减", "预盈", "预亏", "季报", "年报", "中报", "一季报", "三季报", "分红", "送转", "派息", "股息", "毛利率", "现金流", "超预期", "低于预期"] },
  { key: "公告", words: ["公告", "披露", "停牌", "复牌", "股东大会", "增发", "配股", "可转债", "回购", "问询", "监管函", "澄清", "声明", "回应", "致歉", "辟谣", "立案", "处罚"] },
  { key: "股价", words: ["涨停", "跌停", "大涨", "大跌", "创历史", "新高", "新低", "异动", "拉升", "下挫", "成交额", "市值", "股价", "收涨", "收跌", "涨超", "跌超", "翻红", "翻绿", "盘中", "收盘价", "港股通", "北向资金", "南向资金", "主力"] },
  { key: "行业", words: ["行业", "政策", "工信部", "发改委", "证监会", "央行", "利率", "关税", "出口", "进口", "白酒", "酱酒", "航运", "运价", "集运", "集装箱", "电商", "直播", "游戏", "版号", "潮玩", "盲盒", "消费", "零售", "出海", "跨境"] },
  { key: "产品", words: ["新品", "发布", "上市", "预售", "联名", "开店", "门店", "微信", "视频号", "小程序", "Temu", "Labubu", "飞天", "生肖", "i茅台"] },
];

// 公司别名：标题必须命中其一才保留（过滤"顺带提到"的噪音新闻）
const ALIASES = {
  "贵州茅台": ["茅台"],
  "五粮液": ["五粮液"],
  "泸州老窖": ["泸州老窖", "老窖"],
  "腾讯控股": ["腾讯", "tencent"],
  "拼多多": ["拼多多", "pdd", "temu"],
  "泡泡玛特": ["泡泡玛特", "pop mart", "popmart", "labubu", "拉布布"],
  "中远海控": ["中远海控", "中远海运", "海控", "cosco"],
};

// 来源过滤：黑名单直接丢弃（内容农场/SEO站/复制粘贴站/无编辑团队）
const SOURCE_BLACKLIST = [
  // 内容农场 / SEO 垃圾站
  "证券之星", "中金在线", "财富号", "见道网", "时代在线",
  // 复制粘贴 / 自动聚合站（无原创编辑团队）
  "Sohu", "MSN", "Pchome电脑之家", "DoNews",
  "观点网", "中财网", "中华网",
  "手机网易网", "新浪网",
  // 散户社区 / 券商引流站（非新闻机构）
  "Moomoo", "TradingView", "同花顺",
  // 低质量 / 无关垂直站
  "风闻", "中国雄安官网", "ABB",
];

// 白名单：权威财经媒体（同标题多源转载时优先保留白名单源）
const SOURCE_WHITELIST = [
  // 一线财经媒体
  "财联社", "证券时报", "21财经", "第一财经", "华尔街见闻", "财新",
  "中国基金报", "每日经济新闻",
  // 权威门户财经频道
  "东方财富", "新浪财经", "新京报", "京报网",
  // 专业券商/数据平台
  "富途牛牛",
  // 官媒 / 央媒
  "新华网", "中国日报网", "南方日报", "广州日报新花城",
  // 行业垂直（航运/白酒/消费）
  "国际船舶网", "中外玩具网",
  // 交易所 / IR / 官方公告
  "深圳市发展和改革委员会",
];

// 来源过滤函数：返回 null=丢弃, 1=普通, 3=权威(白名单)。
// 数值即"来源权重"，用于热度排序与来源等级展示（对应 AIHOT 的 T1/T2 信源分级）。
function sourceScore(src) {
  if (!src) return 0;
  const s = String(src).trim();
  for (const b of SOURCE_BLACKLIST) if (s.includes(b)) return null;  // 黑名单→丢弃
  for (const w of SOURCE_WHITELIST) if (s.includes(w)) return 3;     // 白名单→权威(高权重)
  return 1;  // 其余普通来源（保留但低权重）
}

function classify(it, keyVars) {
  const text = (it.title || "") + " " + (it.source || "");
  let alert = null;
  const alertWords = [];
  for (const w of ALERT.pos) if (text.includes(w)) { alert = "pos"; alertWords.push(w); }
  for (const w of ALERT.neg) if (text.includes(w)) { alert = "neg"; alertWords.push(w); }
  // 优先：关键变量（各公司核心经营指标，如白酒批价/库存），命中即归此类，覆盖普通分类
  let category = "其他";
  if (keyVars && keyVars.some((w) => text.includes(w))) {
    category = "关键变量";
  } else {
    for (const r of CAT_RULES) {
      if (r.words.some((w) => text.includes(w))) { category = r.key; break; }
    }
  }
  return { ...it, category, alert, alertWords };
}

// 相关性：标题必须命中公司名/别名，过滤"顺带提到公司名"的噪音（大盘/ETF/行业泛闻）
function relevant(title, aliases) {
  const t = (title || "").toLowerCase();
  return aliases.some((a) => t.includes(String(a).toLowerCase()));
}

// 下一步财报披露日：优先读取 holdings.json 中由权威源（交易所/巨潮/港交所/IR）核实的
// nextEarningsDate；未配置时回退到按 earningsMonths「当月15日」的粗略估算（仅兜底）。
function nextEarnings(h) {
  const now = new Date();
  if (h.nextEarningsDate) {
    const d = new Date(h.nextEarningsDate + "T00:00:00");
    if (!isNaN(d)) {
      const days = Math.ceil((d - now) / 86400000);
      return {
        month: d.getMonth() + 1,
        date: h.nextEarningsDate,
        days,
        source: h.nextEarningsSource || "持仓配置",
        confirmed: !h.nextEarningsEstimated,
      };
    }
  }
  // 回退：按 earningsMonths 估算（仅当月15日，非精确，仅兜底）
  const months = h.earningsMonths;
  if (!months || !months.length) return null;
  const y = now.getFullYear();
  const cand = [];
  for (const m of months) {
    let d = new Date(y, m - 1, 15);
    if (d < now) d = new Date(y + 1, m - 1, 15);
    cand.push(d);
  }
  cand.sort((a, b) => a - b);
  const next = cand[0];
  const days = Math.ceil((next - now) / 86400000);
  return { month: next.getMonth() + 1, date: next.toISOString().slice(0, 10), days, source: "估算(月份级)", confirmed: false };
}

// 清洗标题：Google/百度 标题常形如 "正文 - 来源"，剥离尾部来源
function cleanTitle(t) {
  if (!t) return { title: "", source: null };
  const idx = t.lastIndexOf(" - ");
  if (idx > 0) {
    const tail = t.slice(idx + 3);
    if (tail.length < 25 && !/[，。、！？!?,.；;：:]/.test(tail)) {
      return { title: t.slice(0, idx), source: tail };
    }
  }
  return { title: t, source: null };
}

// 解析 RSS XML（零依赖正则）
function parseRss(xml, fallbackSource) {
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out = [];
  for (const m of blocks) {
    const b = m[1];
    const g = (x) => {
      const mm = b.match(new RegExp("<" + x + ">([\\s\\S]*?)<\\/" + x + ">"));
      return mm ? mm[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, "$1").trim() : "";
    };
    const title = g("title");
    const link = g("link");
    const sourceTag = g("source");
    const pub = g("pubDate");
    let ts = null;
    if (pub) { const d = new Date(pub); if (!isNaN(d)) ts = d.toISOString(); }
    if (title && link) out.push({ title, link, source: sourceTag || fallbackSource || "", pubDate: ts, pubRaw: pub });
  }
  return out;
}

async function fetchRss(company) {
  const q = company.name;
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; HoldingsBot/1.0)" };
  const gRss = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=zh-CN&gl=CN&ceid=CN:zh-Hans";
  const bRss = "https://news.baidu.com/ns?word=" + encodeURIComponent(q) + "&tn=newsrss&rn=20&clk=sortbytime";
  const collected = [];

  const push = (items, fallback) => {
    for (const it of items) if (it && it.title && it.link) collected.push(it.source ? it : { ...it, source: fallback || "未知" });
  };

  // 1) Google 直连
  try {
    const r = await fetch(gRss, { headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
    if (r.ok) { const xml = await r.text(); const its = parseRss(xml, "Google"); if (its.length) push(its, "Google"); }
  } catch (e) { /* ignore */ }

  // 2) Google via rss2json
  if (!collected.length) {
    try {
      const u = CONFIG.rss2jsonBase + encodeURIComponent(gRss);
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
      const j = await r.json();
      if (j.status === "ok" && j.items && j.items.length) {
        push(j.items.map((i) => ({ title: i.title, link: i.link, source: i.author || "Google", pubDate: i.pubDate ? new Date(i.pubDate).toISOString() : null, pubRaw: i.pubDate })), "Google");
      }
    } catch (e) { /* ignore */ }
  }

  // 3) 百度直连
  try {
    const r = await fetch(bRss, { headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
    if (r.ok) { const xml = await r.text(); const its = parseRss(xml, "百度"); if (its.length) push(its, "百度"); }
  } catch (e) { /* ignore */ }

  // 4) 百度 via rss2json
  if (!collected.length) {
    try {
      const u = CONFIG.rss2jsonBase + encodeURIComponent(bRss);
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(CONFIG.timeoutMs) });
      const j = await r.json();
      if (j.status === "ok" && j.items && j.items.length) {
        push(j.items.map((i) => ({ title: i.title, link: i.link, source: "百度", pubDate: i.pubDate ? new Date(i.pubDate).toISOString() : null, pubRaw: i.pubDate })), "百度");
      }
    } catch (e) { /* ignore */ }
  }

  return collected;
}

// ===== T4 一手公告源（仅美股可用；A股/港股交易所不提供简单RSS，已核实不可用） =====
// SEC EDGAR 官方 submissions API：结构化、免费、稳定。过滤 6-K/20-F/10-K/10-Q/8-K 等重大事项，
// 跳过内部人交易(4/144)等噪声。对应 AIHOT 的 T1 官方一手信源。
const EDGAR_CIK = { "拼多多": "0001737806" };
async function fetchEdgar(company, cik) {
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HoldingsBot/1.0)" },
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const rec = d.filings && d.filings.recent;
    if (!rec) return [];
    const KEEP = new Set(["6-K", "20-F", "10-K", "10-Q", "8-K"]);
    const out = [];
    const n = rec.accessionNumber.length;
    for (let i = 0; i < n && out.length < 10; i++) {
      const form = rec.form[i];
      if (!KEEP.has(form)) continue; // 跳过 4/144 内部人交易等
      const acc = rec.accessionNumber[i].replace(/-/g, "");
      const doc = rec.primaryDocument[i] || "";
      const link = doc
        ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${doc}`
        : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${form}&dateb=&owner=include&count=10`;
      const dt = rec.acceptanceDateTime[i] || rec.filingDate[i];
      const desc = rec.primaryDocDescription[i] || "";
      out.push({
        title: `${form} · ${desc || company.name} · ${rec.filingDate[i]}`,
        link, source: "SEC EDGAR", pubDate: dt ? new Date(dt).toISOString() : null, pubRaw: dt, _edgar: true,
      });
    }
    return out;
  } catch (e) { console.warn("edgar failed:", e.message); return []; }
}

// T2 模糊聚簇去重（对应 AIHOT 的 group 聚簇）
// 同公司 + 48h 时间窗 + (标题2-gram Jaccard≥0.5 且共享强数字, 或 Jaccard≥0.85) → 合并为一条。
// 强数字 = 金额(亿/万+币种)/百分比/精确日期/独立年份；年份用负向断言排除港股代码(如01919中的1919)误判。
function clusterDedup(list) {
  const WINDOW_H = 48, THRESH = 0.5, HIGH = 0.85;
  const grams = (t) => {
    // 保留小数点（金额精度对聚类关键），只去空白与中英文标点（不含 .）
    t = String(t || "").toLowerCase().replace(/[\s，。、！？!?;；:：""''()（）\[\]【】%]/g, "");
    const s = new Set();
    for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
    return s;
  };
  const jac = (a, b) => {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n);
  };
  const strongNums = (t) => {
    const s = new Set();
    for (const m of String(t).matchAll(/(?<![\d])(?:19|20)\d{2}(?![\d])/g)) s.add(m[0]); // 年份(独立词，排除代码夹带)
    for (const m of String(t).matchAll(/[\d]+(?:\.\d+)?(?:亿|万)(?:港元|美元|元)?/g)) s.add(m[0]); // 金额
    for (const m of String(t).matchAll(/[\d]+(?:\.\d+)?%/g)) s.add(m[0]); // 百分比
    for (const m of String(t).matchAll(/[\d]{1,2}月[\d]{1,2}日/g)) s.add(m[0]); // 日期
    return s;
  };
  const shareNum = (a, b) => {
    const na = strongNums(a), nb = strongNums(b);
    for (const x of na) if (nb.has(x)) return true;
    return false;
  };
  const clusters = [];
  for (const it of list) {
    const g = grams(it.title);
    let placed = false;
    for (const c of clusters) {
      if (c.company !== it.company) continue;
      const dt = Math.abs(new Date(it.pubDate) - new Date(c.rep.pubDate)) / 3600000;
      if (dt > WINDOW_H) continue;
      const j = jac(g, c.repG);
      if ((j >= THRESH && shareNum(it.title, c.rep.title)) || j >= HIGH) { c.items.push(it); placed = true; break; }
    }
    if (!placed) clusters.push({ company: it.company, rep: it, repG: g, items: [it] });
  }
  const out = [];
  for (const c of clusters) {
    // 主条目：来源权重高 > 标题长 > 时间新（权重高者优先展示，标题长者信息更全）
    const best = c.items.slice().sort((x, y) =>
      (y.sourceWeight || 1) - (x.sourceWeight || 1) ||
      (y.title.length - x.title.length) ||
      (new Date(y.pubDate) - new Date(x.pubDate))
    )[0];
    best.sourceCount = new Set(c.items.map((x) => x.source)).size; // 不同来源数，喂热度与前端
    out.push(best);
  }
  return out;
}

async function main() {
  const holdings = JSON.parse(readFileSync(HOLDINGS_PATH, "utf8"));
  let all = [];
  const seenLink = new Set();
  const seenTitle = new Set();

  for (const h of holdings) {
    const aliases = ALIASES[h.name] || [h.name];
    const raws = await fetchRss(h);
    // T4：美股一手公告（EDGAR），作为官方一手信源并入抓取流（权重最高）
    if (EDGAR_CIK[h.name]) {
      const ed = await fetchEdgar(h, EDGAR_CIK[h.name]);
      for (const it of ed) if (it && it.title && it.link) raws.push(it);
    }
    let kept = 0;
    for (const it of raws) {
      if (kept >= CONFIG.perCompanyCap) break;
      if (!it.link || seenLink.has(it.link)) continue;
      // 一手公告(EDGAR)直接视为相关、权重最高(3)，跳过 cleanTitle/白名单/别名过滤
      const ct = it._edgar ? { title: it.title, source: it.source } : cleanTitle(it.title);
      const sScore = it._edgar ? 3 : sourceScore(ct.source || it.source);
      if (sScore === null) continue;
      // 相关性过滤：标题须含公司名/别名，丢弃仅"顺带提到"的噪音
      if (!it._edgar && !relevant(ct.title, aliases)) continue;
      // 标题去重：同一新闻多源转载只留一条（优先白名单源）
      const tkey = ct.title.toLowerCase().replace(/\s+/g, "");
      if (seenTitle.has(tkey)) {
        // 已有记录：权威源(权重3)可替换普通源(权重1)
        if (sScore === 3) {
          const idx = all.findIndex(a => a._tkey === tkey && a._sScore < 3);
          if (idx >= 0) { all.splice(idx, 1); seenTitle.delete(tkey); seenLink.delete(all[idx]?._link); }
          else continue;
        } else continue;
      }
      seenLink.add(it.link);
      seenTitle.add(tkey);
      const classified = classify({
        title: ct.title,
        link: it.link,
        source: ct.source || it.source || "未知",
        company: h.name,
        code: h.code,
        pubDate: it.pubDate,
        pubRaw: it.pubRaw,
      }, h.keyVars);
      // 内部标记（不写入输出，用于去重优先级判断）
      classified._tkey = tkey;
      classified._sScore = sScore;
      classified._link = it.link;
      // 来源权重（写入输出，供前端热度排序与等级展示）
      classified.sourceWeight = sScore;
      all.push(classified);
      kept++;
    }
    await new Promise((r) => setTimeout(r, CONFIG.requestDelayMs));
  }

  // ===== T2 模糊聚簇去重 =====
  // 同公司 + 48h 时间窗 + (标题2-gram Jaccard≥0.5 且共享强数字, 或 Jaccard≥0.85)
  // 合并为一条，主条目取来源权重最高者，记录 sourceCount(不同来源数) 喂热度（对应 AIHOT 的聚簇去重）。
  // 强数字 = 金额(亿/万+币种)/百分比/精确日期/独立年份；排除港股代码(如01919中的1919)被误判。
  all = clusterDedup(all);

  // 计算热度分：来源权重 × 时间衰减 × 聚簇因子（聚合源数 sourceCount）
  // 时间衰减：约每 48 小时感减半（1/(1+ageH/48)）；聚簇因子 (1+0.3*log10(1+sourceCount))。
  const _now = Date.now();
  for (const a of all) {
    const ageH = Math.max(0, (_now - new Date(a.pubDate || Date.now()).getTime()) / 3600000);
    const decay = 1 / (1 + ageH / 48);
    const cluster = a.sourceCount || 1; // T2：同事件聚合的源数（clusterDedup 写入）
    a.heat = Number(((a._sScore || 1) * decay * (1 + 0.3 * Math.log10(1 + cluster))).toFixed(3));
  }
  // 排序：热度降序为主、时间降序为辅（对应 AIHOT 的事件热度排序）
  all.sort((a, b) => (b.heat - a.heat) || (b.pubDate || "").localeCompare(a.pubDate || ""));

  // 输出前去除内部去重标记（保留 heat / sourceWeight 供前端使用）
  all.forEach(a => { delete a._tkey; delete a._sScore; delete a._link; });

  // 抓取行情
  const quotes = await fetchQuotes(holdings);
  const companies = holdings.map((h) => {
    const q = QUOTE_CODES[h.name] ? quotes[QUOTE_CODES[h.name]] : null;
    return {
      ...h,
      nextEarnings: nextEarnings(h),
      price: q ? q.price : null,
      priceCcy: QUOTE_CCY[h.name] || null,
      priceTime: q ? q.tsRaw : null,
    };
  });
  const out = { generatedAt: new Date().toISOString(), companies, all };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("OK 生成 " + all.length + " 条新闻，" + companies.length + " 家公司");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
