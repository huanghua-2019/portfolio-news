// ============================================================
//  持仓监控 · 新闻回看 — GitHub Pages 版逻辑
//  数据源：直接读取爬虫生成的 ./data/news.json（同源，无跨域）
//  爬虫(GitHub Actions 定时跑)负责抓取/解析/分类/预警，本文件只渲染。
// ============================================================
"use strict";

const CONFIG = {
  refreshMinutes: 30,      // 爬虫间隔，仅用于"距下次预计更新"倒计时估算
};

// ---------- 默认预警词（利好 / 利空），仅用于预警页图例与高亮 ----------
const ALERT = {
  pos: ["增持", "回购", "分红", "预增", "扭亏", "中标", "利好", "涨价", "扩产", "获批", "签约", "上调"],
  neg: ["减持", "暴雷", "违约", "处罚", "立案", "调查", "诉讼", "退市", "ST", "预减", "亏损", "停牌", "警示", "问询", "下调", "暴跌", "造假"],
};

// ---------- 状态 ----------
const state = {
  holdings: [],            // 来自 news.json.companies
  all: [],               // 全部新闻（爬虫已去重 + 打标）
  generatedAt: 0,        // 数据生成时间（爬虫跑完那一刻）
  loadError: false,
  fav: loadSet("pn_fav_gh"),
  read: loadSet("pn_read_gh"),
  filterCo: "all",
  filterBoard: "all",
  filterCat: "all",
  filterTime: "7d",      // 默认近7天，缓解长列表在手机端翻不动
  hideRead: false,
  search: "",
  view: "home",
};

