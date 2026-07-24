# 持仓新闻监控 · GitHub 常驻版

把"持仓公司新闻"做成**云端定时自动更新**的网站：关掉网页、甚至关机，新闻也在云端悄悄抓取刷新。

> 线上示例（本项目实际部署）：
> 网站 👉 https://huanghua-2019.github.io/portfolio-news/
> 仓库 👉 https://github.com/huanghua-2019/portfolio-news

---

## 一、一句话原理

```
GitHub Actions（云端机器人）每 30 分钟自动跑一次爬虫
        │  直连 Google News / 百度新闻 RSS
        │  解析 → 分类打标 → 预警词命中 → 去重
        ▼
写出 data/news.json，自动提交回仓库
        │  git commit + push 触发 Pages 重建
        ▼
GitHub Pages（免费静态托管）重新部署前端
        │
        ▼
你打开网址，浏览器读 data/news.json 渲染出看板
```

核心思路 = **免费服务器（GitHub Actions）+ 爬虫（crawl.mjs）+ 自动更新（cron 定时）**。
不是"前端网页自己爬"，而是"云端机器人先把新闻算好存成 json 文件，网页只负责读文件展示"——这样网页再简单、再慢都不会卡死，也彻底绕开了浏览器跨域限制。

---

## 二、背后的原理（为什么能自动更新、为什么免费）

### 1. GitHub Actions = 云端的一台"机器人闹钟"
- 它是 GitHub 提供的**免费虚拟机**，能按你设定的时间表（cron）自动执行脚本。
- 本项目里：`.github/workflows/crawl.yml` 就是它的"任务说明书"，写着"每隔 30 分钟，跑一次 `node crawler/crawl.mjs`"。
- 这台机器**不在你电脑上**，所以你关机、断网，它照样在 GitHub 的服务器上跑。

### 2. GitHub Pages = 免费的"玻璃展示柜"
- 它能把一个仓库里的静态文件（html/css/js/json）直接变成一个公开网址。
- 本项目里：它托管 `index.html` 等前端文件，你访问 `https://你的用户名.github.io/portfolio-news/` 就能看。
- Pages 会在仓库内容（尤其是 `data/news.json`）更新后**自动重新部署**，无需你手动操作。

### 3. `data/news.json` 是"数据中转站"
- 爬虫算出的新闻不直接塞进网页，而是写进这个 json 文件并提交回仓库。
- 网页只做一件事：`fetch('./data/news.json')` 读它、渲染。前后端解耦，任何一方坏了都不拖累另一方。

### 4. 为什么"关电脑也更新"
因为爬虫跑在 **GitHub 云端**，不在本地。本地电脑只是"第一次把代码推上去"用的，之后全自动。

### 5. 为什么"零成本"
- Actions 免费额度：**2000 分钟 / 月**。
- 本方案每 30 分钟跑一次 ≈ **48 分钟 / 月**，仅为额度的 2.4%，远未触顶。
- Pages 托管静态站点：**永久免费**。
- 爬虫零依赖（只用 Node 内置模块）、无第三方 API、无 LLM 调用 → 不产生任何额外费用。

### 6. 为什么用"后端爬虫"而不是"前端直连 RSS"
- 浏览器有 **CORS 跨域限制**：网页直接去抓 Google/百度 RSS 会被浏览器拦掉（早期纯静态版就栽在这）。
- 爬虫跑在 Node（后端），**没有跨域限制**，能直接 `fetch` RSS 源，稳定得多。

### 7. 多源兜底 + 零依赖
- `crawl.mjs` 同时尝试多个新闻源（Google News RSS、百度新闻 RSS、rss2json 中转），**一个挂了自动切下一个**，并在本地做去重。
- 只用了 Node 自带的 `https` / `fs` 等模块，**不装任何 npm 包**，所以不会有"依赖装不上 / 版本冲突"的问题。

---

## 三、整体架构流程图

