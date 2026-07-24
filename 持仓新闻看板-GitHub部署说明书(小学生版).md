# 📦 持仓新闻看板 · 上云说明书（小学生也能做）

## 先搞懂：我们到底在干嘛？

把这个"新闻看板"放到网上，让你随时随地用手机打开看。整个过程像做三件事：

| 比喻 | 真实名字 | 干嘛用的 |
|------|----------|----------|
| 📦 一个贴了名字的快递盒 | **仓库 (Repository)** | 装你所有网页文件的地方 |
| 🤖 住在云端的机器人闹钟 | **GitHub Actions** | 每 30 分钟自动上网抓新闻，写回盒子里 |
| 🪟 街边的玻璃展示柜 | **GitHub Pages** | 把盒子里的网页亮出来，给你一个网址 |

> 好处：关掉电脑、甚至关机，机器人在云端照样干活，新闻一直在更新。而且**完全免费**。

---

## 你要准备的东西（清单）

1. 一个 **GitHub 账号**（免费，去 https://github.com 注册）
2. 下面这个文件夹（我已经帮你做好了）：`portfolio-news-gh`

---

## 第一步：登录 GitHub

打开 https://github.com ，用你的账号登录。

---

## 第二步：新建一个"快递盒"（仓库）

1. 点页面右上角的 **➕ 加号** → 选 **New repository（新建仓库）**
2. **Repository name（仓库名）** 填：`portfolio-news`
3. 下面选 **Public（公开）** 或 **Private（私有）** 都行（私有也免费）
4. **不要**勾 "Add a README file" 那个勾
5. 点绿色按钮 **Create repository（创建仓库）**

---

## 第三步：把文件夹寄进盒子（二选一）

> ⚠️ **重要提醒**：文件夹里有个叫 `.github` 的"隐藏文件夹"（名字前面带个点）。Windows 电脑默认看不见它，很容易漏传，那样机器人就不会干活了。下面两种方法，推荐用**方法 B**。

### 方法 A：在网页上拖拽（最简单，但要小心隐藏文件夹）

1. 进入刚建好的仓库，点绿色按钮旁边的 **Add file → Upload files**
2. 把 `portfolio-news-gh` 里面的**所有东西**拖进虚线框
3. ⚠️ 如果拖完后**没有看到 `.github` 文件夹**：先在电脑里打开"显示隐藏的项目"（文件夹顶部「查看」→ 勾「隐藏的项目」），再拖一次
4. 拖完拉到最下面，点 **Commit changes**

### 方法 B：用命令行（最稳，推荐让大人帮忙敲）

1. 打开 `portfolio-news-gh` 文件夹
2. 在文件夹顶部的**地址栏**里删掉原来的字，输入 `cmd`，按回车 —— 会弹出一个黑框
3. 一段一段**复制下面蓝框里的话**粘进去（把"你的用户名"改成你 GitHub 的名字），每粘一句按一次回车：

```bash
git init
git add .
git commit -m "我的新闻看板"
git branch -M main
git remote add origin https://github.com/你的用户名/portfolio-news.git
git push -u origin main
```

4. 第一次会让你输入用户名和密码：
   - **用户名** = 你的 GitHub 账号名
   - **密码** ❌ 不是登录密码！要填一个叫 **Token（令牌）** 的东西。去 GitHub 网页 → 右上角头像 → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**，勾上 `repo` 那个权限，生成后**复制那一串字符**当密码填进去

---

## 第四步：开"玻璃展示柜" Pages（拿到网址）

1. 进仓库，点最右边的 **⚙️ Settings（设置）**
2. 左边栏找到并点 **Pages**
3. **Source（来源）** 选 `Deploy from a branch`
4. **Branch** 选 `main`，右边目录选 `/ (root)`
5. 点 **Save**
6. 等 1～2 分钟，页面上方会出现你的网址，长这样：
   `https://你的用户名.github.io/portfolio-news/`

> 这个网址就是你的看板，把它存进手机书签。

---

## 第五步：唤醒"机器人闹钟" Actions（让它自动抓新闻）

1. 进仓库，点上面的 **Actions** 标签
2. 第一次会有一个**绿色提示**，点 **"I understand my workflows, go ahead and enable them"**
3. 之后它就**每 30 分钟自动跑一次**，完全不用你管
4. 想立刻看效果，就点 **Run workflow（运行工作流）** 按钮手动跑一次

---

## 🎉 搞定！以后怎么用？

- 打开那个 `*.github.io/portfolio-news/` 网址，就是你的看板（新闻 / 总览 / 预警 / 日历 / 统计 五个页面）
- **关掉电脑也在更新**（机器人在云端跑）
- **完全免费**，每月用的额度远低于上限

---

## 想改持仓公司？

用记事本打开文件夹里的 `holdings.json`，照着改名字就行（不用碰代码）。改完用**方法 B** 最后两行重新上传：

```bash
git add .
git commit -m "改了持仓"
git push
```

---

## ❓ 常见问题

**Q：网页打开是空白的？**
A：刚开 Pages 要等 1～2 分钟。或者去 **Actions** 点 **Run workflow** 让它先跑一次。

**Q：push 时要密码，但我输登录密码说不对？**
A：GitHub 早就不让用登录密码了，要填 **Token**（见第三步方法 B 第 4 点）。

**Q：找不到 `.github` 文件夹？**
A：它是隐藏文件夹，见第三步方法 A 的 ⚠️ 提醒，或直接用方法 B 最省心。

**Q：机器人多久抓一次？要钱吗？**
A：每 30 分钟一次，每月只花约 48 分钟免费额度（上限 2000 分钟），完全够用、不花钱。