// ============================================================
//  工具
// ============================================================
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));}
function loadSet(k){try{return new Set(JSON.parse(localStorage.getItem(k)||"[]"));}catch(e){return new Set();}}
function saveSet(k,s){try{localStorage.setItem(k,JSON.stringify([...s]));}catch(e){}}
function hashId(str){let h=5381;str=String(str||"");for(let i=0;i<str.length;i++)h=((h<<5)+h+str.charCodeAt(i))>>>0;return h.toString(36);}
function pad(n){return n<10?"0"+n:""+n;}
function ymd(ts){const d=new Date(ts);return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());}
function relTime(ts){const diff=Date.now()-ts;if(diff<0)return"刚刚";const m=Math.floor(diff/60000);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前";}
function dateHead(ts){const d=new Date(ts),now=new Date();const today=ymd(now),y=yesterday(ymd(now));
  if(ymd(ts)===today)return"今天 "+today;
  if(ymd(ts)===y)return"昨天 "+y;
  return ymd(ts);}
function yesterday(s){const d=new Date(s+"T00:00:00");d.setDate(d.getDate()-1);return ymd(d.getTime());}

// 目标价解析：各公司 targetPrice 字段是自然语言注释，提取「机构均价/一致预期」中的数字 + 币种
// 返回 { value, currency } 或 null（解析失败时调用方按字符串原样展示）
function parseTargetPrice(str, fallbackCcy) {
  if (!str) return null;
  const s = String(str);
  // 匹配第一个数字（含 $HK 前缀与范围 117-120 的起点）
  const m = s.match(/(?:约|均价|综合)?\s*([\$HK]?)\s*(\d{2,4}(?:\.\d+)?)/);
  if (!m) return null;
  const prefix = m[1] || "";
  // 重要：币种以「数字附近」判定，避免“主目标 17元 / 后面港币”的误识别
  // 范围：数字起点的 index ± 8 字符
  const idx = m.index + m[0].length;
  const start = Math.max(0, idx - 8), end = Math.min(s.length, idx + 8);
  const near = s.slice(start, end);
  let ccy = fallbackCcy || "CNY";
  if (/港元|港币/.test(near)) ccy = "HKD";
  else if (/美元|\$/.test(near)) ccy = "USD";
  else if (/元/.test(near)) ccy = "CNY";
  const v = parseFloat(m[2]);
  if (!isFinite(v) || v <= 0) return null;
  return { value: v, currency: ccy };
}

// 折价% = (target - price) / target，正数表示折价（便宜），负数表示溢价（贵）
// 返回 { pct, band: "hit"/"neutral"/"premium" }
function marginOf(price, target) {
  if (price == null || target == null) return null;
  const p = Number(price), t = Number(target);
  if (!isFinite(p) || !isFinite(t) || t <= 0) return null;
  const pct = (t - p) / t * 100;
  const band = pct >= 30 ? "hit" : pct >= 0 ? "neutral" : "premium";
  return { pct, band, target: t, price: p };
}

// 股息率 = DPS / 现价（%），仅在币种一致时计算
// 财报后静默期：财报披露后 ±3 天股价可能高震荡，提示用户谨慎操作
// 返回 null（不在静默期）或 {daysAgo, daysToGo, label}
function earningsQuietPeriod(h) {
  const ne = nextEarnings(h);
  if (!ne) return null;
  // inDays 是距离下次财报的天数（负数=已披露后第几天）
  if (ne.inDays < -10 || ne.inDays > 10) return null;
  const daysAgo = -ne.inDays;
  const daysToGo = ne.inDays;
  let label;
  if (ne.inDays >= 0 && ne.inDays <= 3)  label = `距财报 ≤3天`;  // 前静默
  else if (ne.inDays > -10 && ne.inDays < 0 && daysAgo <= 7)
    label = `财报后${daysAgo}天`;                                  // 后静默
  else return null;
  return { daysAgo, daysToGo, label, est: !ne.confirmed };
}

function dividendYield(h) {
  if (h == null) return null;
  const dps = h.dividendPerShare, price = h.price;
  if (dps == null || price == null || price <= 0) return null;
  const dccy = h.dividendCcy, pccy = h.priceCcy;
  if (dccy && pccy && dccy !== pccy) {
    // 币种不同，提示但不计算
    return { pct: null, mismatch: true, dccy, pccy, dps };
  }
  return { pct: dps / price * 100, mismatch: false, dps, dccy: dccy || pccy || "" };
}

// 买入检查清单渲染（5 项三态：✅/❌/⬜）
function checklistHTML(h, marginBand) {
  const ck = h.checklist || {};
  const items = [
    { key: "roe15",         label: "近5年ROE≥15%",   val: ck.roe15 },
    { key: "fcfPositive",   label: "自由现金流为正",   val: ck.fcfPositive },
    { key: "mgmtIntegrity", label: "管理层诚信（一票否决）", val: ck.mgmtIntegrity },
    { key: "marginSafety",  label: "估值安全边际（≥30%）", val: ck.marginSafety === "auto" ? (marginBand === "hit") : ck.marginSafety },
    { key: "divOk",         label: "股息率达标",       val: ck.divOk },
  ];
  const sym = v => v === true ? "✅" : v === false ? "❌" : "⬜";
  const cls = v => v === true ? "ok" : v === false ? "no" : "na";
  const rows = items.map(i => `<li><span class="ck-${cls(i.val)}">${sym(i.val)}</span> ${esc(i.label)}</li>`).join("");
  return `<ul class="ck-list">${rows}</ul>`;
}

// 七力评分卡徽章
function powersHTML(h) {
  const ps = h.powers || [];
  if (!ps.length) return '<span class="powers-empty">未配置七力</span>';
  return ps.map(p => {
    const star = "★".repeat(p.score) + "☆".repeat(5 - p.score);
    return `<span class="power-chip" title="${esc(p.note || '')}"><b>${esc(p.name)}</b><i>${star}</i></span>`;
  }).join("");
}

// 6维度评分：返回 0=红/差 1=黄/中 2=绿/好；数据缺失返回 1（中性灰）
function gradeOf(kind, val) {
  if (val == null || (typeof val === "number" && isNaN(val))) return 1;
  if (kind === "margin")  { if (val >= 30) return 2; if (val >= 0) return 1; return 0; }   // 折价 %（越大越好）
  if (kind === "roe")     { if (val >= 15) return 2; if (val >= 10) return 1; return 0; }
  if (kind === "dy")      { if (val >= 5)  return 2; if (val >= 2)  return 1; return 0; }
  if (kind === "power")   { if (val >= 5)  return 2; if (val >= 3)  return 1; return 0; }   // 七力 max 1-5
  if (kind === "check")   { if (val >= 0.8) return 2; if (val >= 0.4) return 1; return 0; }  // 通过率 0-1
  if (kind === "news")    { if (val < 0.05) return 2; if (val <= 0.20) return 1; return 0; }// 利空率5%/20% 分档，越低越好
  return 1;
}

// 掫取一家公司 6 维度的原始数值（不评分）
function metricsOf(h) {
  // 1. 折价
  const tp = parseTargetPrice(h.targetPrice, h.priceCcy);
  const m = tp ? marginOf(h.price, tp.value) : null;
  const margin = m ? m.gap * 100 : null;  // 例 35.1 含义是现价较目标价低 35.1%
  // 2. ROE：取最近年
  const fd = h.financials && h.financials.data;
  const roe = fd && fd.length ? fd[fd.length-1].roe : null;
  // 3. 股息率
  const dyRes = dividendYield(h);
  const dy = (dyRes && !dyRes.mismatch && dyRes.pct != null) ? dyRes.pct : null;
  // 4. 七力：取最强那项的 score
  const ps = h.powers || [];
  const power = ps.length ? Math.max(...ps.map(p => p.score || 0)) : null;
  // 5. 清单通过率：有状态的看是否通过，null 视为不计
  const cl = h.checklist || {};
  const ckFields = ["roe15","strongBS","steadyRev","highMargin","dcfUnder"];
  let ckTotal = 0, ckPass = 0;
  for (const k of ckFields) {
    const v = cl[k];
    if (v === true || v === false) { ckTotal++; if (v) ckPass++; }
  }
  const check = ckTotal ? ckPass / ckTotal : null;
  // 6. 新闻利空率（近7天）
  const now = Date.now();
  const items = (state.all || []).filter(x => x.company === h.name && x.ts >= now - 7*86400000);
  const negN = items.filter(x => x.alert === "neg").length;
  const newsNegRate = items.length ? negN / items.length : null;
  return { margin, roe, dy, power, check, newsNegRate, _itemsLen: items.length };
}

// 信号矩阵：块状卡片版（取代热力图表格）
// 每家公司一张圆角卡，内部 6 个色块格子排成 3×2
function renderHeatmap(hs) {
  if (!hs.length) return "";
  const dims = [
    { key: "margin", label: "折价", val: m => m.margin == null ? "—" : (m.margin >= 0 ? "+"+m.margin.toFixed(1) : m.margin.toFixed(1))+"%" },
    { key: "roe",    label: "ROE",  val: m => m.roe == null ? "—" : m.roe.toFixed(1)+"%" },
    { key: "dy",     label: "股息",  val: m => m.dy == null ? "—" : m.dy.toFixed(2)+"%" },
    { key: "power",  label: "七力",  val: m => m.power == null ? "—" : m.power+"★" },
    { key: "check",  label: "清单",  val: m => m.check == null ? "—" : Math.round(m.check*100)+"%" },
    { key: "news",   label: "利空",  val: m => m._itemsLen === 0 ? "无" : (m.newsNegRate*100).toFixed(0)+"%" }
  ];
  // 维度图标（让色块更有设计感）
  const dimIcons = { margin:"🎯", roe:"📈", dy:"💰", power:"🛡", check:"✅", news:"⚠" };
  let h = '<div class="signal-matrix">';
  for (const ho of hs) {
    const m = metricsOf(ho);
    const sc = sectorColor(ho.sector);
    // 计算全卡总评分（6维度平均 gradeOf）
    const grades = dims.map(d => gradeOf(d.key, d.key==="margin"?m.margin : d.key==="roe"?m.roe : d.key==="dy"?m.dy : d.key==="power"?m.power : d.key==="check"?m.check : d.key==="news"?m.newsNegRate : null));
    const avgG = grades.reduce((a,b)=>a+b,0)/grades.length;
    const cardClass = avgG >= 1.8 ? "good" : avgG >= 1.3 ? "mid" : "weak";
    h += `<div class="sm-card ${cardClass}" data-co="${esc(ho.name)}" onclick="dashJumpTo('${esc(ho.name).replace(/'/g, "\\'")}')" title="点击跳转总览">`;
    h += `<div class="sm-head"><span class="sm-dot" style="background:${sc}"></span><span class="sm-name">${esc(ho.name)}</span><span class="sm-sector" style="color:${sc}">${esc(ho.sector||"")}</span></div>`;
    h += '<div class="sm-grid">';
    dims.forEach((d, i) => {
      const rawVal = d.key==="margin"?m.margin : d.key==="roe"?m.roe : d.key==="dy"?m.dy : d.key==="power"?m.power : d.key==="check"?m.check : d.key==="news"?m.newsNegRate : null;
      const g = gradeOf(d.key, rawVal);
      // 缺数据用 na 样式（灰色虚线边框）
      const na = rawVal == null;
      const cls = na ? "na" : "g"+g;
      h += `<div class="sm-cell ${cls}" data-dim="${d.label}" title="${d.label}: ${esc(d.val(m))}">`;
      h += `<span class="sm-dim">${dimIcons[d.key]} ${d.label}</span>`;
      h += `<span class="sm-val">${d.val(m)}</span>`;
      h += '</div>';
    });
    h += '</div>'; // sm-grid
    h += '</div>'; // sm-card
  }
  // 底部汇总 + legend
  const hitN = hs.filter(h => { const tp=parseTargetPrice(h.targetPrice,h.priceCcy); return tp && marginOf(h.price,tp.value) && marginOf(h.price,tp.value).band === "hit"; }).length;
  const negStocks = hs.filter(h => { const m = metricsOf(h); return m.newsNegRate && m.newsNegRate > 0.05; });
  h += '<div class="sm-summary">';
  h += `<span class="sm-sum-item hit" onclick="gotoView('dash')" title="折价≥30%为击球区">⚾ 击球区 ${hitN} 只</span>`;
  if (negStocks.length) {
    h += '<span class="sm-sum-item warn">⚠ 利空股 ' + negStocks.map(s=>esc(s.name)).join(' · ') + '</span>'; 
  }
  h += '</div>'; // sm-summary
  h += '<div class="sm-legend"><span class="sm-leg g2">好</span><span class="sm-leg g1">中</span><span class="sm-leg g0">差</span><span class="sm-leg na">缺</span></div>';
  h += '</div>'; // signal-matrix
  return h;
}

// 跳转到总览视图并高亮某家公司
function dashJumpTo(name) {
  gotoView("dash", name);
  // 等待 renderDash 后滚动+高亮
  setTimeout(() => {
    const el = document.querySelector(`.dash-card[data-co="${name}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("dc-flash");
      setTimeout(() => el.classList.remove("dc-flash"), 2000);
    }
  }, 50);
}

// 仅闪烁高亮（不跳转，在总览页内部调用）
function flashCard(name) {
  const el = document.querySelector(`.dash-card[data-co="${name}"]`);
  if (!el) return;
  el.classList.remove("dc-flash");
  void el.offsetWidth;  // 强制重流动画重启
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("dc-flash");
  setTimeout(() => el.classList.remove("dc-flash"), 2000);
}

// ============================================================
//  数据加载：读 ./data/news.json
// ============================================================
async function loadNews(){
  // 超 200ms 才显示骨架，避免本地快速加载时闪烁
  const skTimer=setTimeout(()=>{
    const t=document.body;
    if(!t.querySelector(".page-skeleton")){
      const s=document.createElement("div");
      s.className="page-skeleton";
      s.innerHTML='<div class="sk-bar"></div><div class="sk-grid"></div>';
      t.appendChild(s);
    }
  },200);
  try{
    const r=await fetch("./data/news.json",{cache:"no-store"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    const data=await r.json();
    // holdings.json 里含 dividend/checklist/powers，合并进 companies（任务三、四、五）
    try{
      const hr=await fetch("./holdings.json",{cache:"no-store"});
      if(hr.ok){
        const holdings=await hr.json();
        const hm={};
        holdings.forEach(h=>hm[h.name]=h);
        (data.companies||[]).forEach(c=>{
          const h=hm[c.name];
          if(!h) return;
          if(h.dividendPerShare!==undefined){c.dividendPerShare=h.dividendPerShare;c.dividendYear=h.dividendYear;c.dividendCcy=h.dividendCcy;c.dividendSource=h.dividendSource;}
          if(h.checklist) c.checklist=h.checklist;
          if(h.powers) c.powers=h.powers;
        });
      }
    }catch(_){}
    loadData(data);
    state.loadError=false;
  }catch(e){
    state.loadError=true;   // 仅表示本次拉取失败，可能爬虫还没跑过/部署未生效
  }
  clearTimeout(skTimer);
  const sk=document.querySelector(".page-skeleton");
  if(sk)sk.remove();
  // 数据加载完成后重建筛选标签：公司/板块/分类此时才有真实数据
  buildChips();
  renderCurrent();
}

function loadData(data){
  const coMap={};
  (data.companies||[]).forEach(c=>coMap[c.name]=c);
  state.holdings=data.companies||[];
  state.all=(data.all||[]).map(it=>{
    const ts=it.pubDate?new Date(it.pubDate).getTime():Date.now();
    const co=coMap[it.company]||{};
    return {
      id:hashId((it.link||"")+"|"+(it.company||"")),
      title:it.title||"(无标题)",
      link:it.link||"",
      ts:isNaN(ts)?Date.now():ts,
      source:it.source||"未知",
      company:it.company||"",
      code:it.code||co.code||"",
      sector:co.sector||it.sector||"未分类",
      category:it.category||"其他",
      alert:it.alert||null,
      alertWords:it.alertWords||[],
      pubRaw:it.pubRaw||null,
    };
  });
  state.generatedAt=data.generatedAt?new Date(data.generatedAt).getTime():Date.now();
}

// ============================================================
//  过滤 / 可见数据
// ============================================================
function getVisible(){
  let list=state.all.slice();
  if(state.filterCo!=="all")list=list.filter(x=>x.company===state.filterCo);
  if(state.filterBoard!=="all")list=list.filter(x=>x.sector===state.filterBoard);
  if(state.filterCat!=="all")list=list.filter(x=>x.category===state.filterCat);
  if(state.filterTime && state.filterTime!=="all"){
    const days={"1d":1,"3d":3,"7d":7}[state.filterTime]||7;
    const cutoff=Date.now()-days*86400000;
    list=list.filter(x=>x.ts>=cutoff);
  }
  if(state.hideRead)list=list.filter(x=>!state.read.has(x.id));
  if(state.search){
    const q=state.search.toLowerCase();
    list=list.filter(x=>(x.title||"").toLowerCase().includes(q)||(x.company||"").toLowerCase().includes(q));
  }
  list.sort((a,b)=>b.ts-a.ts);
  return list;
}

// ============================================================
//  渲染：时间线（新闻 / 预警 共用）
// ============================================================
function renderTimeline(container,list,opts){
  opts=opts||{};
  if(!list.length){container.innerHTML='<div class="empty">没有匹配的新闻。试试切换筛选或调整搜索词。</div>';return;}
  const groups={};
  list.forEach(it=>{const k=ymd(it.ts);(groups[k]=groups[k]||[]).push(it);});
  const keys=Object.keys(groups).sort((a,b)=>b.localeCompare(a));
  let html="";
  for(const k of keys){
    const firstTs=groups[k][0].ts;
    html+=`<div class="date-head">${esc(dateHead(firstTs))}</div>`;
    for(const it of groups[k])html+=newsRow(it,opts);
  }
  container.innerHTML=html;
  bindRowActions(container);
}

function highlightKeyVars(title, company){
  const h=state.holdings.find(x=>x.name===company);
  if(!h||!h.keyVars||!h.keyVars.length)return esc(title);
  // 按关键词长度倒序，避免短词先匹配把长词切碎
  const words=[...h.keyVars].sort((a,b)=>b.length-a.length);
  const escaped=words.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
  const re=new RegExp("("+escaped.join("|")+")","g");
  return esc(title).replace(re,'<span class="kw">$1</span>');
}

function newsRow(it,opts){
  const favCls=state.fav.has(it.id)?"on":"";
  const readCls=state.read.has(it.id)?"on":"";
  const alertCls=it.alert==="pos"?"alert-pos":it.alert==="neg"?"alert-neg":"";
  const catCls="cat-"+it.category;
  const srcCls="src-"+it.source;
  let tag="";
  if(it.alert==="pos")tag=`<span class="tag-pos">利好·${esc(it.alertWords.join("/"))}</span>`;
  else if(it.alert==="neg")tag=`<span class="tag-neg">利空·${esc(it.alertWords.join("/"))}</span>`;
  return `<div class="news-item ${alertCls} ${readCls?"is-read":""}" data-id="${esc(it.id)}">
    <div>
      <div class="n-title"><a href="${esc(it.link)}" target="_blank" rel="noopener">${highlightKeyVars(it.title, it.company)}</a></div>
      <div class="n-meta">
        <span class="src ${srcCls}">${esc(it.source)}</span>
        <span class="n-co">${esc(it.company)} <span class="code">${esc(it.code)}</span></span>
        <span class="cat ${catCls}">${esc(it.category)}</span>
        ${tag}
        <span class="n-time">${esc(relTime(it.ts))}</span>
      </div>
    </div>
    <div class="n-right">
      <div class="n-actions">
        <button class="act act-fav ${favCls}" data-act="fav" title="收藏">${favCls?"★":"☆"}</button>
        <button class="act act-read ${readCls}" data-act="read" title="标记已读">${readCls?"✓":"○"}</button>
      </div>
      <a class="n-link" href="${esc(it.link)}" target="_blank" rel="noopener">原文↗</a>
    </div>
  </div>`;
}

function bindRowActions(container){
  container.querySelectorAll(".news-item").forEach(row=>{
    const id=row.getAttribute("data-id");
    row.querySelectorAll(".act").forEach(btn=>{
      btn.addEventListener("click",e=>{
        e.preventDefault();e.stopPropagation();
        const act=btn.getAttribute("data-act");
        if(act==="fav"){state.fav.has(id)?state.fav.delete(id):state.fav.add(id);saveSet("pn_fav_gh",state.fav);}
        else{state.read.has(id)?state.read.delete(id):state.read.add(id);saveSet("pn_read_gh",state.read);}
        renderCurrent();
      });
    });
  });
}

// ============================================================
//  渲染：新闻视图（含筛选栏）
// ============================================================
function renderNews(){
  const list=getVisible();
  const updated=state.generatedAt?relTime(state.generatedAt):"—";
  const coCount=new Set(state.all.map(x=>x.company)).size;
  const readN=state.all.filter(x=>state.read.has(x.id)).length;
  const unreadN=state.all.length-readN;
  let stat=`<span>共 <b>${state.all.length}</b> 条</span><span>未读 <b>${unreadN}</b></span><span>显示 <b>${list.length}</b> 条</span><span>覆盖 <b>${coCount}</b> 家</span><span>更新 <b>${updated}</b></span>`;
  document.getElementById("statbar").innerHTML=stat;
  let hint="";
  if(state.loadError)hint=`<div class="cache-hint">⚠ 数据加载失败。可能爬虫尚未首次运行，或 Pages 尚未生效。点"刷新"重试，或确认 Actions 已跑通。</div>`;
  const tl=document.getElementById("timeline");
  tl.innerHTML=hint;
  const wrap=document.createElement("div");tl.appendChild(wrap);
  renderTimeline(wrap,list);
}

// ============================================================
//  渲染：总览 Dashboard
// ============================================================
// 迷你走势线（sparkline）：总览卡里的五年净利小曲线
function miniSpark(vals,color){
  const nums=(vals||[]).filter(v=>v!=null&&!isNaN(v));
  if(nums.length<2)return "";
  const W=92,H=30,P=3;
  let min=Math.min(...nums),max=Math.max(...nums);
  if(min===max){min-=1;max+=1;}
  const pts=[];let idx=0;
  vals.forEach(v=>{if(v==null||isNaN(v))return;
    const x=P+(W-2*P)*idx/(nums.length-1);
    const y=P+(H-2*P)*(1-(v-min)/(max-min));
    pts.push({x,y});idx++;});
  let d="M"+pts[0].x.toFixed(1)+","+pts[0].y.toFixed(1);
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    d+=`C${(p1.x+(p2.x-p0.x)/6).toFixed(1)},${(p1.y+(p2.y-p0.y)/6).toFixed(1)} ${(p2.x-(p3.x-p1.x)/6).toFixed(1)},${(p2.y-(p3.y-p1.y)/6).toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  const gid="ds"+hashId(d).slice(0,6)+Math.floor(Math.random()*1e4);
  const area=d+`L${pts[pts.length-1].x.toFixed(1)},${H-1}L${pts[0].x.toFixed(1)},${H-1}Z`;
  const lastP=pts[pts.length-1];
  return `<svg class="dc-spark" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.28"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs><path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/><circle cx="${lastP.x.toFixed(1)}" cy="${lastP.y.toFixed(1)}" r="2.6" fill="${color}" stroke="#fffdf8" stroke-width="1"/></svg>`;
}
function renderDash(){
  const grid=document.getElementById("dash-grid");
  if(!state.holdings.length){grid.innerHTML='<div class="empty">holdings.json 中没有配置持仓。</div>';return;}
  let html="";
  for(const h of state.holdings){
    const its=state.all.filter(x=>x.company===h.name).sort((a,b)=>b.ts-a.ts);
    const cnt=its.length;
    const latest=its[0];
    const nextEarn=nextEarnings(h);
    const soon=nextEarn&&nextEarn.inDays>=0&&nextEarn.inDays<=45;
    const alerts=its.filter(x=>x.alert);
    const posN=alerts.filter(x=>x.alert==="pos").length;
    const negN=alerts.filter(x=>x.alert==="neg").length;
    // 财务速览（来自 financials 透传）
    const f=h.financials,fd=(f&&f.data)||[];
    const last=fd[fd.length-1],prev=fd.length>1?fd[fd.length-2]:null;
    const npSeries=fd.map(d=>d.netProfit);
    const npYoy=last&&prev?yoyPct(last.netProfit,prev.netProfit):null;
    // 行情 + 安全边际
    const tp=parseTargetPrice(h.targetPrice,h.priceCcy);
    const mg=tp?marginOf(h.price,tp.value):null;
    const hitBand=mg&&mg.band==="hit";
    const premiumBand=mg&&mg.band==="premium";
    const initials=h.name.slice(0,2);
    const sc=sectorColor(h.sector);
    html+=`<div class="dash-card ${hitBand?"hit-zone":""}" data-co="${esc(h.name)}" style="--sc:${sc}">
      <div class="dc-top">
        <div class="dc-avatar" style="background:${sc}1a;color:${sc};border-color:${sc}55">${esc(initials)}</div>
        <div class="dc-id">
          <div class="dc-name" onclick="flashCard('${esc(h.name).replace(/'/g, "\\'")}')" style="cursor:pointer" title="点击高亮">${esc(h.name)}</div>
          <div class="dc-sub"><span class="dc-code">${esc(h.code)}</span><span class="dc-sector" style="color:${sc};background:${sc}14;border-color:${sc}40">${esc(h.sector||"未分类")}</span>${(()=>{const qp=earningsQuietPeriod(h);return qp?`<span class="dc-quiet ${qp.est?"est":""}" title="${qp.est?"估算日期":"权威日期"}">⏸ ${qp.label}</span>`:"";})()}</div>
        </div>
        <div class="dc-sparkbox">${miniSpark(npSeries,"#b8861b")}${fd.length?`<div class="dc-spark-l">净利五年</div>`:""}</div>
      </div>
      ${last?`<div class="dc-kpis">
        <div class="dc-kpi"><div class="k-l">净利 <i>${last.year}</i></div><div class="k-v">${fmtNum(last.netProfit)}<i>${esc((f&&f.unit)||"亿")}</i></div>${yoyBadge(npYoy)}</div>
        <div class="dc-kpi"><div class="k-l">ROE <i>${last.year}</i></div><div class="k-v">${last.roe==null?"—":fmtNum(last.roe)+"%"}</div>${(last.roe!=null&&prev&&prev.roe!=null)?yoyBadge(last.roe-prev.roe,"pp"):""}</div>
        <div class="dc-kpi"><div class="k-l">新闻 / 预警</div><div class="k-v">${cnt}<i>条</i></div>${(posN||negN)?`<span class="dc-kpi-tags">${posN?`<b class="k-pos">📈 ${posN}</b>`:""}${negN?`<b class="k-neg">⚠ ${negN}</b>`:""}</span>`:`<span class="dc-kpi-ok">无预警</span>`}</div>
      </div>`:""}
      ${(h.price!=null||h.targetPrice)?`<div class="dc-price">
        <div class="dp-cell dp-price"><div class="dp-l">现价</div><div class="dp-v ${premiumBand?"premium":""}">${h.price!=null?fmtNum(h.price):"—"}<i>${esc(h.priceCcy||"")}</i></div></div>
        <div class="dp-cell dp-target"><div class="dp-l">目标价</div><div class="dp-v">${tp?fmtNum(tp.value):"—"}<i>${esc(tp?tp.currency:(h.priceCcy||""))}</i></div></div>
        <div class="dp-cell dp-gap"><div class="dp-l">折价 / 溢价</div><div class="dp-v ${hitBand?"hit":(mg&&mg.band==="neutral"?"neutral":"premium")}">${mg?(mg.pct>=0?"▼ ":"▲ ")+fmtNum(Math.abs(mg.pct))+"%":"—"}</div>${hitBand?`<span class="dp-badge hit">击球区</span>`:""}</div>
      </div>`:""}
      ${h.moat?`<div class="dc-moat"><span class="m-i">🛡</span><span class="m-v">${esc(h.moat)}</span></div>`:""}
      ${(h.powers&&h.powers.length)?'<div class="dc-powers">'+powersHTML(h)+'</div>':""}
      ${(()=>{
        const dy=dividendYield(h);
        if(dy==null) return "";
        if(dy.mismatch) return '<div class="dc-dy warn">股息率 — <i>币种不同（'+esc(dy.dccy)+' 股息 vs '+esc(dy.pccy)+' 现价），不计算</i></div>';
        if(dy.pct==null || isNaN(dy.pct)) return '<div class="dc-dy na">股息率 — <i>待核</i></div>';
        const tag=dy.pct>=4?"high":dy.pct>=2?"mid":"low";
        return '<div class="dc-dy '+tag+'">💰 股息率 <b>'+dy.pct.toFixed(2)+'%</b> <i>'+esc(dy.dccy||"")+' · '+esc(h.dividendYear||"")+'</i></div>';
      })()}
      ${h.thesis?`<div class="dc-thesis">${esc(h.thesis)}</div>`:""}
      ${(h.keyVars&&h.keyVars.length)?`<div class="dc-kv">${h.keyVars.slice(0,6).map(k=>`<span class="dc-kv-chip">${esc(k)}</span>`).join("")}</div>`:""}
      ${h.checklist?`<details class="dc-checklist"><summary>✓ 买入检查清单</summary>${checklistHTML(h, mg?mg.band:null)}</details>`:""}
      <div class="dc-latest">${latest?`<span class="dc-latest-l">最新</span><a href="${esc(latest.link)}" target="_blank" rel="noopener" title="${esc(latest.title)}">${esc(latest.title)}</a><span class="dc-latest-t">${esc(relTime(latest.ts))}</span>`:`<span class="dc-latest-l">最新</span><span class="dc-latest-none">暂无新闻</span>`}</div>
      <div class="dc-earn ${soon?"soon":""}">📅 下次财报：${nextEarn?`${nextEarn.confirmed?`<b>${esc(nextEarn.date)}</b>`:`约 ${nextEarn.month} 月`}${nextEarn.inDays>=0?` · <b>${nextEarn.inDays}</b> 天后`:""}${soon?' <span class="e-soon">临近</span>':""}${nextEarn.source?` <span class="e-src">${esc(nextEarn.source)}</span>`:""}`:"未配置"}</div>
    </div>`;
  }
  grid.innerHTML=html;
}

function nextEarnings(h){
  // 优先读取 holdings 中由权威源核实的 nextEarningsDate（经 crawler 透传到 news.json.companies）
  if(h&&h.nextEarningsDate){
    const d=new Date(h.nextEarningsDate+"T00:00:00");
    if(!isNaN(d)){
      const inDays=Math.ceil((d.getTime()-Date.now())/86400000);
      return {month:d.getMonth()+1,date:h.nextEarningsDate,inDays,source:h.nextEarningsSource||"",confirmed:h.nextEarningsEstimated?false:true};
    }
  }
  // 回退：按 earningsMonths「当月1日」粗略估算（仅兜底）
  const months=h&&h.earningsMonths;
  if(!months||!months.length)return null;
  const now=new Date();const y=now.getFullYear();const m=now.getMonth()+1;
  let cand=months.filter(mo=>mo>=m).sort((a,b)=>a-b);
  let target=cand.length?cand[0]:months.slice().sort((a,b)=>a-b)[0];
  const year=cand.length?y:(m>months[months.length-1]?y+1:y);
  const d=new Date(year,target-1,1);
  const inDays=Math.ceil((d.getTime()-now.getTime())/86400000);
  return {month:target,inDays,source:"估算(月份级)",confirmed:false};
}

// ============================================================
//  渲染：预警视图
// ============================================================
function renderAlert(){
  const list=state.all.filter(x=>x.alert).sort((a,b)=>b.ts-a.ts);
  const legend=`<span class="lg lg-pos">利好：${ALERT.pos.slice(0,6).join("/")}…</span><span class="lg lg-neg">利空：${ALERT.neg.slice(0,6).join("/")}…</span>`;
  document.getElementById("alert-legend").innerHTML=legend;
  const box=document.getElementById("alert-list");
  if(!list.length){box.innerHTML='<div class="empty">暂无命中预警词的新闻。新抓取到的会高亮出现在这里。</div>';return;}
  renderTimeline(box,list);
}

// ============================================================
//  渲染：日历视图
// ============================================================
function renderCal(){
  const wrap=document.getElementById("cal-wrap");
  const rows=state.holdings.map(h=>{
    const ne=nextEarnings(h);
    return {h,ne};
  }).sort((a,b)=>(a.ne?a.ne.inDays:-1e9)-(b.ne?b.ne.inDays:-1e9));

  // ====== 顶部：时间轴（12 个月水平条，事件色块） ======
  const yearStart=new Date();yearStart.setMonth(0,1);yearStart.setHours(0,0,0,0);
  const yearEnd=new Date(yearStart);yearEnd.setFullYear(yearStart.getFullYear()+1);
  const yearMs=yearEnd.getTime()-yearStart.getTime();
  const now=Date.now();
  const nowPct=Math.max(0,Math.min(100,(now-yearStart.getTime())/yearMs*100));

  // 按月份计数事件
  const monthCount=new Array(12).fill(0);
  const monthItems={}; // monthIdx → [{h,ne,sc,name,soon}]
  for(const r of rows){
    if(!r.ne||r.ne.inDays<0)continue;
    const d=new Date((r.ne.confirmed&&r.ne.date)?r.ne.date+"T00:00:00":yearStart.getTime());
    d.setMonth((r.ne.month||(d.getMonth()+1))-1,15);
    const mi=d.getMonth();
    if(!monthItems[mi])monthItems[mi]=[];
    monthItems[mi].push({...r,sc:sectorColor(r.h.sector),soon:r.ne.inDays<=45});
    monthCount[mi]++;
  }

  // 事件点（按真实时间定位）—— 仅 confirmed 的事件会画到轴上
  // 先按 left 排序，按相邻间距交替到上下两行避免重叠
  const evts=[];
  for(const r of rows){
    if(!r.ne||!r.ne.confirmed||r.ne.inDays<0)continue;
    const d=new Date(r.ne.date+"T00:00:00");
    const pct=(d.getTime()-yearStart.getTime())/yearMs*100;
    if(pct<0||pct>100)continue;
    evts.push({pct,r,sc:sectorColor(r.h.sector)});
  }
  evts.sort((a,b)=>a.pct-b.pct);
  // 交错：上一行 near=8px（默认），下一行 near=28px
  let lastTop=false;let lastPct=-100;
  let eventsHtml="";
  for(const e of evts){
    let topPx=8;
    if(e.pct-lastPct<2.5){ // 太近 → 错位
      topPx=lastTop?8:28;
    }else{
      topPx=8;
    }
    lastPct=e.pct;lastTop=topPx===28;
    eventsHtml+=`<div class="cal-evt" style="left:${e.pct.toFixed(2)}%;top:${topPx}px;--sc:${e.sc}" data-name="${esc(e.r.h.name)}" data-date="${esc(e.r.ne.date)}" data-in="${e.r.ne.inDays}" data-src="${esc(e.r.ne.source||"权威源")}" data-code="${esc(e.r.h.code)}" title="${esc(e.r.h.name)} · ${esc(e.r.ne.date)}（${e.r.ne.inDays}天后）· ${esc(e.r.ne.source||"权威源")}">
      <span class="cal-evt-dot"></span><span class="cal-evt-lbl">${esc(e.r.h.name)}</span>
    </div>`;
  }

  // 月份格 + 当月计数
  const monthNames=["1","2","3","4","5","6","7","8","9","10","11","12"];
  const monthLabels=monthNames.map((m,i)=>{
    const cnt=monthCount[i];
    return `<div class="cal-m-cell ${i===(new Date()).getMonth()?"now":""}"><span class="cal-m-n">${m}月</span>${cnt?`<span class="cal-m-cnt">${cnt}</span>`:""}</div>`;
  }).join("");

  // 过滤状态
  const filt=state.calFilter||"all";
  const filterBtns=[
    {k:"all",l:"全部",n:rows.length},
    {k:"soon",l:"45天内",n:rows.filter(r=>r.ne&&r.ne.inDays>=0&&r.ne.inDays<=45).length},
    {k:"confirmed",l:"已确认",n:rows.filter(r=>r.ne&&r.ne.confirmed).length},
    {k:"unknown",l:"待核实",n:rows.filter(r=>r.ne&&!r.ne.confirmed).length},
  ].map(b=>`<button class="cal-f-btn ${filt===b.k?"on":""}" data-f="${b.k}">${b.l}<i>${b.n}</i></button>`).join("");

  // 过滤后的卡片列表
  const filtRows=rows.filter(r=>{
    if(filt==="all")return true;
    if(!r.ne)return false;
    if(filt==="soon")return r.ne.inDays>=0&&r.ne.inDays<=45;
    if(filt==="confirmed")return r.ne.confirmed;
    if(filt==="unknown")return !r.ne.confirmed;
    return true;
  });

  let cardsHtml="";
  for(const r of filtRows){
    const {h,ne}=r;
    if(!ne){cardsHtml+=`<div class="cal-card"><div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span></div><div class="cal-note">未配置财报月份</div></div>`;continue;}
    const soon=ne.inDays>=0&&ne.inDays<=45;
    const sc=sectorColor(h.sector);
    cardsHtml+=`<div class="cal-card ${soon?"soon":""} ${ne.confirmed?"confirmed":"unknown"}" style="--sc:${sc}">
      <div class="cal-row">
        ${ne.inDays>=0?earnRing(ne.inDays):""}
        <div class="cal-main">
          <div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span>${soon?`<span class="cal-tag-soon">临近</span>`:""}</div>
          <div class="cal-next">${ne.confirmed?`披露日 <span class="d">${esc(ne.date)}</span>`:`距约 <span class="d">${ne.month}月</span> 披露`}</div>
          <div class="cal-months">${ne.confirmed?`✓ 已确认 · ${esc(ne.source||"权威源")}`:`披露月：${esc((h.earningsMonths||[]).join(" / "))} 月 · ⚠ 待核实`}</div>
        </div>
      </div>
    </div>`;
  }

  let html=`
  <div class="cal-section">
    <div class="cal-title">📅 财报披露日历（2026 年时间轴 + 列表）</div>
    <div class="cal-filters">${filterBtns}</div>
    <div class="cal-timeline">
      <div class="cal-m-row">${monthLabels}</div>
      <div class="cal-axis">
        <div class="cal-today" style="left:${nowPct.toFixed(2)}%" title="今天 ${ymd(now)}"><span>今天</span></div>
        ${eventsHtml}
      </div>
    </div>
    <div class="cal-grid">${cardsHtml}</div>
  </div>`;
  wrap.innerHTML=html;

  // 事件点点击 → 滚动到对应卡片
  wrap.querySelectorAll(".cal-evt").forEach(el=>{
    el.addEventListener("click",()=>{
      const name=el.getAttribute("data-name");
      wrap.querySelectorAll(".cal-card .cal-name").forEach(n=>{
        if(n.textContent.includes(name)){
          n.closest(".cal-card").scrollIntoView({behavior:"smooth",block:"center"});
          n.closest(".cal-card").classList.add("cal-flash");
          setTimeout(()=>n.closest(".cal-card").classList.remove("cal-flash"),1600);
        }
      });
    });
  });
  // 过滤按钮
  wrap.querySelectorAll(".cal-f-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      state.calFilter=btn.getAttribute("data-f");
      renderCal();
    });
  });
}

// ============================================================
//  渲染：统计视图
// ============================================================
// ============================================================
//  渲染：统计视图 → 各持仓近五年财务（收入/净利润/ROE）
// ============================================================
function fmtNum(n){
  if(n==null||isNaN(n))return "—";
  return Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
// 升级版 SVG 折线图：平滑曲线 + 渐变面积 + 数据点标值 + 末年高亮（护眼主题，无外部依赖）
let __finGid=0;
function lineChartSVG(vals,opts){
  opts=opts||{};
  const W=320,H=168,P={l:12,r:16,t:24,b:20};
  const years=opts.years||vals.map((_,i)=>i);
  const nums=vals.filter(v=>v!=null&&!isNaN(v));
  if(!nums.length)return '<div class="fin-no">暂无数据</div>';
  let min=Math.min(...nums),max=Math.max(...nums);
  if(min===max){const dd=Math.abs(min)*0.08||1;min-=dd;max+=dd;}
  const span=max-min;min-=span*0.05;max+=span*0.05;
  const innerW=W-P.l-P.r,innerH=H-P.t-P.b,n=vals.length;
  const X=i=>P.l+(n===1?innerW/2:innerW*i/(n-1));
  const Y=v=>P.t+innerH*(1-(v-min)/(max-min));
  const gid="fg"+(++__finGid);
  const color=opts.color||"#b8861b";
  const sfx=opts.suffix||"";
  // 网格线
  let grid="";
  for(let g=0;g<=3;g++){const gy=P.t+innerH*g/3;
    grid+=`<line x1="${P.l}" y1="${gy.toFixed(1)}" x2="${W-P.r}" y2="${gy.toFixed(1)}" stroke="#e6dfcc" stroke-width="1" ${g<3?'stroke-dasharray="3 4"':''}/>`;}
  // 有效数据点
  const pts=[];vals.forEach((v,i)=>{if(v!=null&&!isNaN(v))pts.push({x:X(i),y:Y(v),v:v});});
  // 平滑曲线（Catmull-Rom → 三次贝塞尔）
  let d="M"+pts[0].x.toFixed(1)+","+pts[0].y.toFixed(1);
  for(let i=0;i<pts.length-1;i++){
    const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
    d+=`C${(p1.x+(p2.x-p0.x)/6).toFixed(1)},${(p1.y+(p2.y-p0.y)/6).toFixed(1)} ${(p2.x-(p3.x-p1.x)/6).toFixed(1)},${(p2.y-(p3.y-p1.y)/6).toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  const base=(P.t+innerH).toFixed(1);
  const area=d+`L${pts[pts.length-1].x.toFixed(1)},${base}L${pts[0].x.toFixed(1)},${base}Z`;
  // 数据点 + 数值标签（统一两位小数）
  let dots="",labels="";
  pts.forEach((p,k)=>{
    const isLast=k===pts.length-1;
    dots+=isLast
      ?`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.2" fill="${color}" stroke="#fffdf8" stroke-width="1.6"/>`
      :`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="#fffdf8" stroke="${color}" stroke-width="1.8"/>`;
    let tx=p.x,anchor="middle";
    if(k===0){tx=Math.max(p.x,P.l+2);anchor="start";}
    else if(isLast){tx=Math.min(p.x,W-2);anchor="end";}
    labels+=`<text x="${tx.toFixed(1)}" y="${(p.y-7).toFixed(1)}" font-size="8.5" fill="${isLast?color:'#8a857a'}" font-weight="${isLast?'700':'400'}" text-anchor="${anchor}">${fmtNum(p.v)}${sfx}</text>`;
  });
  // 年份标签
  let yrs="";
  years.forEach((yr,i)=>{yrs+=`<text x="${X(i).toFixed(1)}" y="${H-6}" font-size="8.5" fill="#a09a8a" text-anchor="middle">${String(yr)}</text>`;});
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.25"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}${yrs}</svg>`;
}
// 同比涨跌徽标（中国惯例：涨红跌绿）
function yoyPct(cur,prev){if(cur==null||prev==null||!prev)return null;return (cur/prev-1)*100;}
function yoyBadge(p,sfx){
  if(p==null||isNaN(p))return "";
  const up=p>=0;
  return `<span class="fs-yoy ${up?"up":"down"}">${up?"▲":"▼"} ${fmtNum(Math.abs(p))}${sfx||"%"}</span>`;
}
function finCard(h){
  const f=h.financials;
  if(!f||!f.data||!f.data.length)return `<div class="fin-card"><div class="fin-h">${esc(h.name)}<span class="fin-code">${esc(h.code)}</span></div><div class="fin-no">暂无财务数据</div></div>`;
  const years=f.data.map(d=>d.year);
  const rev=f.data.map(d=>d.revenue),np=f.data.map(d=>d.netProfit),roe=f.data.map(d=>d.roe);
  const unit=f.unit||"亿元";
  const c1="#b8861b",c2="#2e7d4f",c3="#7d5ba6";
  // 速览条：最新年份 + 同比（涨红跌绿，ROE 用百分点差）
  const last=f.data[f.data.length-1],prev=f.data.length>1?f.data[f.data.length-2]:null;
  const roeDiff=(last&&prev&&last.roe!=null&&prev.roe!=null)?(last.roe-prev.roe):null;
  const summary=`<div class="fin-sum">
      <div class="fs-item"><div class="fs-l">营收<span class="fs-y">${last.year}</span></div><div class="fs-v" style="color:${c1}">${fmtNum(last.revenue)}<span class="fs-u">${esc(unit)}</span></div>${yoyBadge(yoyPct(last.revenue,prev&&prev.revenue))}</div>
      <div class="fs-item"><div class="fs-l">净利<span class="fs-y">${last.year}</span></div><div class="fs-v" style="color:${c2}">${fmtNum(last.netProfit)}<span class="fs-u">${esc(unit)}</span></div>${yoyBadge(yoyPct(last.netProfit,prev&&prev.netProfit))}</div>
      <div class="fs-item"><div class="fs-l">ROE<span class="fs-y">${last.year}</span></div><div class="fs-v" style="color:${c3}">${last.roe==null?"—":fmtNum(last.roe)+"%"}</div>${yoyBadge(roeDiff,"pp")}</div>
    </div>`;
  const rows=f.data.map(d=>`<tr>
      <td>${d.year}</td>
      <td class="num">${fmtNum(d.revenue)}</td>
      <td class="num">${fmtNum(d.netProfit)}</td>
      <td class="num roe ${d.roe==null?"":(d.roe>=15?"pass":"fail")}">${d.roe==null?'<span class="ty">需核实</span>':fmtNum(d.roe)+'%'}${d.adj?'<span class="adj" title="口径调整（审慎调减）">⚠</span>':''}</td>
    </tr>`).join("");
  return `<div class="fin-card">
    <div class="fin-h">${esc(h.name)}<span class="fin-code">${esc(h.code)}</span><span class="fin-unit">${esc(unit)}${f.currency?' · '+esc(f.currency):''}</span></div>
    ${summary}
    <div class="fin-charts">
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c1}"></span>营业收入</div>${lineChartSVG(rev,{years,color:c1})}</div>
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c2}"></span>归母净利润</div>${lineChartSVG(np,{years,color:c2})}</div>
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c3}"></span>ROE（净资产收益率）</div>${lineChartSVG(roe,{years,color:c3,suffix:"%"})}</div>
    </div>
    <table class="fin-tbl"><thead><tr><th>年份</th><th>营收</th><th>净利</th><th>ROE <span class="roe-line" title="ROE 生死线 15%：达标绿 / 不达标红">↕15%</span></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="fin-note">${esc(f.note||"")}${f.asOf?' · 截至 '+esc(f.asOf):''} · 来源：${esc(f.source||"需核实")}</div>
  </div>`;
}
function renderStat(){
  const wrap=document.getElementById("stat-wrap");
  if(!state.holdings.length){wrap.innerHTML='<div class="empty">暂无持仓数据，请先确认爬虫已运行并刷新。</div>';return;}
  const cards=state.holdings.map(h=>finCard(h)).join("");
  wrap.innerHTML=`<div class="fin-head">💰 各持仓近五年财务（营业收入 / 归母净利润 / ROE）</div>${cards}<div class="fin-foot">数据取自公开年报与财经媒体（检索于 2026-07），标注「需核实」者请以交易所公告为准；后续将由定时任务自动刷新。数值统一保留两位小数；同比涨跌按中国惯例涨红跌绿，ROE 同比为百分点差（pp）。</div>`;
}

// ============================================================
//  视图切换 & 筛选栏
// ============================================================
function renderCurrent(){
  if(state.view==="home")renderHome();
  else if(state.view==="news")renderNews();
  else if(state.view==="dash")renderDash();
  else if(state.view==="alert")renderAlert();
  else if(state.view==="cal")renderCal();
  else if(state.view==="stat")renderStat();
}

// 程序化切换视图（供首页卡片点击跳转用）
function gotoView(v,coName){
  if(coName!==undefined){state.filterCo=coName;buildChips();}
  state.view=v;
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.getAttribute("data-view")===v));
  document.querySelectorAll(".view").forEach(s=>s.classList.remove("active"));
  const sec=document.getElementById("view-"+v);
  if(sec)sec.classList.add("active");
  renderCurrent();
  window.scrollTo({top:0,behavior:"instant"});
}

