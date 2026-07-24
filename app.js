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
  return `<div class="news-item ${alertCls}" data-id="${esc(it.id)}">
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
      ${(h.targetPrice||h.moat||h.thesis)?`<div class="dc-fundamentals">
        ${h.targetPrice?`<div class="dc-row"><span class="dc-lbl">🎯 目标价</span><span class="dc-val">${esc(h.targetPrice)}</span></div>`:""}
        ${h.moat?`<div class="dc-row"><span class="dc-lbl">🛡 护城河</span><span class="dc-val">${esc(h.moat)}</span></div>`:""}
        ${h.thesis?`<div class="dc-row dc-thesis-row"><span class="dc-lbl">💡 投资逻辑</span><span class="dc-val">${esc(h.thesis)}</span></div>`:""}
      </div>`:""}
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
// ============================================================
//  渲染：统计视图 → 各持仓近五年财务（收入/净利润/ROE）
// ============================================================
function fmtNum(n){
  if(n==null||isNaN(n))return "—";
  const r=Math.round(n*100)/100;
  return r.toLocaleString("en-US");
}
// 轻量 SVG 折线图（护眼米色金棕主题，无外部依赖）
function lineChartSVG(vals,opts){
  opts=opts||{};
  const W=300,H=132,P={l:10,r:10,t:10,b:22};
  const years=opts.years||vals.map((_,i)=>i);
  const nums=vals.filter(v=>v!=null);
  if(!nums.length)return '<div class="fin-no">暂无数据</div>';
  let min=Math.min(...nums),max=Math.max(...nums);
  if(min===max){min=min*0.92;max=max*1.08;}
  const innerW=W-P.l-P.r,innerH=H-P.t-P.b,n=vals.length;
  const X=i=>P.l+(n===1?innerW/2:innerW*i/(n-1));
  const Y=v=>P.t+innerH*(1-(v-min)/(max-min));
  let grid="";
  for(let g=0;g<=2;g++){const gy=P.t+innerH*g/2;grid+=`<line x1="${P.l}" y1="${gy.toFixed(1)}" x2="${W-P.r}" y2="${gy.toFixed(1)}" stroke="#d9d2bf" stroke-width="1" stroke-dasharray="2 3"/>`;}
  let pts="",dots="",lastLabel="";
  vals.forEach((v,i)=>{ if(v==null)return; const cx=X(i),cy=Y(v);pts+=(pts?" ":"")+cx.toFixed(1)+","+cy.toFixed(1);dots+=`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.6" fill="${opts.color}"/>`;});
  let labels="";
  years.forEach((yr,i)=>{labels+=`<text x="${X(i).toFixed(1)}" y="${H-7}" font-size="8" fill="#8a857a" text-anchor="middle">${String(yr).slice(2)}</text>`;});
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${grid}<polyline points="${pts}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linejoin="round"/>${dots}${labels}</svg>`;
}
function finCard(h){
  const f=h.financials;
  if(!f||!f.data||!f.data.length)return `<div class="fin-card"><div class="fin-h">${esc(h.name)}<span class="fin-code">${esc(h.code)}</span></div><div class="fin-no">暂无财务数据</div></div>`;
  const years=f.data.map(d=>d.year);
  const rev=f.data.map(d=>d.revenue),np=f.data.map(d=>d.netProfit),roe=f.data.map(d=>d.roe);
  const unit=f.unit||"亿元";
  const c1="#b8861b",c2="#2e7d4f",c3="#7d5ba6";
  const rows=f.data.map(d=>`<tr>
      <td>${d.year}</td>
      <td class="num">${fmtNum(d.revenue)}</td>
      <td class="num">${fmtNum(d.netProfit)}</td>
      <td class="num">${d.roe==null?'<span class="ty">需核实</span>':fmtNum(d.roe)+'%'}${d.adj?'<span class="adj" title="口径调整（审慎调减）">⚠</span>':''}</td>
    </tr>`).join("");
  return `<div class="fin-card">
    <div class="fin-h">${esc(h.name)}<span class="fin-code">${esc(h.code)}</span><span class="fin-unit">${esc(unit)}${f.currency?' · '+esc(f.currency):''}</span></div>
    <div class="fin-charts">
      <div class="fin-ch"><div class="fin-ch-t">📈 营业收入</div>${lineChartSVG(rev,{years,color:c1})}</div>
      <div class="fin-ch"><div class="fin-ch-t">💰 归母净利润</div>${lineChartSVG(np,{years,color:c2})}</div>
      <div class="fin-ch"><div class="fin-ch-t">📊 ROE（净资产收益率）</div>${lineChartSVG(roe,{years,color:c3})}</div>
    </div>
    <table class="fin-tbl"><thead><tr><th>年份</th><th>营收</th><th>净利</th><th>ROE</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="fin-note">${esc(f.note||"")}${f.asOf?' · 截至 '+esc(f.asOf):''} · 来源：${esc(f.source||"需核实")}</div>
  </div>`;
}
function renderStat(){
  const wrap=document.getElementById("stat-wrap");
  if(!state.holdings.length){wrap.innerHTML='<div class="empty">暂无持仓数据，请先确认爬虫已运行并刷新。</div>';return;}
  const cards=state.holdings.map(h=>finCard(h)).join("");
  wrap.innerHTML=`<div class="fin-head">📊 各持仓近五年财务（营业收入 / 归母净利润 / ROE）</div>${cards}<div class="fin-foot">数据取自公开年报与财经媒体（检索于 2026-07），标注「需核实」者请以交易所公告为准；后续将由定时任务自动刷新。</div>`;
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
