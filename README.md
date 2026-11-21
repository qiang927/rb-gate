# robin-gateway（Cookie 版）

把 **Gemini 网页版会话**包装成 **OpenAI 兼容 API**，带凭证管理面板，可部署到 Render。

```
浏览器 Cookie（gemini.google.com）
      │  AES-256-GCM 加密落盘 / Cloudflare KV
      ▼
GoogleWebSession ── GET gemini.google.com/app 取 at/bl
      │
      └─ POST /_/BardChatUi/data/.../StreamGenerate（mode 决定模型）
               └─ web-* 模型（Gemini 4 Hydrogen / Neon / Carbon / Auto / Flash-Lite）
```

> 早期版本支持 robin（`oauth_token` → master token → Code Assist / 服务端换 Cookie）。实测两条路都被 Google 挡死：
> `agy-*` 报 `RESTRICTED_CLIENT`，服务端 mint 的网页版会话被判定为未登录（302 到 `ServiceLogin`）。
> 因此现在只保留**浏览器 Cookie 直连**这一种凭证来源。

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`；支持 system、多轮、`stream_options.include_usage`。
- **10 个 `web-*` 模型**：`web-gemini-4-hydrogen/neon/carbon/auto/flash-lite` + 5 个旧 ID 别名。
- **凭证管理**：Cookie 导入（导入前自动验证）、测试、禁用、删除；多凭证按最久未用优先轮换。
- **管理面板** `/admin/`：凭证、API Keys、模型表、运行日志、改密码。
- **零数据库**：JSON 文件 + 原子写；Cookie 用 `ENCRYPTION_KEY` 加密；admin 密码 scrypt。
- **可选 Cloudflare KV 持久化**：解决 Render 免费层重启丢 `/data` 的问题。

## 本地运行

```bash
cd robin-gateway
npm install
ADMIN_PASSWORD=your-password npm start
# 控制台 http://localhost:8787/admin/
```

首次启动会打印自动生成的 `sk-robin-…` API Key 和 admin 密码（若未设 `ADMIN_PASSWORD`）。数据在 `DATA_DIR`（默认 `./data`）。

## 导入凭证（Gemini 网页版 Cookie）

1. 浏览器正常登录并打开 <https://gemini.google.com>，确认能对话。
2. F12 → Network → 随便点一个 `gemini.google.com` 的请求 → Request Headers → 复制整段 `Cookie`（格式 `k=v; k=v; …`）。
   - 也可以在 Application → Cookies → `https://gemini.google.com` 逐项复制后拼起来。
3. 打开网关 `/admin/` →「Gemini 网页版 Cookie」→ 粘贴 →「验证并导入」。导入时会先请求一次 Gemini 验证，无效会直接报错。
4. 在「凭证池」里可以「测试」确认会话仍然有效。

Cookie 常见有效期几小时到几天；失效后重新粘贴。退出登录 / 改密码会立即失效。

## 模型

`GET /v1/models` 返回 10 个模型，全部走网页版通道，`groups: ["robin"]`：

| 模型 ID | 网页版档位 |
|---|---|
| `web-gemini-4-hydrogen` | 4 Hydrogen（日常） |
| `web-gemini-4-neon` | 4 Neon（深度分析） |
| `web-gemini-4-carbon` | 4 Carbon（代码/复杂） |
| `web-gemini-4-auto` | 自动 |
| `web-gemini-4-flash-lite` | Flash-Lite |
| `web-gemini-3.7-flash` 等 5 个 | 旧 ID 别名，映射到上面 5 个 |

网页版没有 4 Argon；需要 Argon 只能用 Gemini API 付费层（`gemini-4-argon`）。

## 部署到 Render

1. 新建 Web Service，Docker 部署，仓库根目录即 `robin-gateway/`。
2. 环境变量：`ADMIN_PASSWORD`、`ENCRYPTION_KEY`（固定值）、可选 Cloudflare KV 三项（见下）。
3. 健康检查 `/health`，端口用 Render 注入的 `PORT`。

### Cloudflare KV 持久化（免费层推荐）

1. Cloudflare Dashboard → Workers & Pages → KV → 创建 namespace。
2. 创建 API Token（权限 `Workers KV Storage:Edit`）。
3. Render 环境变量加 `CF_KV_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`。
4. 启动日志出现 `store: Cloudflare KV mode` 即生效；凭证、API keys、admin、settings 都会同步到 `robin/*` key。

免费层每天 1000 次写、10 万次读；用量统计按 5 分钟合并写。`ENCRYPTION_KEY` 必须固定，否则重启后 KV 里的密文解不开。

## 客户端接入

```bash
curl https://<your-app>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer sk-robin-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"web-gemini-4-neon","messages":[{"role":"user","content":"你好"}]}'
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 聊天（流式/非流式） |
| POST | `/admin/api/login` | 面板登录 |
| GET | `/admin/api/overview` | 凭证、模型、统计 |
| POST | `/admin/api/credentials/import-web-cookie` | 导入 Gemini Cookie |
| POST | `/admin/api/credentials/:id/test` | 测试凭证 |
| PATCH | `/admin/api/credentials/:id` | 备注 / 启停 |
| DELETE | `/admin/api/credentials/:id` | 删除凭证 |
| POST/GET | `/admin/api/keys` | API Key 管理 |
| GET | `/admin/api/logs` | 最近日志 |

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `PORT` | 否 | 默认 8787 |
| `DATA_DIR` | 否 | 默认 `./data`（Render 上建议 `/data`） |
| `ADMIN_PASSWORD` | 推荐 | 面板密码；不设则随机生成并打印 |
| `ENCRYPTION_KEY` | PaaS 必填 | 固定密钥，加密 Cookie |
| `SESSION_SECRET` | 否 | 默认由 `ENCRYPTION_KEY` 派生 |
| `GATEWAY_API_KEYS` | 否 | 预置 API key，逗号分隔 |
| `CF_KV_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` | 否 | Cloudflare KV 持久化 |
| `LOG_REQUESTS` | 否 | 记录每个请求 |

## 架构

```
src/server.js      Express：OpenAI 兼容路由 + admin API + 静态面板
src/credentials.js Cookie 导入、测试
src/store.js       JSON + KV 持久化、加密、轮换计数
src/googleweb.js   Gemini 网页版会话（at/bl、StreamGenerate、帧解析）
src/translate.js   OpenAI ⇄ 内部结构、SSE chunk
src/crypto.js      AES-256-GCM / scrypt / HMAC
src/logger.js      内存环形日志
public/admin/      单文件管理面板
```

## 风险与合规

- 这是非官方接口，Google 可能随时改动 `StreamGenerate` 的 payload/字段，需要跟着修。
- 对话会出现在该账号的 Gemini 历史里；Cookie 等价账号网页权限，请只导入到自己的实例。
- 请遵守 Google 服务条款；由此导致的账号限制/封禁由使用者自行承担。
