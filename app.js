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
  search: "",
  view: "news",
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

// ============================================================
//  数据加载：读 ./data/news.json
// ============================================================
async function loadNews(){
  try{
    const r=await fetch("./data/news.json",{cache:"no-store"});
    if(!r.ok)throw new Error("HTTP "+r.status);
    const data=await r.json();
    loadData(data);
    state.loadError=false;
  }catch(e){
    state.loadError=true;   // 仅表示本次拉取失败，可能爬虫还没跑过/部署未生效
  }
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

function newsRow(it,opts){
  const favCls=state.fav.has(it.id)?"on":"";
  const readCls=state.read.has(it.id)?"on":"";
  const alertCls=it.alert==="pos"?"alert-pos":it.alert==="neg"?"alert-neg":"";
  const catCls="cat-"+it.category;
  const srcCls="src-"+it.source;
  let tag="";
  if(it.alert==="pos")tag=`<span class="tag-pos">利好·${esc(it.alertWords.join("/"))}</span>`;
  else if(it.alert==="neg")tag=`<span class="tag-neg">利空·${esc(it.alertWords.join("/"))}</span>`;
  return `<div class="news-item ${alertCls}" data-id="${esc(it.id)}">
    <div>
      <div class="n-title"><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a></div>
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
  let stat=`<span>共 <b>${state.all.length}</b> 条</span><span>显示 <b>${list.length}</b> 条</span><span>覆盖 <b>${coCount}</b> 家</span><span>更新 <b>${updated}</b></span>`;
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
function renderDash(){
  const grid=document.getElementById("dash-grid");
  if(!state.holdings.length){grid.innerHTML='<div class="empty">holdings.json 中没有配置持仓。</div>';return;}
  let html="";
  for(const h of state.holdings){
    const its=state.all.filter(x=>x.company===h.name).sort((a,b)=>b.ts-a.ts);
    const cnt=its.length;
    const latest=its[0];
    const nextEarn=nextEarnings(h.earningsMonths);
    html+=`<div class="dash-card">
      <div class="dc-head">
        <div><div class="dc-name">${esc(h.name)}<span class="dc-code">${esc(h.code)}</span></div>
        <span class="dc-sector">${esc(h.sector||"未分类")}</span></div>
      </div>
      <div class="dc-note">${esc(h.note||"")}</div>
      <div class="dc-stats">
        <div><div class="s-num">${cnt}</div><div class="s-lbl">相关新闻</div></div>
        <div><div class="s-num">${latest?relTime(latest.ts):"—"}</div><div class="s-lbl">最近更新</div></div>
      </div>
      <div class="dc-latest">${latest?`<a href="${esc(latest.link)}" target="_blank" rel="noopener">${esc(latest.title)}</a>`:"暂无新闻"}</div>
      <div class="dc-earn">${nextEarn?`📅 下次财报：约 ${nextEarn.month} 月（${nextEarn.inDays>=0?nextEarn.inDays+" 天后":"待核实"}${h.earningsMonths?" · 披露月："+h.earningsMonths.join("/")+"月":""}）`:"📅 未配置财报月"}</div>
    </div>`;
  }
  grid.innerHTML=html;
}

function nextEarnings(months){
  if(!months||!months.length)return null;
  const now=new Date();const y=now.getFullYear();const m=now.getMonth()+1;
  let cand=months.filter(mo=>mo>=m).sort((a,b)=>a-b);
  let target=cand.length?cand[0]:months.slice().sort((a,b)=>a-b)[0];
  const year=cand.length?y:(m>months[months.length-1]?y+1:y);
  const d=new Date(year,target-1,1);
  const inDays=Math.ceil((d.getTime()-now.getTime())/86400000);
  return {month:target,inDays};
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
    const ne=nextEarnings(h.earningsMonths);
    return {h,ne};
  }).sort((a,b)=>(a.ne?a.ne.inDays:-1e9)-(b.ne?b.ne.inDays:-1e9));
  let html=`<div class="cal-section"><div class="cal-title">📅 财报披露日历（月份需自行核实！）</div><div class="cal-grid">`;
  for(const r of rows){
    const {h,ne}=r;
    if(!ne){html+=`<div class="cal-card"><div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span></div><div class="cal-note">未配置财报月份</div></div>`;continue;}
    const soon=ne.inDays>=0&&ne.inDays<=45;
    html+=`<div class="cal-card ${soon?"soon":""}">
      <div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span></div>
      <div class="cal-next">距约 <span class="d">${ne.month}月</span> 披露：<span class="d">${ne.inDays>=0?ne.inDays+" 天":"待核实"}</span></div>
      <div class="cal-months">披露月：${esc((h.earningsMonths||[]).join(" / "))} 月</div>
      <div class="cal-note">⚠ 具体日期需核实，这里按"约当月1日"粗略倒计时</div>
    </div>`;
  }
  html+=`</div></div>`;
  wrap.innerHTML=html;
}

// ============================================================
//  渲染：统计视图
// ============================================================
function renderStat(){
  const wrap=document.getElementById("stat-wrap");
  if(!state.all.length){wrap.innerHTML='<div class="empty">暂无数据，请先确认爬虫已运行并刷新。</div>';return;}
  const byCo={};state.all.forEach(x=>byCo[x.company]=(byCo[x.company]||0)+1);
  const bySrc={};state.all.forEach(x=>bySrc[x.source]=(bySrc[x.source]||0)+1);
  const byDay={};const now=new Date();
  for(let i=6;i>=0;i--){const d=new Date(now);d.setDate(d.getDate()-i);byDay[ymd(d.getTime())]=0;}
  state.all.forEach(x=>{const k=ymd(x.ts);if(k in byDay)byDay[k]++;});
  const byCat={};state.all.forEach(x=>byCat[x.category]=(byCat[x.category]||0)+1);
  const posN=state.all.filter(x=>x.alert==="pos").length;
  const negN=state.all.filter(x=>x.alert==="neg").length;

  const maxCo=Math.max(1,...Object.values(byCo));
  const maxSrc=Math.max(1,...Object.values(bySrc));
  const maxDay=Math.max(1,...Object.values(byDay));

  let html="";
  html+=`<div class="stat-grid2">
    <div class="stat-block"><div class="stat-title">📊 各持仓新闻量</div>${barRows(byCo,maxCo,"")}</div>
    <div class="stat-block"><div class="stat-title">🌐 来源分布</div>${barRows(bySrc,maxSrc,"src")}</div>
  </div>`;
  html+=`<div class="stat-grid2">
    <div class="stat-block"><div class="stat-title">📅 近 7 天（按日期）</div>${barRows(byDay,maxDay,"day")}</div>
    <div class="stat-block"><div class="stat-title">🏷 分类 / 预警</div>
      ${barRows(byCat,Math.max(1,...Object.values(byCat)),"")}
      <div class="bar-row"><span class="bl">利好命中</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(posN/Math.max(1,state.all.length)*100)}%"></div></div><span class="bar-num">${posN}</span></div>
      <div class="bar-row"><span class="bl">利空命中</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(negN/Math.max(1,state.all.length)*100)}%;background:linear-gradient(90deg,#ff8a8a,var(--neg))"></div></div><span class="bar-num">${negN}</span></div>
    </div>
  </div>`;
  wrap.innerHTML=html;
}

function barRows(obj,max,extra){
  return Object.keys(obj).sort((a,b)=>obj[b]-obj[a]).map(k=>{
    const v=obj[k];const pct=Math.round(v/max*100);
    return `<div class="bar-row"><span class="bl" title="${esc(k)}">${esc(k)}</span><div class="bar-track"><div class="bar-fill ${extra}" style="width:${pct}%"></div></div><span class="bar-num">${v}</span></div>`;
  }).join("");
}

// ============================================================
//  视图切换 & 筛选栏
// ============================================================
function renderCurrent(){
  if(state.view==="news")renderNews();
  else if(state.view==="dash")renderDash();
  else if(state.view==="alert")renderAlert();
  else if(state.view==="cal")renderCal();
  else if(state.view==="stat")renderStat();
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
  document.getElementById("q-input").addEventListener("input",e=>{state.search=e.target.value.trim();renderNews();});
  document.getElementById("refreshBtn").addEventListener("click",()=>{state.loadError=false;loadNews();});
  buildChips();
  await loadNews();
  setInterval(tickCountdown,1000);
}

document.addEventListener("DOMContentLoaded",init);
