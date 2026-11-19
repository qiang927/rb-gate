# robin-gateway

把 Google Code Assist（Antigravity 上游）包装成 **OpenAI 兼容 API** 的自建网关：多凭证池、自动续期、管理面板、一键部署到 Render。

它复刻的是 catiecli「robin」通道的凭证原理，而不是把请求转发给猫站：

```
浏览器 oauth_token
      │  gpsoauth.exchange_token()      （一次性 master token 兑换）
      ▼
master token (oauth2rt_1/…)  ── 加密落盘（AES-256-GCM）
      │  gpsoauth.perform_oauth(service="oauth2:<scopes>")
      ▼
access token (ya29…)  ── 缓存到过期前 5 分钟
      │  POST cloudcode-pa.googleapis.com/v1internal:generateContent
      ▼
Gemini / Claude 模型  →  翻译成 OpenAI Chat Completions 响应
```

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`，支持 system、多轮、图片（data URL）、function calling、JSON mode、`reasoning_content`（thinking 模型）。
- **多凭证池**：按 Google 账号导入多条凭证；轮询 + 失败计数排序，401/403/429/5xx 自动换号并冷却，400 参数错误不重试。
- **两种导入方式**：① robin 方式（浏览器 `oauth_token` → master token，长期有效）；② 标准 Antigravity OAuth 授权码（refresh token 自动续期）。
- **管理面板** `/admin/`：凭证增删/测试/禁用、API Key 管理、模型表、运行设置。
- **零数据库**：JSON 文件 + 原子写；密钥用 `ENCRYPTION_KEY` 加密；admin 密码 scrypt。
- **单依赖**：只依赖 `express`。

## 本地运行

```bash
cd robin-gateway
npm install
ADMIN_PASSWORD=your-password npm start
# 控制台 http://localhost:8787/admin/
```

首次启动会打印一个自动生成的 `sk-robin-…` API Key 和 admin 密码（若未设置 `ADMIN_PASSWORD`）。登录后可在「设置 → 管理员密码」里改成你自己的密码（8–128 位）；若密码由环境变量 `ADMIN_PASSWORD` 提供，面板会禁改并提示到部署平台修改。数据在 `DATA_DIR`（默认 `./data`）。

## 导入凭证

### 方式一：robin（推荐，长期有效）

1. 浏览器登录要使用的 Google 账号（`https://accounts.google.com`）。
2. F12 → Application → Cookies → `accounts.google.com` → 找到 **HttpOnly** 的 `oauth_token`，复制整段值（形如 `oauth2_4/…`）。`document.cookie` 读不到它是正常的。
3. 打开网关 `/admin/` → 填入邮箱与 `oauth_token` → 「导入并验证」。

服务端会立即执行 `exchange_token` 换 master token、mint 一次 access token、调用 `loadCodeAssist` 拿项目 ID；成功即进入凭证池。之后每 55 分钟自动续期，不需要再碰浏览器。

> `oauth_token` 换出 master token 后即失效，但 **master token 等价于该 Google 账号的长期授权**（撤销方式只有改密码/踢设备）。请只把自己的凭证导入自己部署的实例。

### 方式二：OAuth 授权码（Antigravity 客户端流程）

这条路径需要 Antigravity 桌面客户端的公开 OAuth client（`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`），在部署环境里配置，**不要提交到 git**；只用 robin 导入的话可以不配。

配好后在面板点「生成授权链接」，浏览器完成 Google 授权，回调到 `/admin/oauth/callback` 自动导入；服务端用 refresh token 续期。适合不方便抠 Cookie 的场景。

## 部署到 Render

仓库根目录带 `Dockerfile` 与 `render.yaml`：

1. 推到 GitHub，Render → New → Blueprint，选中仓库。
2. 创建时 Render 会让你填 `ADMIN_PASSWORD`（`sync: false`，不写进仓库）；`ENCRYPTION_KEY` 自动生成，`DATA_DIR=/data`。之后随时可在 Dashboard → Environment 改密码，保存并重启生效。
3. 部署完成后打开 `https://<service>.onrender.com/admin/`，用 Dashboard 里 `ADMIN_PASSWORD` 的值登录。
4. 在 Render → Settings → Custom Domain 绑定你的独立域名（CNAME 到 `*.onrender.com`）。

**重要：Render 免费实例没有持久磁盘。** `DATA_DIR` 里的凭证、API Key、加密密钥在每次重启/重新部署后都会丢失（免费实例还会休眠）。生产使用请：

- 升级到 `starter` 并取消 `render.yaml` 里 `disk:` 段的注释（1 GB 足够），或
- 把 `DATA_DIR` 挂到任意持久卷，并固定 `ENCRYPTION_KEY`（否则旧凭证解密失败）。

