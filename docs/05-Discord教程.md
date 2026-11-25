# Discord 帖子：webg-gateway 宝宝级教程

> 建议标题：🚀 webg-gateway 宝宝级教程：把 Gemini 网页版变成 OpenAI 兼容 API
> 用法：第 1 条发主帖，2–6 条按顺序回在下面。每条都在 2000 字以内，已经按 Discord 的 Markdown 排好版。
> 第 3 条（Cloudflare KV）可以跳过，但跳过之后 Render 重新部署会丢凭证和 API Key。

---

## 第 1 条 / 共 6 条

📢 **webg-gateway：把 Gemini 网页版变成 OpenAI 兼容 API**
（宝宝级部署教程 · 6 条消息）

**它能干嘛？**
• 在 Cherry Studio、Open WebUI、NextChat、LobeChat 里直接用 Gemini 4
• 支持多 Google 账号轮换
• 自带网页管理面板、API Key、代理池
• 部署到 Render 免费层，不需要服务器和数据库

**先泼冷水（很重要）**
• 这是非官方接口，Google 的服务条款不欢迎这种用法，账号有被限制/封禁的风险
• 只建议用自己的账号、自己用；不要做公共池，不要卖 Key
• Cookie 等于你的 Google 登录态，泄露 = 别人能登你的号

**你需要准备**
1. GitHub 账号（Fork 代码）
2. Render 账号（免费部署）
3. 一个能正常打开 gemini.google.com 的 Google 账号
4. 一台电脑 + Chrome/Edge（拿 Cookie 必须用电脑）
5. 可选但强烈建议：Cloudflare 账号（免费 KV，防止数据丢）

**省流版**
Fork → Render 选 Docker + Free → 填 `ADMIN_PASSWORD` / `ENCRYPTION_KEY` → 打开 `/admin/` → 粘 Cookie → 建 API Key → Base URL 填 `/v1`

⏱️ 全程约 20 分钟，跟着做就行。

---

## 第 2 条 / 共 6 条

**第 1 步：Fork 仓库**
打开 <https://github.com/qiang927/web-gate>
点右上角 **Fork** → **Create fork**
完成后你的仓库是：
`https://github.com/<你的用户名>/web-gate`

**第 2 步：在 Render 建服务**
1. 打开 <https://dashboard.render.com>
2. 点 **New +** → **Web Service**
3. 连接 GitHub，选你刚 Fork 的 `web-gate` → **Connect**
   （列表里没有仓库？点 **Configure account** 授权 Render 访问 GitHub）
4. 按下面填：
• **Name**：`webg-gateway`（被占用就换一个，最终以 Render 给的 URL 为准）
• **Region**：Singapore（或离你近的）
• **Branch**：`main`
• **Runtime**：**Docker**（千万别选 Node）
• **Instance Type**：**Free**
• **Health Check Path**：`/health`
5. 展开 **Environment Variables**，加：
• `ADMIN_PASSWORD` = 你的面板密码（至少 8 位，记牢）
• `ENCRYPTION_KEY` = 一串固定的随机密钥（点 Generate，或本地 `openssl rand -hex 32`；生成后别改）
• `DATA_DIR` = `/data`
6. 点 **Create Web Service**，等 1–3 分钟

> 仓库根目录有 `render.yaml`，也可以用 **New + → Blueprint** 一键建；下面按手动步骤讲，最稳。

**成功标志**
日志里出现：
`gateway listening on port ...`

⚠️ 地址规则：`https://<服务名>.onrender.com`，不是你的 Render 用户名。以服务页顶部显示的 URL 为准。打开这个地址 + `/admin/` 就是面板。

---

## 第 3 条 / 共 6 条

**第 3 步：防止数据丢失（强烈建议，可跳过）**

Render 免费层的 `/data` 是临时的：重新部署/重启会清空，凭证和 API Key 都会没。用 Cloudflare KV 免费持久化。

> 只想先玩一下：可以跳过这条，但每次重新部署都要重导 Cookie 和 Key。

1. 打开 <https://dash.cloudflare.com>
2. 左侧 **Storage & Databases** → **KV** → **Create a namespace**
   名字随便，比如 `webg-gateway`
3. 进入 namespace，复制 **Namespace ID**（32 位）
4. 在 Cloudflare 首页右侧复制 **Account ID**
5. 右上头像 → **My Profile** → **API Tokens** → **Create Token**
   → **Create Custom Token**
   • Permissions：`Account` → `Workers KV Storage` → `Edit`
   • Account Resources：`Include` → 你的账号
   → Continue → Create → 复制 token（只显示一次）
6. 回 Render → 你的服务 → **Environment**，添加：

```
CF_KV_API_TOKEN=...
CF_ACCOUNT_ID=...
CF_KV_NAMESPACE_ID=...
```

7. 点 **Save Changes**，等自动重新部署