```
┌─────────────────────────────────────────────────────────────┐
│  你的持仓配置  holdings.json  （茅台/腾讯/拼多多… 7 只）        │
└───────────────────────────┬─────────────────────────────────┘
                            │ 读取
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  crawler/crawl.mjs  （后端爬虫，零依赖 Node 脚本）             │
│   · 直连 Google News / 百度新闻 RSS                          │
│   · 多源兜底、正则解析 XML、分类、预警词命中、去重              │
│   · 产出 data/news.json                                      │
└───────────────────────────┬─────────────────────────────────┘
                            │ 写入并提交
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub Actions  ── cron "*/30 * * * *" 每 30 分钟触发        │
│   （云端机器人，关机也在跑）                                    │
└───────────────────────────┬─────────────────────────────────┘
                            │ push 新数据
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub 仓库  main 分支  （含 data/news.json）                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ 内容变更 → 自动重建
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub Pages  →  https://你的用户名.github.io/portfolio-news/ │
└───────────────────────────┬─────────────────────────────────┘
                            │ 浏览器 fetch('./data/news.json')
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  前端看板  index.html + app.js + styles.css                  │
│   五个视图：新闻 / 总览 / 预警 / 日历 / 统计                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、首次部署详细步骤（约 5–10 分钟）

> **前置条件（为什么需要这些？）**
> 1. 一个 GitHub 账号（https://github.com，免费注册）。
>    - 💡 **为什么**：整个方案的"云端机器人"和"网址展示柜"都跑在 GitHub 上，没账号就没地方托管。
> 2. 电脑装了 Git（https://git-scm.com 下载，一路下一步）。
>    - 💡 **为什么**：Git 是"把本地文件上传到 GitHub 仓库"的工具，没有它就没法把这套代码推上去。
> 3. 已配置好 SSH 密钥并连过 GitHub（公钥贴在 GitHub → Settings → SSH and GPG keys）。
>    - 💡 **为什么**：SSH 密钥相当于"电脑和 GitHub 之间的身份证"，配好后推送代码不用每次输密码、也更安全。本项目实际就是用 SSH 推送的。

### 第 1 步：在 GitHub 建仓库
1. 登录 GitHub，右上角 **+ → New repository**。
2. Repository name 填：`portfolio-news`（可自定义）。
3. 选 **Public**（Pages 最稳；Private 也行但配置略多）。
4. **不要**勾 "Add a README file"（我们用本地这套）。
5. 点 **Create repository**。

> 💡 **为什么做这一步**：仓库（repository）就是 GitHub 上用来"装代码 + 跑自动化"的容器。爬虫要往里写新闻、Pages 要从里读网页，都得先有这么一个仓库。选 Public 是因为免费版 Pages 对公开仓库最省心；不勾自带 README 是因为我们本地已经有一套完整文件，避免冲突。

### 第 2 步：本地准备（进到这个文件夹）
把本 README 所在的整个 `portfolio-news` 文件夹，放到你电脑方便的位置（本项目放在 `D:\portfolio-news`）。然后在终端进入它：

```bash
cd D:\portfolio-news
```

> 💡 **为什么做这一步**：后面所有 `git` 命令都只在"当前文件夹"生效。先 `cd` 进到这个目录，才能保证你提交、推送的是看板这一套文件，而不是电脑里别的乱七八糟的东西。

### 第 3 步：初始化并提交（设置 git 身份 + 首次 commit）
```bash
git init
git config user.name  "你的用户名"
git config user.email "你的用户名@users.noreply.github.com"
git add .
git commit -m "init: 持仓新闻监控看板"
git branch -M main
```
> `data/news.json` 已自带首次抓取结果（约 70 条），推上去后 Pages 第一次打开就有数据，不空屏。

> 💡 **为什么做这一步（每条命令的意义）**：
> - `git init`：把这个文件夹变成一个"被 Git 管理的仓库"，生成 `.git` 目录来记录所有变更历史。
> - `git config user.name/email`：给这次提交署个名。GitHub 要求每次提交都必须有作者身份，不填会直接报错。
> - `git add .`：把当前文件夹里所有文件"放进暂存区"，告诉 Git"这些是要提交的"。
> - `git commit`：正式生成一次快照（存档点），`"init: ..."` 是这次存档的说明。
> - `git branch -M main`：把主分支命名为 `main`（GitHub 现在默认叫 main，名字对上才能顺利推送）。
>
> 简单记：**init = 开仓库，add+commit = 拍第一张存档照，branch = 定主分支名。**

### 第 4 步：用 SSH 推送到 GitHub
```bash
git remote add origin git@github.com:你的用户名/portfolio-news.git
git push -u origin main
```
> - 若提示 `remote origin already exists`，先 `git remote remove origin` 再 add。
> - SSH 方式**不需要**输密码；若提示权限错误，检查 SSH 密钥是否已 `ssh -T git@github.com` 连通。
> - 本项目实际仓库：`git@github.com:huanghua-2019/portfolio-news.git`
> - （备选 HTTPS 方式：`git remote add origin https://github.com/你的用户名/portfolio-news.git`，推送时填**个人访问令牌 Token** 当密码，不是登录密码。）

