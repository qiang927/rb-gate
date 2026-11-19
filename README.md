# robin-gateway

把 Google 的两种账号级上游包装成 **OpenAI 兼容 API** 的自建网关：Code Assist（Antigravity 模型）与 Gemini 网页版（猫站 robin 同款链路），带多凭证池、自动续期、管理面板，可部署到 Render。

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
- **两条上游**：① Code Assist（`cloudcode-pa`，Antigravity 的 15 个模型）；② Gemini 网页版（`web-gemini-*`，走 `StreamGenerate` 私有 RPC，对话会写进 Gemini 网页/客户端历史）。
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

1. 用无痕窗口打开 [Android 设备登录页](https://accounts.google.com/o/android/auth?lang=en&cc=US&langCountry=en_US&xoauth_display_name=Android+Device&tmpl=new_account&source=android&return_user_id=true&flowName=EmbeddedSetupAndroid)（EmbeddedSetup 流程），登录目标账号。**普通 `https://accounts.google.com` 网页登录不会写入 `oauth_token`**，只有这个 Android 设备添加账号流程会（跳转参数里带 `set_oauth_token_cookie=true`）。
2. 走完页面流程后，F12 → Application → Cookies → `accounts.google.com` → 找到 **HttpOnly** 的 `oauth_token`，复制整段值（形如 `oauth2_4/…`）。`document.cookie` 读不到它是正常的。
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

**重要：Render 免费实例没有持久磁盘。** `DATA_DIR` 里的凭证、API Key、加密密钥在每次重启/重新部署后都会丢失（免费实例还会休眠）。三选一：

- 升级到 `starter` 并取消 `render.yaml` 里 `disk:` 段的注释（1 GB 足够）；
- 用 **Cloudflare KV** 做持久化（免费额度够个人用，见下节）；
- 每次重启后重新导入凭证（推荐先拿 master token 备份，面板支持直接导入）。

改了 `ENCRYPTION_KEY` 之后，旧数据（本地文件或 KV 里的密文）都解不开，记得同时固定住它。

### 凭证持久化：Cloudflare KV（免费）

本地 JSON 文件仍然是写缓存，KV 作为权威存储：启动时 KV 有数据就覆盖本地，KV 为空就把本地迁移上去。清空 `/data` 之后凭证会自动从 KV 回来。

1. Cloudflare Dashboard → Workers & Pages → KV → **Create namespace**（例如 `robin-gateway`），复制 Namespace ID；
2. Account ID 在 Dashboard 右侧栏；
3. My Profile → API Tokens → Create Token → 自定义权限：`Account` → `Workers KV Storage` → `Edit`，Account Resources 选自己的账号；
4. 在 Render → Environment 添加三个变量（**并且固定 `ENCRYPTION_KEY`**，否则 KV 里的密文解不开）：
   - `CF_ACCOUNT_ID`
   - `CF_KV_NAMESPACE_ID`
   - `CF_KV_API_TOKEN`
5. 重启后日志会出现 `store: Cloudflare KV mode`；之后重启、休眠唤醒、清空 `/data` 都不丢凭证。

免费额度：读 10 万次/天、写 1000 次/天、存储 1 GB。代码已经把 `uses`/`lastUsedAt` 这类计数合并写入（默认每 5 分钟，`KV_STATS_FLUSH_MS` 可调），正常个人使用远低于写入配额。

注意事项：KV 是最终一致的（跨区域可能延迟几十秒），适合凭证这种低频写入；不要同时跑多个实例并发改同一份凭证。KV 里存的是 `enc:v1:…` 密文，但 `ENCRYPTION_KEY` 仍然要保密。

也可以在 Cloudflare 上放一个 Worker/Caddy 反代到 Render，用 `gateway.example.com` 统一入口。

## Gemini 网页版通道（`web-` 模型）

这是猫站 robin 后端实际使用的链路，不经过 `cloudcode-pa`，所以不会遇到「Cloud Code Private API has not been used in project …」的 403：

```
master token
  │  perform_oauth(service="oauth2:https://www.google.com/accounts/OAuthLogin")
  ▼
Bearer (ya29…)
  │  GET https://accounts.google.com/OAuthLogin?source=ChromiumBrowser&issueuberauth=1
  ▼
uberauth
  │  GET https://accounts.google.com/MergeSession?service=mail&continue=https://www.google.com&uberauth=…
  ▼
SID / APISID / SAPISID cookies
  │  GET https://gemini.google.com/app   →  抓 SNlM0e (at) / cfb2h (bl)
  ▼
POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
```

可用模型：

| 模型 | 说明 |
|---|---|
| `web-gemini-3.7-flash` | 默认，全能 |
| `web-gemini-3.5-flash-thinking` | 深度思考，长输出 |
| `web-gemini-3.1-pro` | Pro |
| `web-gemini-auto` | 自动选择 |
| `web-gemini-flash-lite` | 轻量快速 |

使用前提：凭证池里至少有一条带 master token 的 robin 凭证（面板「导入并验证」成功过一次即可；即使 Code Assist 的 `loadCodeAssist` 报 403，web 通道仍然可用，因为它是另一条链路）。

- 请求体加 `"temporary": true`（或 `"web_temporary": true`）走临时对话，**不写入** Gemini 历史。
- 默认 `temporary=false`：对话会出现在该账号的 **Gemini 网页/客户端历史**里。这是账号级调用的固有属性，不是网关 bug。
- web 通道目前只支持纯文本对话；工具调用、图片输入不支持（返回纯文本）。
- 该链路依赖 Gemini 网页版内部 RPC，Google 改版后可能失效，需要跟版更新 `src/googleweb.js`。

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
- ✅ 真实凭证验证：`oauth_token → master token → OAuthLogin → MergeSession → SID cookie → StreamGenerate` 全链路跑通，`web-gemini-3.7-flash` 非流式与流式均返回真实回复（本机实测）。
- ⚠️ Code Assist 链路：`mint` 出的 Bearer 可能被 `cloudcode-pa` 拒绝（403 Cloud Code Private API not enabled），这是 Android app 身份所属 GCP 项目的问题，换 app/sig 未必能解；此时请用 `web-` 模型或标准 OAuth 导入。

## 风险与合规

- **不要把 `oauth_token`、master token、refresh token 提交到 Git**：本项目的凭证只存在 `DATA_DIR`（已加入 `.gitignore`），导入走面板或环境变量，仓库里不应出现任何真实凭证。
- 用第三方逆向流程（Code Assist/Antigravity 的 Android 客户端身份）调用 Google 模型，**违反 Google 服务条款**，存在封号风险（社区已有案例）。请只用自己的账号，不要对外分发或售卖访问。
- master token 权限等价账号登录态，泄露后攻击者可访问该 Google 账号的大部分服务，撤销只能改密码。
- `web-` 通道调用的是 Gemini 网页版私有接口，风控比 Code Assist 更严，异常频率/指纹可能导致账号被要求验证或封禁。
- 本服务的凭证只存在你的实例上，不经过猫站或任何第三方中转。