⚠️ 三个 `CF_` 要么全填，要么全不填。
⚠️ `ENCRYPTION_KEY` 填了就别改！改了 KV 里的旧密文永远解不开。

---

## 第 4 条 / 共 6 条

**第 4 步：拿 Gemini 网页版 Cookie（最关键）**

要的是 **gemini.google.com** 的 Cookie。
不是 aistudio.google.com，也不是 accounts.google.com。

**方法 A：DevTools（推荐）**
1. 电脑 Chrome 开无痕窗口（Ctrl+Shift+N）
2. 打开 <https://gemini.google.com>，登录 Google，随便发一句话确认有回复
3. 按 `F12` → **Network（网络）**
4. 在页面里再发一句话
5. 列表里找 `StreamGenerate?bl=...`（没有就刷新页面再发）
6. 点它 → **Headers** → **Request Headers** → 找到 **Cookie**
7. 复制 `Cookie:` 后面**整段**内容，长这样：
`SID=g.a000...; __Secure-1PSID=g.a000...; SAPISID=...; ...`

**方法 B：Cookie-Editor 插件**
1. 安装 Cookie-Editor
2. 在 gemini.google.com 页面点插件 → **Export** → **Header String**
3. 复制整串

❌ **不要用 `document.cookie`**
`SID`、`__Secure-1PSID` 是 HttpOnly，JS 读不到，导了必失败。

✅ 至少要有 `SID` 或 `__Secure-1PSID`；建议整段原样复制，不要只挑几个。

⏳ Cookie 会过期：正常几小时到几天；退出登录/改密码立即失效。失效就回来重导一次，不是部署坏了。

---

## 第 5 条 / 共 6 条

**第 5 步：导入面板**
1. 打开 `https://<你的地址>/admin/`
2. 输入 `ADMIN_PASSWORD` 登录
3. 点「凭证」→ 找到 **Gemini 网页版 Cookie**
4. 填写：
• Google 邮箱：你的 Gmail（建议填，方便区分）
• Cookie：粘贴整段
• 备注：随便，比如“主号”
5. 点 **验证并导入**

> Cookie 框里只放 `k=v; k=v; ...`，不要把 `Cookie:` 前缀也粘进去。

✅ 成功：凭证池出现一条 `cookie / active`
点「测试」显示会话有效，就稳了。

**第 6 步：创建 API Key**
1. 点「API Keys」
2. 输入备注（比如 laptop）→ **新建**
3. 列表里会出现 `sk-webg-gateway-...`，复制它
4. 这个 Key 是给你客户端用的，和 Google 无关，别发群里

**第 7 步：接客户端**
• **Base URL**：面板顶部「OpenAI 兼容接口」那一行，点「复制」
  一般长这样：`https://<你的地址>/v1`
  ⚠️ 不要带 `/admin`，也不要只填域名
• **API Key**：`sk-webg-gateway-...`
• **模型**：先填 `web-gemini-4-hydrogen-low`（免费号可用）
  想更强：`web-gemini-4-neon-high`（需 Pro）/ `web-gemini-4-carbon-high`（需 Ultra）
  命名规则：`web-gemini-4-档位-强度`，强度是 low / medium / high

> 想多一条 AI Studio 通道：同样在「凭证」里导入 aistudio.google.com 的 Cookie，会多出 `pggo-*` 模型；新手可以先跳过。

---

## 第 6 条 / 共 6 条

**第 8 步：验证能不能用**

把地址和 Key 换成你的，跑：

```bash
curl https://<你的地址>/v1/chat/completions \
  -H "Authorization: Bearer sk-webg-gateway-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"web-gemini-4-hydrogen-low","messages":[{"role":"user","content":"你好"}]}'
```

看到正常中文回复 = 成功。

**常见问题**
• 打开空白/404 → 面板地址要带 `/admin/`（末尾斜杠），API 是 `/v1`
• Render 构建失败 → 看 Logs 最上面第一处红字；多数是 Runtime 没选 Docker
• 一直转圈 → Render 免费层冷启动，等 30–60 秒；登录后又空白就强刷一次
• Cookie 验证失败 → 站点拿错 / 用了 document.cookie / Cookie 过期
• 302 跳到 `google.com/sorry` → 出口 IP 被风控，换 Region 或配代理池
• 重新部署后凭证没了 → 没配 Cloudflare KV
• 长回答断开 → 客户端开 `stream: true`
• 模型 404 → 去面板「模型」页或 `/v1/models` 看当前可用的名字

✅ **检查清单**
1. `/admin/` 能登录
2. 凭证池有一条 `cookie / active`
3. `/v1/models` 能看到模型
4. curl 或客户端能正常回中文

**最后再说一次**
Cookie = 你的 Google 登录态。不要发群、不要给别人的服务、不要截图露出。
只部署给自己用。

项目：<https://github.com/qiang927/web-gate>