> 💡 **为什么做这一步（每条命令的意义）**：
> - `git remote add origin <地址>`：给远端仓库起个代号叫 `origin`，以后 `git push` 就知道往哪推。相当于"把 U 盘插上并命名"。
> - `git push -u origin main`：把本地 `main` 分支的存档**上传到 GitHub**。`-u` 是"记住这次的推送关系"，以后直接 `git push` 就行，不用再写 `origin main`。
>
> 这一步是把代码真正"放到网上"的关键——之前全在本地，推完 GitHub 上才有内容，Pages 才能托管。

### 第 5 步：开启 Pages（把仓库变成网址）
1. 进仓库 → **Settings**（右上齿轮）→ 左侧 **Pages**。
2. Source 选 **Deploy from a branch**。
3. Branch 选 **main**，目录选 **/ (root)**。
4. 点 **Save**。
5. 等 1–2 分钟，页面会显示你的网址：
   `https://你的用户名.github.io/portfolio-news/`

> 💡 **为什么做这一步**：
> - Pages 是 GitHub 的"免费网页托管"功能。代码推上去只是存在仓库里，普通访客打不开；开了 Pages，GitHub 才会把 `index.html` 等文件编译成一个谁都能访问的网址。
> - 选 `main` 分支 + `/ (root)` 目录，是告诉 Pages"用主分支根目录下的网页文件"。
> - 等 1–2 分钟是因为 GitHub 要后台构建一次，不是点了立刻生效。
>
> **没有这步，你就只有一个代码仓库，而没有可以打开看的网站。**

### 第 6 步：让爬虫自动跑起来（开 Actions）
1. 进仓库 → 顶部 **Actions** 标签。
2. 第一次可能看到绿色提示 **"I understand my workflows, go ahead and enable them"** → 点一下启用。
3. 之后 `持仓新闻爬虫` 工作流会**每 30 分钟自动跑**；也可手动立即跑一次（见下一节）。

> 💡 **为什么做这一步**：
> - Actions 就是"云端机器人"。`.github/workflows/crawl.yml` 已经写好了"每 30 分钟抓一次新闻"的指令，但**默认是禁用状态**，必须手动点一下启用，它才开始按时干活。
> - 启用后，机器人的运行不再依赖你的电脑——你关机、睡觉，它都在 GitHub 服务器上按时抓取，这就是"自动更新"的真正来源。

### 第 7 步：验证上线
浏览器打开你的 Pages 网址，能看到"持仓监控 · 新闻回看"深色面板、首屏有新闻，即成功。
本项目实际网址：https://huanghua-2019.github.io/portfolio-news/

