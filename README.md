# 持仓新闻监控 · GitHub 常驻版

把"持仓公司新闻"做成**云端定时自动更新**的网站。原理：

```
GitHub Actions 每 30 分钟在云端跑 crawler/crawl.mjs
        │ 抓取 Google News / 百度新闻 RSS
        │ 解析 → 分类打标 → 预警词命中 → 去重
        ▼
   写出 data/news.json，自动提交回仓库
        │
        ▼
  GitHub Pages 托管静态前端，直接读 data/news.json
```

- **关掉网页、甚至电脑关机，新闻也在云端悄悄更新**（Actions 在跑）
- **零成本**：只用 GitHub 免费额度（每月 2000 分钟，本方案约 48 分钟/月，远低于上限）
- **不依赖任何公共 CORS 代理**（爬虫在后端直连，比纯静态版更稳）

---

## 一、首次部署（5 分钟，照做即可）

> 前置：有一个 GitHub 账号（没有就去 https://github.com 注册，免费）。

### 1. 建仓库
GitHub 右上角 **+ → New repository**：
- Repository name：`portfolio-news`（随便起）
- 选 **Private 或 Public 都行**（私有仓库的 Pages 现在也免费）
- 不要勾 "Add a README"（我们用本地这套）
- 点 **Create repository**

### 2. 把本目录推上去
在你电脑上（已装 Git），进入本目录后执行（把 `你的用户名` 换成实际）：

```bash
git init
git add .
git commit -m "init: 持仓新闻监控"
git branch -M main
git remote add origin https://github.com/你的用户名/portfolio-news.git
git push -u origin main
```

> `data/news.json` 已包含首次抓取结果（约 70 条），推上去后 Pages 首次打开就有数据，不会空。

### 3. 开 Pages（静态托管）
仓库页 **Settings → Pages**（左侧栏）：
- Source 选 **Deploy from a branch**
- Branch 选 **main** ，目录选 **/ (root)**
- 点 **Save**
- 等 1–2 分钟，页面会显示 `https://你的用户名.github.io/portfolio-news/` 这个网址

### 4. 让 Actions 跑起来
仓库页 **Actions** 标签：
- 第一次可能需要点 **"I understand my workflows, go ahead and enable them"**（或绿色提示启用）
- 之后每 30 分钟自动跑；也可在 Actions 页面手动 **Run workflow** 立即跑一次
- 跑完后 `data/news.json` 被更新提交，刷新 Pages 网址即见最新

**完成。** 打开 Pages 网址，就是你的持仓新闻监控面板（新闻/总览/预警/日历/统计 五个视图）。

---

## 二、改你的持仓

编辑根目录 **`holdings.json`**（不用碰代码）：

```json
{ "name": "贵州茅台", "code": "600519.SH", "sector": "白酒", "note": "白酒龙头 · 长线", "earningsMonths": [4, 8] }
```

| 字段 | 含义 |
|------|------|
| `name` | 公司名（也作为新闻搜索关键词） |
| `code` | 股票代码（仅展示用） |
| `sector` | 板块（用于"板块"筛选 chips） |
| `note` | 备注（总览卡片显示） |
| `earningsMonths` | 财报披露月份，**按"当月1日"粗略倒计时**，具体日期需你核实 |

改完 `git add holdings.json && git commit -m "更新持仓" && git push`，下次 Actions 跑即生效。

---

## 三、调密 / 扩展

**调抓取间隔（守免费额度）**
`.github/workflows/crawl.yml` 里：
```yaml
- cron: "*/30 * * * *"   # 每 30 分钟。改 "*/15" 更密但更耗额度；"0 * * * *" 每小时最省
```
> 免费额度 2000 分钟/月。30 分钟/次 ≈ 48 分钟/月，很宽裕；15 分钟/次 ≈ 96 分钟/月，也够；再密要留意。

**改预警词**
前端 `app.js` 顶部 `ALERT` 常量（`pos` 利好 / `neg` 利空）。纯规则匹配，**不耗任何 API 费**。

**加更多数据源（如财联社/东财）**
在 `crawler/crawl.mjs` 的 `fetchRss()` 里加新的抓取分支即可（后端无跨域限制，比纯静态版自由得多）。注意免费公开的个股接口可能变动，需自行验证稳定性。

---

## 四、文件结构

```
portfolio-news-gh/
├── holdings.json            # 你的持仓配置（改这个）
├── crawler/crawl.mjs     # 后端爬虫（零依赖，多源兜底）
├── .github/workflows/
│   └── crawl.yml         # 定时任务：每30分钟跑爬虫+提交JSON
├── index.html            # 前端页面（5个视图）
├── styles.css            # 深色监控风样式
├── app.js               # 前端逻辑（读 data/news.json 渲染）
├── data/news.json        # 爬虫生成的新闻数据（Actions 自动更新）
└── README.md
```

---

## 五、已知限制（如实说明）

- **财报月是"月份级"粗略倒计时**（按当月1日估算），不是精确披露日。要精确到日需接交易所预约披露接口（超出免费静态范畴）。
- **不加 LLM 摘要就不花钱**。参考站有的 AI 摘要/推送功能是额外成本，本方案刻意不做，保持零成本。
- 新闻源目前是 **Google News + 百度新闻**（覆盖中英文公司名）。财联社电报/东财公告等更硬核源可后续自行接入（见第三节）。