// ============================================================
//  板块固定色系统：每个板块一个专属色，贯穿首页/总览/新闻
// ============================================================
const SECTOR_COLORS={"白酒":"#b8861b","互联网":"#3a7ca5","电商":"#c0392b","潮玩":"#7d5ba6","航运":"#2e7d4f","金融":"#c77f1a","能源":"#8a6d3b"};
function sectorColor(s){return SECTOR_COLORS[s]||"#9a7b2e";}

// 财报倒计时进度环（92天≈一个财报季，剩得越少环越满）
function earnRing(d){
  const total=92,pct=Math.max(0.04,Math.min(1,1-d/total));
  const R=19,C=2*Math.PI*R;
  const cls=d<=15?"hot":d<=30?"mid":"ok";
  return `<svg class="hm-ring ${cls}" viewBox="0 0 46 46"><circle class="rbg" cx="23" cy="23" r="${R}"/><circle class="rfg" cx="23" cy="23" r="${R}" stroke-dasharray="${(C*pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 23 23)"/><text x="23" y="27.5">${d}</text></svg>`;
}

// ============================================================
//  渲染：首页仪表盘（驾驶舱：聚合 + 引流，不重复各视图细节）
// ============================================================
function renderHome(){
  const wrap=document.getElementById("home-wrap");
  if(!wrap)return;
  const hs=state.holdings||[];
  const now=Date.now();

  // ---- 汇总数据 ----
  const hitN=hs.filter(h=>{const tp=parseTargetPrice(h.targetPrice,h.priceCcy);return tp?marginOf(h.price,tp.value)&&marginOf(h.price,tp.value).band==="hit":false;}).length;
  const alerts7d=state.all.filter(x=>x.alert&&x.ts>=now-7*86400000);
  const negStocks=hs.filter(h=>{const m=metricsOf(h);return m.newsNegRate&&m.newsNegRate>0.05;});
  const earnRows=hs.map(h=>({h,ne:nextEarnings(h)})).filter(r=>r.ne&&r.ne.inDays>=0).sort((a,b)=>a.ne.inDays-b.ne.inDays);
  const nearest=earnRows[0]||null;
  const upd=state.generatedAt?relTime(state.generatedAt):"—";
  const wk=["日","一","二","三","四","五","六"][new Date().getDay()];
  const dateStr=new Date().getFullYear()+"年"+(new Date().getMonth()+1)+"月"+new Date().getDate()+"日 周"+wk;

  // ==== 层① Hero：异常驱动摘要 ====
  const signals=[];
  if(hitN) signals.push('<span class="hero-sig hit">⚾ 击球区 '+hitN+' 只</span>');
  if(negStocks.length) signals.push('<span class="hero-sig warn">⚠ '+negStocks.map(s=>esc(s.name)).join(' · ')+' 利空</span>');
  if(nearest && nearest.ne.inDays <= 45) signals.push('<span class="hero-sig cal">📅 '+esc(nearest.h.name)+' '+nearest.ne.inDays+'天后财报</span>');
  const signalHtml = signals.length ? signals.join(' ') : '<span class="hero-sig ok">🟢 今日无异常信号</span>';

  let html='<div class="hm-hero">'
    +'<div class="hero-left"><div class="hero-date">'+dateStr+'</div><div class="hero-sigs">'+signalHtml+'</div></div>'
    +'<div class="hero-right"><span class="dot"></span>'+esc(upd)+' 更新</div>'
    +'</div>';

  // ==== 层② 信号矩阵（块状卡片） ====
  html+='<div class="hm-sec"><div class="hm-title">🧭 信号矩阵 <span class="hm-sub">点击卡片跳转总览 · 色块趋绿越优 · 顶条=综合评分</span></div>'+renderHeatmap(hs)+'</div>';

  // ==== 层③ 信号流（只展示异常） ====
  html+='<div class="hm-sec hm-signal-flow">';

  // -- 预警块 --
  html+=`<div class="sf-block"><div class="sf-title">🔔 预警信号 <span class="hm-link" onclick="gotoView('alert')">全部 ›</span></div>`;
  if(alerts7d.length){
    const byCo={};
    alerts7d.forEach(a=>{const co=a.company;if(!byCo[co])byCo[co]=[];byCo[co].push(a);});
    for(const [co,items] of Object.entries(byCo).slice(0,4)){
      const negN=items.filter(x=>x.alert==='neg').length;
      const posN=items.filter(x=>x.alert==='pos').length;
      const tag=negN?'sf-co-neg':'sf-co-pos';
      html+=`<div class="sf-co ${tag}" onclick="gotoView('alert')"><span class="sf-co-dot ${tag}"></span><b>${esc(co)}</b> <span class="sf-co-nums">${posN?'📈'+posN:''}${negN?' ⚠'+negN:''}</span></div>`;
    }
  } else {
    html+='<div class="sf-empty">🟢 近7日无预警</div>';
  }
  html+='</div>';

  // -- 财报块 --
  if(earnRows.length){
    html+=`<div class="sf-block"><div class="sf-title">📅 财报倒计时 <span class="hm-link" onclick="gotoView('cal')">全部 ›</span></div>`;
    for(const r of earnRows.slice(0,3)){
      const d=r.ne.inDays;
      const cls=d<=15?'sf-earn-hot':d<=30?'sf-earn-mid':'sf-earn-ok';
      html+=`<div class="sf-earn ${cls}" onclick="gotoView('cal')">${earnRing(d)}<div class="sf-earn-body"><b>${esc(r.h.name)}</b><span>${esc(r.ne.confirmed?r.ne.date:'约'+r.ne.month+'月')}</span></div><span class="sf-earn-d">${d}天</span></div>`;
    }
    html+='</div>';
  }

  // -- 最新要闻（去重：同一标题多源只留一个） --
  html+=`<div class="sf-block"><div class="sf-title">📰 最新要闻 <span class="hm-link" onclick="gotoView('news','all')">全部 ›</span></div>`;
  const latestRaw=state.all.slice().sort((a,b)=>b.ts-a.ts);
  const seenTitle=new Set();
  const latest=[];
  for(const it of latestRaw){
    const k=it.title.replace(/\s+/g,' ').trim().slice(0,40);
    if(seenTitle.has(k))continue;
    seenTitle.add(k);
    latest.push(it);
    if(latest.length>=6)break;
  }
  if(!latest.length){html+=`<div class="sf-empty">暂无新闻，等爬虫跑完</div>`;}
  else{
    for(const it of latest){
      const neg=it.alert==='neg',pos=it.alert==='pos';
      const cls=neg?'sf-news-neg':pos?'sf-news-pos':'';
      const sc=sectorColor((hs.find(h=>h.name===it.company)||{}).sector);
      html+='<a class="sf-news '+cls+'" href="'+esc(it.link)+'" target="_blank" rel="noopener"><span class="sf-news-co" style="background:'+sc+'14">'+esc(it.company)+'</span><span class="sf-news-t">'+esc(it.title)+'</span><span class="sf-news-time">'+esc(relTime(it.ts))+'</span></a>';
    }
  }
  html+='</div>';

  html+='</div>'; // hm-signal-flow
  wrap.innerHTML=html;
}
function buildChips(){
  const coBox=document.getElementById("company-chips");
  let co=`<span class="chip-label">公司</span><span class="chip ${state.filterCo==="all"?"active":""}" data-co="all">全部</span>`;
  state.holdings.forEach(h=>{co+=`<span class="chip ${state.filterCo===h.name?"active":""}" data-co="${esc(h.name)}">${esc(h.name)}</span>`;});
  coBox.innerHTML=co;
  coBox.querySelectorAll(".chip").forEach(c=>c.addEventListener("click",()=>{state.filterCo=c.getAttribute("data-co");buildChips();renderNews();}));

  const boards=[...new Set(state.holdings.map(h=>h.sector||"未分类"))];
  let bd=`<span class="chip-label">板块</span><span class="chip ${state.filterBoard==="all"?"active":""}" data-board="all">全部</span>`;
  boards.forEach(b=>{bd+=`<span class="chip ${state.filterBoard===b?"active":""}" data-board="${esc(b)}">${esc(b)}</span>`;});
  const bdBox=document.getElementById("board-chips");bdBox.innerHTML=bd;
  bdBox.querySelectorAll(".chip").forEach(c=>c.addEventListener("click",()=>{state.filterBoard=c.getAttribute("data-board");buildChips();renderNews();}));

  const cats=[...new Set(state.all.map(x=>x.category))];
  let ct=`<span class="chip-label">分类</span><span class="chip ${state.filterCat==="all"?"active":""}" data-cat="all">全部</span>`;
  cats.forEach(c=>{ct+=`<span class="chip ${state.filterCat===c?"active":""}" data-cat="${esc(c)}">${esc(c)}</span>`;});
  const ctBox=document.getElementById("category-chips");ctBox.innerHTML=ct;
  ctBox.querySelectorAll(".chip").forEach(c=>c.addEventListener("click",()=>{state.filterCat=c.getAttribute("data-cat");buildChips();renderNews();}));
}