> 💡 **为什么做这一步**：前面 6 步都是"配置"，只有打开网址亲眼看到面板和新闻，才证明整条链路（仓库 → Actions 抓取 → Pages 展示）真正打通了。没看到就说明中间某步没生效，需要回头排查（见第十节 FAQ）。

---

## 五、怎么手动触发一次（"Run workflow" 在哪）

自动跑最快也要等 ≤30 分钟。想**立刻**看最新新闻，就手动跑一次：

**方法 A（直达链接）**
打开 👉 `https://github.com/你的用户名/portfolio-news/actions/workflows/crawl.yml`
右上角有 **`Run workflow ▾`** 按钮 → 点它 → 弹出的小框里再点一次 **`Run workflow`** 即可。

**方法 B（从仓库页找）**
1. 进仓库 → 顶部 **Actions** 标签。
2. 左侧列表点 **`持仓新闻爬虫`**。
3. 右侧 **`Run workflow ▾`** 按钮 → 点 → 再点确认。

> 💡 **为什么有这一步**：爬虫默认按排程每 30 分钟跑，但你改了持仓、或想马上看最新消息时，不用干等。手动 Run workflow 就是"立刻让机器人跑一次"，跑完它把新新闻提交回仓库，Pages 再自动刷新。
> 注意：手动跑**不是必须**的，不点也完全正常。

跑完后（约 1–2 分钟），它会把新抓的新闻提交回仓库，Pages 再过 1–2 分钟自动刷新。你刷新网址即见最新数据。

---

## 六、怎么确认它真的在自动跑

1. **看 Actions 运行记录**：仓库 → Actions → 点 `持仓新闻爬虫`，能看到一条条运行历史（绿色 ✓ = 成功）。
2. **看数据更新时间**：访问 `https://你的用户名.github.io/portfolio-news/data/news.json`，看里面 `updatedAt` 字段的时间，应该离现在不超过 30 分钟。
3. **看提交记录**：仓库 → 顶部 **Commits**，会看到爬虫定时提交的 "update news" 之类提交。

> 💡 **为什么有这一步**：万一爬虫挂了（比如某个新闻源全挂、或 GitHub 临时抽风），网页会一直显示旧新闻而你不知情。定期看一眼这三项，能确认"机器人还活着、还在按时干活"。

---

## 七、改你的持仓（不用碰代码）

编辑根目录 **`holdings.json`**：

```json
{ "name": "贵州茅台", "code": "600519.SH", "sector": "白酒", "note": "白酒龙头 · 长线", "earningsMonths": [4, 8] }
```

| 字段 | 含义 |
|------|------|
| `name` | 公司名（也作为新闻搜索关键词，可写中英文名提高召回） |
| `code` | 股票代码（仅展示用） |
| `sector` | 板块（用于"板块"筛选 chips 分组） |
| `note` | 备注（总览卡片显示） |
| `earningsMonths` | 财报披露月份，**按"当月 1 日"粗略倒计时**，具体日期需你自行核实 |

改完提交推送，下次 Actions 跑即生效：
```bash
git add holdings.json
git commit -m "更新持仓"
git push
```

> 💡 **为什么要 `commit` + `push`**：你只是在自己电脑上改了文件，GitHub 上的仓库和爬虫都不知道。必须 `commit`（本地存档）+ `push`（上传到 GitHub），改动的 `holdings.json` 才会进到仓库、被下次爬虫运行读到。只改本地不推 = 白改。

---

## 八、调密 / 扩展

**调抓取间隔（守免费额度）**
编辑 `.github/workflows/crawl.yml`：
```yaml
- cron: "*/30 * * * *"   # 每 30 分钟。改 "*/15" 更密但更耗额度；"0 * * * *" 每小时最省
```
> 免费额度 2000 分钟/月。30 分钟/次 ≈ 48 分钟/月（很宽裕）；15 分钟/次 ≈ 96 分钟/月（也够）；再密要留意。

