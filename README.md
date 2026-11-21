# robin-gateway

把 Google 账号的 **robin 通道**（浏览器 `oauth_token` → master token）包装成 **OpenAI 兼容 API**，带多凭证池、管理面板，可部署到 Render。

它复刻的是 catiecli「robin」通道的凭证原理，而不是把请求转发给猫站。同一个 master token 驱动两条上游：

```
浏览器 oauth_token
      │  gpsoauth.exchange_token()                一次性兑换
      ▼
master token (oauth2rt_1/…)  ── AES-256-GCM 加密落盘
      │
      ├─ perform_oauth(cloud-platform scopes) ──▶ access token (ya29…)
      │        └─ POST cloudcode-pa.googleapis.com/v1internal:generateContent
      │                └─ agy-* 模型（Antigravity / Code Assist 目录）
      │
      └─ perform_oauth(service=…/accounts/OAuthLogin)
               └─ OAuthLogin → MergeSession → SID/APISID/SAPISID cookie
                       └─ gemini.google.com StreamGenerate
                               └─ web-* 模型（Gemini 网页版）
```

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`；支持 system、多轮、图片 data URL、function calling、JSON mode、`reasoning_content`。
- **一条凭证、两条上游**：`web-*` 走 Gemini 网页版（对话会出现在该账号的 Gemini 历史里），`agy-*` 走 Code Assist。
- **多凭证池**：轮询 + 失败计数排序，401/403/429/5xx 自动换号并冷却，400 参数错误不重试。
- **管理面板** `/admin/`：凭证导入/测试/禁用/换 app 身份、API Key、模型表、运行日志、改密码、Cloudflare KV 持久化。
- **零数据库**：JSON 文件 + 原子写；凭证用 `ENCRYPTION_KEY` 加密；admin 密码 scrypt。

## 本地运行

```bash
cd robin-gateway
npm install
ADMIN_PASSWORD=your-password npm start
# 控制台 http://localhost:8787/admin/
```

首次启动会打印自动生成的 `sk-robin-…` API Key 和 admin 密码（若未设 `ADMIN_PASSWORD`）。登录后可在「设置」里改密码；数据在 `DATA_DIR`（默认 `./data`）。

## 导入凭证（robin）

1. 用无痕窗口打开 [Android 设备登录页](https://accounts.google.com/o/android/auth?lang=en&cc=US&langCountry=en_US&xoauth_display_name=Android+Device&tmpl=new_account&source=android&return_user_id=true&flowName=EmbeddedSetupAndroid)（EmbeddedSetup 流程），登录目标账号。**普通 `accounts.google.com` 网页登录不会写入 `oauth_token`**，只有这个流程会（跳转参数带 `set_oauth_token_cookie=true`）。
2. 走完流程后，F12 → Application → Cookies → `accounts.google.com` → 找到 **HttpOnly** 的 `oauth_token`，复制整段（形如 `oauth2_4/…`）。`document.cookie` 读不到它是正常的。
3. 打开网关 `/admin/` →「导入 robin 凭证」→ 填邮箱与 `oauth_token` →「导入并验证」。

也可以直接用「已有 master token？直接导入」粘贴 `oauth2rt_1/…`（迁移/换部署时用）。

导入后：

- **web-* 模型**：只要 master token 有效就能用（内部会 mint OAuthLogin bearer 再换 Cookie）。
- **agy-* 模型**：需要 mint 出 cloud-platform bearer。若返回 `RESTRICTED_CLIENT`，说明这组 Android 应用身份被 Google 限制，面板里点「改 app」换一组 `app/client_sig` 重试。

> `oauth_token` 换出 master token 后即失效。master token 长期有效，但**修改 Google 密码会一次性吊销所有 master token**，之后需要重新走一遍上面的 EmbeddedSetup 导入。这是 Google 的设计，网关无法自动续。

## 模型

`GET /v1/models` 返回三类：

| 模型 | 上游 | 说明 |
|---|---|---|
| `web-gemini-4-hydrogen` | Gemini 网页版 | mode=1，日常/快速 |
| `web-gemini-4-neon` | Gemini 网页版 | mode=2，深度分析/思考 |
| `web-gemini-4-carbon` | Gemini 网页版 | mode=3，代码与复杂工作 |
| `web-gemini-4-auto` | Gemini 网页版 | mode=4，自动 |
| `web-gemini-4-flash-lite` | Gemini 网页版 | mode=6，轻量 |
| `web-gemini-3.7-flash` / `3.5-flash-thinking` / `3.1-pro` / `auto` / `flash-lite` | Gemini 网页版 | 旧 ID 兼容别名 |
| `gemini-4-*` / `gemini-3*` / `claude-*` / `gpt-oss-*` | Code Assist | Antigravity 模型目录，`agy` 组 |

`web-*` 请求体加 `"temporary": true`（或 `"web_temporary": true`）走临时对话，**不写入** Gemini 历史。默认会写历史——这是账号级调用的固有属性，不是网关 bug。`web-*` 只支持纯文本，不支持工具与图片。

## 部署到 Render

1. 推到 GitHub，Render → New → Blueprint，选中仓库。
2. 创建时填 `ADMIN_PASSWORD`（`sync: false`，不写进仓库）；`ENCRYPTION_KEY` 自动生成；`DATA_DIR=/data`。
3. 打开 `https://<service>.onrender.com/admin/`，用 `ADMIN_PASSWORD` 登录。
4. Render → Settings → Custom Domain 绑定独立域名。

