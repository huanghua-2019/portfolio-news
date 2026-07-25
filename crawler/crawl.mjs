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
  // 散户社区 / 券商引流站（非新闻机构）
  "Moomoo", "富途牛牛", "TradingView", "同花顺",
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
  // 官媒 / 央媒
  "新华网", "中国日报网", "南方日报", "广州日报新花城",
  // 行业垂直（航运/白酒/消费）
  "国际船舶网", "中外玩具网",
  // 交易所 / IR / 官方公告
  "深圳市发展和改革委员会",
];

// 来源过滤函数：返回 null=丢弃, 1=普通, 2=白名单优先
function sourceScore(src) {
  if (!src) return 0;
  const s = String(src).trim();
  for (const b of SOURCE_BLACKLIST) if (s.includes(b)) return null;  // 黑名单→丢弃
  for (const w of SOURCE_WHITELIST) if (s.includes(w)) return 2;     // 白名单→优先
  return 1;  // 其余普通来源（保留但低优先）
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

async function main() {
  const holdings = JSON.parse(readFileSync(HOLDINGS_PATH, "utf8"));
  const all = [];
  const seenLink = new Set();
  const seenTitle = new Set();

  for (const h of holdings) {
    const aliases = ALIASES[h.name] || [h.name];
    const raws = await fetchRss(h);
    let kept = 0;
    for (const it of raws) {
      if (kept >= CONFIG.perCompanyCap) break;
      if (!it.link || seenLink.has(it.link)) continue;
      const ct = cleanTitle(it.title);
      // 来源过滤：黑名单直接丢弃
      const sScore = sourceScore(ct.source || it.source);
      if (sScore === null) continue;
      // 相关性过滤：标题须含公司名/别名，丢弃仅"顺带提到"的噪音
      if (!relevant(ct.title, aliases)) continue;
      // 标题去重：同一新闻多源转载只留一条（优先白名单源）
      const tkey = ct.title.toLowerCase().replace(/\s+/g, "");
      if (seenTitle.has(tkey)) {
        // 已有记录：白名单源可替换普通源
        if (sScore === 2) {
          const idx = all.findIndex(a => a._tkey === tkey && a._sScore < 2);
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
      all.push(classified);
      kept++;
    }
    await new Promise((r) => setTimeout(r, CONFIG.requestDelayMs));
  }

  all.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));

  // 输出前去除内部去重标记
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