**改预警词**
前端 `app.js` 顶部 `ALERT` 常量（`pos` 利好 / `neg` 利空），纯规则匹配，**不耗任何 API 费**。

**加更多数据源（如财联社 / 东方财富）**
在 `crawler/crawl.mjs` 的 `fetchRss()` 里加新的抓取分支即可（后端无跨域限制，比纯静态版自由得多）。注意免费公开的个股接口可能变动，需自行验证稳定性。

**换前端样式**
`styles.css` 是深色监控风；想改成浅色或其他配色直接改这里，不影响数据链路。

---

## 九、文件结构

```
portfolio-news/
├── holdings.json            # 你的持仓配置（最常改这个）
├── crawler/
│   └── crawl.mjs           # 后端爬虫（零依赖 Node，多源兜底）
├── .github/
│   └── workflows/
│       └── crawl.yml       # 定时任务：每 30 分钟跑爬虫 + 提交 JSON
├── index.html              # 前端页面（5 个视图）
├── styles.css             # 深色监控风样式
├── app.js                 # 前端逻辑（读 data/news.json 渲染）
├── data/
│   └── news.json          # 爬虫生成的新闻数据（Actions 自动更新）
└── README.md              # 本文件
```

---

## 十、常见问题排查（FAQ）

**Q：网站打开是 404 / 空白？**
- 确认 Pages 已开（Settings → Pages，Branch = main，目录 = /root）。
- 首次开启后等 1–2 分钟再访问。
- 确认仓库根目录有 `index.html`。

**Q：网页打开但没新闻 / 新闻是旧的？**
- 正常现象：显示的是上次爬虫提交的快照。手动 Run workflow 一次即可刷新。
- 若一直不更新，去 Actions 看 `持仓新闻爬虫` 是否报错（红 ✗）。

**Q：Actions 里点 Run workflow 没反应？**
- 确认工作流已"启用"（首次需点绿色启用提示）。
- 免费账号偶有限流，稍等重试。

**Q：推送被拒（non-fast-forward / 远端领先）？**
- **原因**：GitHub 上的仓库已经有了新提交（比如爬虫自动跑了），而你本地没有这些，直接 push 会被拒。
- **安全修复法**（比 `git pull --rebase` 更稳，不易把本地 `.git` 弄坏）：
  ```bash
  git fetch origin                              # 把远端最新提交下载到本地（不改动你的文件）
  git checkout -B main FETCH_HEAD --force     # 让本地 main 对齐到远端最新，并强制覆盖冲突的未跟踪文件
  # 然后重新放好你本地的改动（如更新后的 README），再：
  git add .
  git commit -m "你的说明"
  git push origin main
  ```
- ⚠️ 慎用 `git pull --rebase`：在本地有未提交改动、或 `.git` 状态异常时，它中途报错可能导致本地仓库元数据损坏（本项目曾踩过此坑）。优先用上面的 `fetch` + `checkout -B main FETCH_HEAD --force`。

**Q：想换仓库名 / 用户名？**
- 改仓库名后，Pages 网址会变，重新走一遍第 5 步即可；本地 `git remote set-url origin 新地址` 更新推送目标。

---

## 十一、已知限制（如实说明）

- **财报月是"月份级"粗略倒计时**（按当月 1 日估算），不是精确披露日。要精确到日需接交易所预约披露接口（超出免费静态范畴）。
- **不加 LLM 摘要就不花钱**。参考站有的 AI 摘要 / 推送功能是额外成本，本方案刻意不做，保持零成本。
- 新闻源目前是 **Google News + 百度新闻**（覆盖中英文公司名）。财联社电报 / 东财公告等更硬核源可后续自行接入（见第八节）。
- GitHub 的 cron 有 **0–15 分钟随机延迟**，属正常，不是没跑。