// ============================================================
//  倒计时（距下次预计云端更新）& 初始化
// ============================================================
function tickCountdown(){
  const el=document.getElementById("countdown");
  if(!el)return;
  if(!state.generatedAt){el.textContent="--";return;}
  const next=state.generatedAt+CONFIG.refreshMinutes*60000;
  const left=Math.max(0,next-Date.now());
  const m=Math.floor(left/60000),s=Math.floor(left%60000/1000);
  el.textContent=pad(m)+":"+pad(s);
}

async function init(){
  if(!document.getElementById("timeline"))return;
  document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    const v=t.getAttribute("data-view");state.view=v;
    document.querySelectorAll(".view").forEach(s=>s.classList.remove("active"));
    document.getElementById("view-"+v).classList.add("active");
    renderCurrent();
  }));
  // 主题切换：跟随按钮切换 dark/light，记住偏好
  const themeBtn=document.getElementById("themeBtn");
  function syncThemeBtn(){
    const t=document.documentElement.getAttribute("data-theme");
    if(themeBtn)themeBtn.textContent=t==="dark"?"☀️ 浅色":"🌙 深色";
    const meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.setAttribute("content",t==="dark"?"#12141a":"#f5f0e6");
  }
  if(themeBtn){
    themeBtn.addEventListener("click",()=>{
      const cur=document.documentElement.getAttribute("data-theme");
      const next=cur==="dark"?"light":"dark";
      document.documentElement.setAttribute("data-theme",next);
      try{localStorage.setItem("pf-theme",next);}catch(e){}
      syncThemeBtn();
    });
    syncThemeBtn();
  }
  document.getElementById("q-input").addEventListener("input",e=>{state.search=e.target.value.trim();renderNews();});
  document.getElementById("refreshBtn").addEventListener("click",()=>{
    state.loadError=false;
    loadNews();   // ① 本地立即重新拉取已生成的 news.json（若云端已跑过，秒看到新数据）
    // ② 联动：打开 GitHub Actions 的 Run workflow 页，点一下即可触发云端爬虫抓最新新闻
    window.open("https://github.com/huanghua-2019/portfolio-news/actions/workflows/crawl.yml","_blank","noopener");
  });
  document.querySelectorAll("#time-chips .chip").forEach(c=>c.addEventListener("click",()=>{
    state.filterTime=c.getAttribute("data-time");
    document.querySelectorAll("#time-chips .chip").forEach(x=>x.classList.remove("active"));
    c.classList.add("active");
    renderNews();
  }));
  document.getElementById("hideRead").addEventListener("change",e=>{state.hideRead=e.target.checked;renderNews();});
  buildChips();
  await loadNews();
  setInterval(tickCountdown,1000);
}

document.addEventListener("DOMContentLoaded",init);