**Render 免费实例没有持久磁盘**，`DATA_DIR` 里的凭证/Key/加密密钥每次重启都会丢。三选一：

- 升级 `starter` 并取消 `render.yaml` 里 `disk:` 段注释；
- 用 **Cloudflare KV** 持久化（免费额度够个人用，见下节）；
- 每次重启后重新导入（面板支持直接粘贴 master token）。

### Cloudflare KV 持久化

本地 JSON 是写缓存，KV 是权威存储：启动时 KV 有数据就覆盖本地，KV 为空就把本地迁移上去；清空 `/data` 后凭证自动回来。

1. Cloudflare Dashboard → Workers & Pages → KV → **Create namespace**，复制 Namespace ID；
2. Account ID 在 Dashboard 右侧栏；
3. My Profile → API Tokens → Create Token → 权限 `Account` → `Workers KV Storage` → `Edit`；
4. Render → Environment 添加 `CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`、`CF_KV_API_TOKEN`，并**固定 `ENCRYPTION_KEY`**；
5. 重启后日志出现 `store: Cloudflare KV mode`。

免费额度：读 10 万次/天、写 1000 次/天、存储 1 GB；代码已把 `uses`/`lastUsedAt` 合并写入（默认 5 分钟，`KV_STATS_FLUSH_MS` 可调）。KV 是最终一致的，适合凭证这种低频写入，不要多实例并发改同一份凭证。

## 客户端接入