也可以在 Cloudflare 上放一个 Worker/Caddy 反代到 Render，用 `gateway.example.com` 统一入口。

## 客户端接入

任何 OpenAI 兼容客户端（Cherry Studio、NextChat、LobeChat、OpenAI SDK、LangChain…）：

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-robin-…" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://gateway.example.com/v1", api_key="sk-robin-…")
print(client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

模型名可用 `GET /v1/models` 查看；常用别名：`gemini-3-flash` → `gemini-3-flash-preview`、`gemini-3-pro` → `gemini-3-pro-preview`、`claude-sonnet-4` → `claude-sonnet-4-6`、`claude-opus-4` → `claude-opus-4-6-thinking`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 凭证统计 |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions（`stream: true` 走 SSE） |
| POST | `/admin/api/login` | 管理员登录（cookie 会话） |
| POST | `/admin/api/password` | 修改管理员密码 `{currentPassword, newPassword}` |
| GET | `/admin/api/overview` | 凭证 / Key / 模型 / 设置 |
| POST | `/admin/api/credentials/import-robin` | `{email, oauthToken, label?}` |
| POST | `/admin/api/credentials/:id/test` | 强制刷新并探测上游 |
| PATCH | `/admin/api/credentials/:id` | `{label?, status: "active"\|"disabled"}` |
| DELETE | `/admin/api/credentials/:id` | 删除凭证 |
| GET/POST/DELETE | `/admin/api/keys…` | 网关 API Key 管理 |

管理接口也可用 `X-Admin-Password: <password>` 直接调用（便于脚本）。

## 环境变量

见 [`.env.example`](.env.example)。关键的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 随机生成 | 管理面板密码；不设则首启生成随机密码，登录后可在面板修改 |
| `ENCRYPTION_KEY` | 自动生成文件 | 凭证加密密钥；PaaS 上必须固定 |
| `GATEWAY_API_KEYS` | 随机生成 | 逗号分隔的 `sk-robin-…` |
| `DATA_DIR` | `./data` | 凭证/Key/密钥存储目录 |
| `ROBIN_APP` / `ROBIN_CLIENT_SIG` | Chromecast | mint bearer 用的 Android 客户端身份 |
| `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` | 空 | OAuth 授权码导入用；不进 git |
| `ROBIN_SCOPES` | cloud-platform + aicode + cclog + … | mint 的 OAuth scope |
| `MAX_RETRIES` | 3 | 单请求最多尝试的凭证数 |
| `CREDENTIAL_COOLDOWN_MS` | 30000 | 失败后的基础冷却（401/403 会 ×10，429 按 Retry-After） |

## 架构

```
src/
  server.js      Express 路由：/v1/*、/admin/api/*、静态面板
  router.js      凭证选择、故障转移、冷却、错误分类
  credentials.js 导入（robin / OAuth）、token 续期、测试
  gpsoauth.js    exchange_token / perform_oauth（Node 原生，无 Python 依赖）
  google.js      OAuth、loadCodeAssist、onboardUser、UpstreamError
  upstream.js    v1internal generateContent / streamGenerateContent（SSE）
  translate.js   OpenAI ⇄ Gemini 请求/响应转换
  store.js       JSON 持久化、API Key、admin、凭证 CRUD
  crypto.js      AES-256-GCM、scrypt、随机数
public/admin/    单文件管理面板
test/            node:test 单测（签名、转换、SSE、错误分类）
```

## 已验证 / 未验证

- ✅ 本地 14 个单测通过：gpsoauth 签名格式、OpenAI→Gemini 转换（含工具/图片/JSON/thinking）、SSE 解析、错误分类。
- ✅ 用 mock 上游端到端验证了 `/v1/chat/completions` 非流式/流式、模型别名、API Key 鉴权。
- ⚠️ **真实上游未验证**：需要你自己的 Google 账号 `oauth_token`。`exchange_token` → master token → mint bearer → `cloudcode-pa` 这条链依赖 Google 对 client/app 身份的校验，若 mint 出的 token 被拒（403/401），可在面板里换 `ROBIN_APP`/`ROBIN_CLIENT_SIG` 或改用 OAuth 导入。

## 风险与合规

- **不要把 `oauth_token`、master token、refresh token 提交到 Git**：本项目的凭证只存在 `DATA_DIR`（已加入 `.gitignore`），导入走面板或环境变量，仓库里不应出现任何真实凭证。
- 用第三方逆向流程（Code Assist/Antigravity 的 Android 客户端身份）调用 Google 模型，**违反 Google 服务条款**，存在封号风险（社区已有案例）。请只用自己的账号，不要对外分发或售卖访问。
- master token 权限等价账号登录态，泄露后攻击者可访问该 Google 账号的大部分服务，撤销只能改密码。
- 本服务的凭证只存在你的实例上，不经过猫站或任何第三方中转。
