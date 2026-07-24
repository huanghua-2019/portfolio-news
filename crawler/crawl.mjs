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
};

// 预警词：利好 / 利空
const ALERT = {
  pos: ["预增", "预盈", "大涨", "涨停", "回购", "增持", "中标", "签约", "合作", "获批", "利好", "扭亏", "高送转", "分红", "超预期", "创历史新高", "业绩亮眼", "营收增长", "净利润增长"],
  neg: ["预减", "预亏", "大跌", "跌停", "减持", "暴雷", "违约", "立案", "处罚", "退市", "风险", "警示", "推迟", "下调", "业绩变脸", "亏损扩大", "被查", "诉讼", "停产", "暴跌", "解禁"],
};

// 分类规则（命中即归类，按序优先）
const CAT_RULES = [
  { key: "业绩", words: ["业绩", "财报", "营收", "净利润", "预增", "预减", "预盈", "预亏", "季报", "年报", "中报", "分红", "送转"] },
  { key: "公告", words: ["公告", "披露", "停牌", "复牌", "股东大会", "增发", "配股", "可转债", "回购"] },
  { key: "股价", words: ["涨停", "跌停", "大涨", "大跌", "创历史", "新高", "新低", "异动", "拉升", "下挫", "成交额", "市值"] },
  { key: "行业", words: ["行业", "政策", "工信部", "发改委", "证监会", "央行", "利率", "关税", "出口", "进口"] },
];

function classify(it) {
  const text = (it.title || "") + " " + (it.source || "");
  let alert = null;
  const alertWords = [];
  for (const w of ALERT.pos) if (text.includes(w)) { alert = "pos"; alertWords.push(w); }
  for (const w of ALERT.neg) if (text.includes(w)) { alert = "neg"; alertWords.push(w); }
  let category = "其他";
  for (const r of CAT_RULES) {
    if (r.words.some((w) => text.includes(w))) { category = r.key; break; }
  }
  return { ...it, category, alert, alertWords };
}

function nextEarnings(months) {
  if (!months || !months.length) return null;
  const now = new Date();
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
  return { month: next.getMonth() + 1, date: next.toISOString().slice(0, 10), days };
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
  const seen = new Set();

  for (const h of holdings) {
    const raws = await fetchRss(h);
    for (const it of raws) {
      if (!it.link || seen.has(it.link)) continue;
      seen.add(it.link);
      const { title, source } = cleanTitle(it.title);
      all.push(classify({
        title,
        link: it.link,
        source: source || it.source || "未知",
        company: h.name,
        code: h.code,
        pubDate: it.pubDate,
        pubRaw: it.pubRaw,
      }));
    }
    await new Promise((r) => setTimeout(r, CONFIG.requestDelayMs));
  }

  all.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));

  const companies = holdings.map((h) => ({ ...h, nextEarnings: nextEarnings(h.earningsMonths) }));
  const out = { generatedAt: new Date().toISOString(), companies, all };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log("OK 生成 " + all.length + " 条新闻，" + companies.length + " 家公司");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