```bash
curl https://<service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer sk-robin-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"web-gemini-4-neon","stream":true,"messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://<service>.onrender.com/v1", api_key="sk-robin-…")
print(client.chat.completions.create(
    model="web-gemini-4-hydrogen",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 凭证统计 |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions（`stream: true` 走 SSE） |
| POST | `/admin/api/login` | 管理员登录（cookie 会话） |
| POST | `/admin/api/password` | 修改管理员密码 |
| GET | `/admin/api/overview` | 凭证 / Key / 模型 / 设置 |
| POST | `/admin/api/credentials/import-robin` | `{email, oauthToken, label?, app?, clientSig?}` |
| POST | `/admin/api/credentials/import-master` | `{email, masterToken, label?}` |
| POST | `/admin/api/credentials/:id/test` | 强制刷新并探测上游 |
| PATCH | `/admin/api/credentials/:id` | `{label?, status?, app?, clientSig?, scopes?}` |
| DELETE | `/admin/api/credentials/:id` | 删除凭证 |
| GET | `/admin/api/logs?limit=` | 最近日志 |
| GET/POST/DELETE | `/admin/api/keys…` | 网关 API Key 管理 |

管理接口也可用 `X-Admin-Password: <password>` 直接调用。

## 环境变量

见 [`.env.example`](.env.example)。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 随机生成 | 管理面板密码 |
| `ENCRYPTION_KEY` | 自动生成文件 | 凭证加密密钥；PaaS 上必须固定 |
| `GATEWAY_API_KEYS` | 随机生成 | 逗号分隔的 `sk-robin-…` |
| `DATA_DIR` | `./data` | 凭证/Key/密钥目录 |
| `ROBIN_APP` / `ROBIN_CLIENT_SIG` | `com.google.android.gms` / `38918a45…` | mint bearer 的 Android 客户端身份 |
| `ROBIN_SCOPES` | cloud-platform + aicode + cclog + … | Code Assist 用的 scope |
| `WEB_APP` / `WEB_SIG` | Chromecast | 网页版 Cookie 通道用的身份 |
| `MAX_RETRIES` | 3 | 单请求最多尝试的凭证数 |
| `CREDENTIAL_COOLDOWN_MS` | 30000 | 失败后的基础冷却（401/403 ×10，429 按 Retry-After） |

## 架构

```
src/
  server.js      Express 路由：/v1/*、/admin/api/*、静态面板
  router.js      凭证选择、故障转移、冷却、错误分类
  credentials.js 导入（robin / master）、token 续期、测试
  gpsoauth.js    exchange_token / perform_oauth（Node 原生，无 Python 依赖）
  googleweb.js   OAuthLogin → MergeSession → StreamGenerate（web-* 通道）
  google.js      loadCodeAssist / onboardUser / UpstreamError
  upstream.js    v1internal generateContent / streamGenerateContent（SSE）
  translate.js   OpenAI ⇄ Gemini 请求/响应转换
  store.js       JSON 持久化、API Key、admin、凭证 CRUD
  crypto.js      AES-256-GCM、scrypt、随机数
  kv.js          Cloudflare KV 远端存储
public/admin/    单文件管理面板
test/            node:test 单测（签名、转换、SSE、错误分类、KV）
```

## 已验证 / 未验证

- ✅ 单测：gpsoauth 签名格式、OpenAI→Gemini 转换（工具/图片/JSON/thinking）、SSE 解析、错误分类、KV 往返。
- ✅ mock 上游端到端：`/v1/chat/completions` 非流式/流式、模型别名、API Key 鉴权。
- ✅ 真实账号：`oauth_token → master token → OAuthLogin → MergeSession → cookie → StreamGenerate` 全链路跑通（本机与 Render 均实测），`web-*` 非流式与流式返回真实回复。
- ⚠️ Code Assist（`agy-*`）：部分 Android 应用身份 mint 出的 bearer 会被 `cloudcode-pa` 以 `RESTRICTED_CLIENT` / `Cloud Code Private API has not been used` 拒绝；能否用取决于该身份所属 GCP 项目，换 app/sig 可试但无保证。
- ⚠️ master token 不可自动续：改密码即失效，需要重新 EmbeddedSetup 导入。

## 风险与合规

- **不要把 `oauth_token`、master token 提交到 Git**：凭证只存在 `DATA_DIR`/KV，仓库里不应出现任何真实凭证。
- 用第三方逆向流程调用 Google 模型**违反 Google 服务条款**，存在封号风险。请只用自己的账号，不要对外分发或售卖访问。
- master token 等价账号登录态，泄露后攻击者可访问该账号大部分服务，撤销只能改密码。
- `web-*` 调用的是 Gemini 网页版私有接口，Google 改版后可能失效，需要跟版更新 `src/googleweb.js`。
- 凭证只存在你的实例上，不经过猫站或任何第三方中转。
