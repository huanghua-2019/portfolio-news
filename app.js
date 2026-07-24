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
    const negN=alerts.filter(x=>x.alert==="neg").length;
    // 财务速览（来自 financials 透传）
    const f=h.financials,fd=(f&&f.data)||[];
    const last=fd[fd.length-1],prev=fd.length>1?fd[fd.length-2]:null;
    const npSeries=fd.map(d=>d.netProfit);
    const npYoy=last&&prev?yoyPct(last.netProfit,prev.netProfit):null;
    const initials=h.name.slice(0,2);
    html+=`<div class="dash-card">
      <div class="dc-top">
        <div class="dc-avatar">${esc(initials)}</div>
        <div class="dc-id">
          <div class="dc-name">${esc(h.name)}</div>
          <div class="dc-sub"><span class="dc-code">${esc(h.code)}</span><span class="dc-sector">${esc(h.sector||"未分类")}</span></div>
        </div>
        <div class="dc-sparkbox">${miniSpark(npSeries,"#b8861b")}${fd.length?`<div class="dc-spark-l">净利五年</div>`:""}</div>
      </div>
      ${last?`<div class="dc-kpis">
        <div class="dc-kpi"><div class="k-l">净利 <i>${last.year}</i></div><div class="k-v">${fmtNum(last.netProfit)}<i>${esc((f&&f.unit)||"亿")}</i></div>${yoyBadge(npYoy)}</div>
        <div class="dc-kpi"><div class="k-l">ROE <i>${last.year}</i></div><div class="k-v">${last.roe==null?"—":fmtNum(last.roe)+"%"}</div>${(last.roe!=null&&prev&&prev.roe!=null)?yoyBadge(last.roe-prev.roe,"pp"):""}</div>
        <div class="dc-kpi"><div class="k-l">新闻 / 预警</div><div class="k-v">${cnt}<i>条</i></div>${negN?`<span class="fs-yoy down">⚠ 利空 ${negN}</span>`:`<span class="dc-kpi-ok">无利空</span>`}</div>
      </div>`:""}
      ${h.targetPrice?`<div class="dc-target"><span class="t-i">🎯</span><span class="t-l">目标价</span><span class="t-v">${esc(h.targetPrice)}</span></div>`:""}
      ${h.moat?`<div class="dc-moat"><span class="m-i">🛡</span><span class="m-v">${esc(h.moat)}</span></div>`:""}
      ${h.thesis?`<div class="dc-thesis">${esc(h.thesis)}</div>`:""}
      ${(h.keyVars&&h.keyVars.length)?`<div class="dc-kv">${h.keyVars.slice(0,6).map(k=>`<span class="dc-kv-chip">${esc(k)}</span>`).join("")}</div>`:""}
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
  let html=`<div class="cal-section"><div class="cal-title">📅 财报披露日历（已按权威源核实）</div><div class="cal-grid">`;
  for(const r of rows){
    const {h,ne}=r;
    if(!ne){html+=`<div class="cal-card"><div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span></div><div class="cal-note">未配置财报月份</div></div>`;continue;}
    const soon=ne.inDays>=0&&ne.inDays<=45;
    html+=`<div class="cal-card ${soon?"soon":""}">
      <div class="cal-name">${esc(h.name)}<span class="cal-code">${esc(h.code)}</span></div>
      <div class="cal-next">${ne.confirmed?`披露日 <span class="d">${esc(ne.date)}</span>`:`距约 <span class="d">${ne.month}月</span> 披露`}：<span class="d">${ne.inDays>=0?ne.inDays+" 天":"待核实"}</span></div>
      <div class="cal-months">${ne.confirmed?`✓ 已确认 · ${esc(ne.source||"权威源")}`:`披露月：${esc((h.earningsMonths||[]).join(" / "))} 月`}</div>
      <div class="cal-note">${ne.confirmed?"":"⚠ 具体日期需核实，这里按\"约当月1日\"粗略倒计时"}</div>
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
      <td class="num">${d.roe==null?'<span class="ty">需核实</span>':fmtNum(d.roe)+'%'}${d.adj?'<span class="adj" title="口径调整（审慎调减）">⚠</span>':''}</td>
    </tr>`).join("");
  return `<div class="fin-card">
    <div class="fin-h">${esc(h.name)}<span class="fin-code">${esc(h.code)}</span><span class="fin-unit">${esc(unit)}${f.currency?' · '+esc(f.currency):''}</span></div>
    ${summary}
    <div class="fin-charts">
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c1}"></span>营业收入</div>${lineChartSVG(rev,{years,color:c1})}</div>
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c2}"></span>归母净利润</div>${lineChartSVG(np,{years,color:c2})}</div>
      <div class="fin-ch"><div class="fin-ch-t"><span class="dot" style="background:${c3}"></span>ROE（净资产收益率）</div>${lineChartSVG(roe,{years,color:c3,suffix:"%"})}</div>
    </div>
    <table class="fin-tbl"><thead><tr><th>年份</th><th>营收</th><th>净利</th><th>ROE</th></tr></thead><tbody>${rows}</tbody></table>
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
//  渲染：首页仪表盘（驾驶舱：聚合 + 引流，不重复各视图细节）
// ============================================================
function renderHome(){
  const wrap=document.getElementById("home-wrap");
  if(!wrap)return;
  const hs=state.holdings||[];
  const now=Date.now();
  const todayStart=new Date();todayStart.setHours(0,0,0,0);

  // ---- KPI 计算 ----
  const todayNews=state.all.filter(x=>x.ts>=todayStart.getTime()).length;
  const alerts7d=state.all.filter(x=>x.alert&&x.ts>=now-7*86400000);
  const earnRows=hs.map(h=>({h,ne:nextEarnings(h)})).filter(r=>r.ne&&r.ne.inDays>=0).sort((a,b)=>a.ne.inDays-b.ne.inDays);
  const nearest=earnRows[0]||null;
  const roes=hs.map(h=>{const d=h.financials&&h.financials.data;if(!d||!d.length)return null;const last=d[d.length-1];return typeof last.roe==="number"?last.roe:null;}).filter(v=>v!=null);
  const avgRoe=roes.length?(roes.reduce((a,b)=>a+b,0)/roes.length):null;

  // ---- KPI 条 ----
  let html=`<div class="hm-kpis">
    <div class="hm-kpi" onclick="gotoView('news','all')" title="点击查看新闻"><div class="hm-kpi-l">今日新闻</div><div class="hm-kpi-v">${todayNews}</div></div>
    <div class="hm-kpi ${alerts7d.length?"warn":""}" onclick="gotoView('alert')" title="点击查看预警"><div class="hm-kpi-l">7日预警</div><div class="hm-kpi-v">${alerts7d.length}</div></div>
    <div class="hm-kpi ${nearest&&nearest.ne.inDays<=15?"hot":""}" onclick="gotoView('cal')" title="点击查看日历"><div class="hm-kpi-l">最近财报${nearest?" · "+esc(nearest.h.name):""}</div><div class="hm-kpi-v">${nearest?nearest.ne.inDays+"<span class='u'>天</span>":"—"}</div></div>
    <div class="hm-kpi good" onclick="gotoView('stat')" title="点击查看财务"><div class="hm-kpi-l">组合平均ROE</div><div class="hm-kpi-v">${avgRoe!=null?avgRoe.toFixed(1)+"<span class='u'>%</span>":"—"}</div></div>
  </div>`;

  // ---- 持仓速览墙 ----
  html+=`<div class="hm-sec"><div class="hm-title">💼 持仓速览 <span class="hm-sub">点卡片看该公司新闻</span></div><div class="hm-wall">`;
  for(const h of hs){
    const items=state.all.filter(x=>x.company===h.name);
    const n7=items.filter(x=>x.ts>=now-7*86400000).length;
    const hasAlert=items.some(x=>x.alert&&x.ts>=now-3*86400000);
    const ne=nextEarnings(h);
    const soon=ne&&ne.inDays>=0&&ne.inDays<=15;
    html+=`<div class="hm-card ${hasAlert?"alerted":""}" onclick="gotoView('news','${esc(h.name).replace(/'/g,"\\'")}')">
      <div class="hm-card-top"><span class="hm-name">${esc(h.name)}</span><span class="hm-sector">${esc(h.sector||"")}</span></div>
      <div class="hm-card-meta">7日 ${n7} 条新闻</div>
      <div class="hm-card-tags">
        ${hasAlert?'<span class="hm-tag neg">● 预警</span>':""}
        ${soon?`<span class="hm-tag hot">财报 ${ne.inDays}天</span>`:(ne&&ne.inDays>=0?`<span class="hm-tag dim">财报 ${ne.inDays}天</span>`:"")}
      </div>
    </div>`;
  }
  html+=`</div></div>`;

  // ---- 中段两栏：财报倒计时 + 预警流 ----
  html+=`<div class="hm-cols">`;
  html+=`<div class="hm-sec hm-col"><div class="hm-title">📅 财报倒计时 <span class="hm-link" onclick="gotoView('cal')">全部 ›</span></div>`;
  if(!earnRows.length){html+=`<div class="hm-empty">暂无待披露财报</div>`;}
  else{
    for(const r of earnRows.slice(0,3)){
      const d=r.ne.inDays;
      html+=`<div class="hm-earn"><div><div class="hm-earn-n">${esc(r.h.name)}</div><div class="hm-earn-d">${r.ne.confirmed?esc(r.ne.date):"约"+r.ne.month+"月"}${r.ne.confirmed?"":" ·待核实"}</div></div><div class="hm-earn-v ${d<=15?"hot":d<=30?"mid":""}">${d}<span class="u">天</span></div></div>`;
    }
  }
  html+=`</div>`;
  html+=`<div class="hm-sec hm-col"><div class="hm-title">🔔 最新预警 <span class="hm-link" onclick="gotoView('alert')">全部 ›</span></div>`;
  const alertsLatest=state.all.filter(x=>x.alert).sort((a,b)=>b.ts-a.ts).slice(0,4);
  if(!alertsLatest.length){html+=`<div class="hm-empty">暂无预警命中</div>`;}
  else{
    for(const a of alertsLatest){
      const neg=a.alert==="neg";
      html+=`<a class="hm-alert ${neg?"neg":"pos"}" href="${esc(a.link)}" target="_blank" rel="noopener"><span class="hm-alert-co">${esc(a.company)}</span><span class="hm-alert-w">${esc((a.alertWords||[]).slice(0,2).join(" / "))}</span><span class="hm-alert-t">${esc(relTime(a.ts))}</span></a>`;
    }
  }
  html+=`</div></div>`;

  // ---- 最新要闻 ----
  html+=`<div class="hm-sec"><div class="hm-title">📰 最新要闻 <span class="hm-link" onclick="gotoView('news','all')">全部 ›</span></div>`;
  const latest=state.all.slice().sort((a,b)=>b.ts-a.ts).slice(0,5);
  if(!latest.length){html+=`<div class="hm-empty">暂无新闻数据，等云端爬虫跑完自动出现</div>`;}
  else{
    for(const it of latest){
      html+=`<a class="hm-news" href="${esc(it.link)}" target="_blank" rel="noopener"><span class="hm-news-co">${esc(it.company)}</span><span class="hm-news-t">${esc(it.title)}</span><span class="hm-news-time">${esc(relTime(it.ts))}</span></a>`;
    }
  }
  html+=`</div>`;

  // ---- 板块分布 + 护城河速览 ----
  const secCount={};
  hs.forEach(h=>{const s=h.sector||"未分类";secCount[s]=(secCount[s]||0)+1;});
  const secArr=Object.entries(secCount).sort((a,b)=>b[1]-a[1]);
  const SEC_COLORS=["#b8861b","#2e7d4f","#7d5ba6","#c0392b","#3a7ca5","#c77f1a"];
  html+=`<div class="hm-sec"><div class="hm-title">🛡 板块分布 & 护城河</div><div class="hm-secbar">`;
  secArr.forEach(([s,c],i)=>{
    html+=`<div class="hm-secseg" style="flex:${c};background:${SEC_COLORS[i%SEC_COLORS.length]}">${esc(s)} ${Math.round(c/hs.length*100)}%</div>`;
  });
  html+=`</div><div class="hm-moats">`;
  for(const h of hs){
    const m=(h.moat||"").split("+")[0].trim();
    html+=`<div class="hm-moat"><span class="hm-moat-n">${esc(h.name)}</span><span class="hm-moat-v">${esc(m||"—")}</span></div>`;
  }
  html+=`</div></div>`;

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
