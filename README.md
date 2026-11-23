# robin-gateway

把 **Gemini 网页版会话**包装成 **OpenAI 兼容 API** 的自托管网关。带管理面板、多账号轮换、Clash 代理池，可一键部署到 Render。

- 15 个网页版模型：5 个档位 × 三档思维强度（low / medium / high），强度直接写在模型名里，如 `web-gemini-4-neon-high`
- 用你自己的 Google 账号，**不需要** Gemini API Key
- 一个二进制/一个容器，无数据库
- 有手就行 → **[保姆级部署文档](docs/02-部署.md)**

> ⚠️ 非官方接口。Google 的服务条款不欢迎把网页版会话当 API 用，存在账号被限制/封禁的风险。只建议个人自用，详见[风险](#风险与合规)。

---

## 它是什么，不是什么

**是**：把 `gemini.google.com` 的对话框流量翻译成 `POST /v1/chat/completions`，于是任何 OpenAI 客户端都能用 Gemini 4 的网页版档位。

**不是**：

- 官方 Gemini API 的转发（那条路要付费 key，且受支持模型不同）；
- 公共池 / 共享账号服务（只服务你自己导入的账号）；
- 全功能 API——网页版**不支持**图片输入、函数调用、JSON mode，所以这里也没有；
- 网页版**没有 4 Argon**。需要 Argon 请走官方 API 付费层（`gemini-4-argon`）。

---

## 原理（一图流）

```
你的浏览器
  │ 登录 gemini.google.com，复制 Cookie（含 SID / SAPISID …）
  ▼
robin-gateway（Render / 本地）
  │ Cookie 用 AES-256-GCM 加密存盘 / Cloudflare KV
  │
  ├─ GoogleWebSession
  │    GET  gemini.google.com/app      → 拿 at / bl（缓存 30 分钟）
  │    POST …/BardFrontendService/StreamGenerate
  │         f.req = [[null, JSON(inner[102])]]
  │         inner[0]  = 提示词
  │         inner[17] = 思考等级（think）
  │         inner[41] = 历史模式（2 持久 / 1 临时）
  │         inner[79] = mode → 决定模型档位
  │         inner[80] = 思维强度 1=低 2=中 3=高（不传用默认）
  │            1=Hydrogen  2=Neon  3=Carbon  4=Auto  6=Flash-Lite
  │         ← SSE 帧流 → 解析出增量文本
  │
  ├─ 代理池（可选）：mihomo 内核 + Clash 订阅节点
  │    命中 /sorry 验证页 → 自动换节点重试
  │
  └─ 多凭证：按「最久未用」轮换；429/失效自动冷却
  ▼
OpenAI 兼容响应（流式 / 非流式）
```

更细的字段表、为什么需要 `at`/`bl`、`maxHeaderSize` 坑、帧解析规则，都在 **[docs/01-原理.md](docs/01-原理.md)**。

---

## 快速开始

完整步骤（含截图级的操作说明）在 **[docs/02-部署.md](docs/02-部署.md)**。最短路径：

1. Fork 本仓库。
2. （推荐）建 Cloudflare KV，拿到 Account ID / Namespace ID / 一个 `Workers KV Storage:Edit` 的 Token。
3. Render → New Web Service → 连你的 fork → **Docker** → **Free**。
4. 环境变量：

   | 变量 | 值 |
   |---|---|
   | `ADMIN_PASSWORD` | 你的面板密码 |
   | `ENCRYPTION_KEY` | 64 位随机 hex，**填了就别改** |
   | `CF_KV_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` | 可选，但免费层强烈建议 |

5. 构建完成后打开 Render 给的地址 → `地址/admin/` → 登录。
6. 「凭证」→ 粘贴 `gemini.google.com` 的 Cookie → 验证并导入。
7. 「API Keys」→ 新建 → 复制 `sk-robin-...`。
8. 客户端 Base URL 填 `https://<你的地址>/v1`。

---

## ⚠️ 关于 Render 网址（重要）

Render 生成的域名**不包含**你的 Render 用户名，规则是：

```
https://<service-name>.onrender.com
```

- `<service-name>` = 你创建服务时填的 **Name**，默认取仓库名；
- 如果名字被占用，Render 会**自动加随机后缀**（如 `rb-gate-9x2k.onrender.com`）；
- **不存在** `https://<用户名>.onrender.com` 这种格式；
- 唯一可靠的地址来源：<https://dashboard.render.com> → 你的服务 → 顶部 URL。

因此：

| 用途 | 地址 |
|---|---|
| 管理面板 | `https://<实际地址>/admin/`（末尾斜杠） |
| OpenAI Base URL | `https://<实际地址>/v1` |
| 健康检查 | `https://<实际地址>/health` |

改名或绑自定义域名的后果：旧地址立即失效、所有客户端要改 Base URL、浏览器登录 Cookie 不跨域名（需重新登录），数据不受影响。详见 [FAQ Q1/Q2](docs/04-常见问题.md)。

---

## 模型

`GET /v1/models` 返回 15 个网页版模型：5 个上游档位 × 三档思维强度。强度直接写在模型名末尾，客户端在选模型时就确定了强度，不需要额外参数：

| 网页端档位 | low | medium | high | 最低账号档位 | 适合 |
|---|---|---|---|---|---|
| 4 Hydrogen | `web-gemini-4-hydrogen-low` | `web-gemini-4-hydrogen-medium` | `web-gemini-4-hydrogen-high` | Free | 日常问答，快 |
| 4 Neon | `web-gemini-4-neon-low` | `web-gemini-4-neon-medium` | `web-gemini-4-neon-high` | Pro | 深度分析 |
| 4 Carbon | `web-gemini-4-carbon-low` | `web-gemini-4-carbon-medium` | `web-gemini-4-carbon-high` | Ultra | 代码 / 复杂任务 |
| 自动 | `web-gemini-4-auto-low` | `web-gemini-4-auto-medium` | `web-gemini-4-auto-high` | Free | 让 Google 选 |
| Flash-Lite | `web-gemini-4-flash-lite-low` | `web-gemini-4-flash-lite-medium` | `web-gemini-4-flash-lite-high` | Free | 极快、简单任务 |

- `metadata.thinking_level` 是这个模型的强度（`low` / `medium` / `high`），`metadata.thinking_levels` 仍返回三档全集，兼容旧客户端。
- 不带强度的旧 ID（如 `web-gemini-4-neon`）仍然可用，等价于「不指定强度、由 Google 用默认值」，但不在这 15 个里列出。
- `metadata.required_tier` 是最低账号档位，方便客户端自己判断。

### 思维强度

| 强度 | 行为 | 适合 |
|---|---|---|
| `low` | 想得最少、最快 | 事实问答、改写、翻译 |
| `medium` | 折中 | 一般推理、长文 |
| `high` | 想得最深、最慢，输出 token 也最多 | 难题、代码、数学 |

选模型就是选强度：

```json
{"model": "web-gemini-4-neon-high", "messages": [{"role": "user", "content": "..."}]}
```

如果客户端能发请求字段，也兼容 `reasoning_effort` / `reasoning.effort` 和 Claude 风格的 `thinking.budget_tokens`，以及 `web-gemini-4-neon@think=high` 后缀。优先级：`@think` 后缀 > 请求字段 > 模型名里的强度。详见 [docs/03-使用.md](docs/03-使用.md#思维强度low--medium--high)。

网页端没有公开的模型列表接口，所谓“动态读取”是**面板逐个档位发 ping**：

- 面板「模型」→ **动态探测**（约 10–20 秒）；
- 结果写进 `/v1/models` 的 `metadata.available` / `latency_ms` / `checked_at`。

面板还会自动检测每个账号的**档位与额度**（5 小时窗口 / 7 天窗口，见「凭证 → 额度」）：

- 档位来自 Google 网页端的 `subscriptionTier`（TIER0=Plus、TIER1=Pro、TIER2=Ultra）；
- 5h / 7d 剩余百分比来自网页端用量接口，聊天成功后每 10 分钟自动刷新；
- 某个账号额度耗尽会自动跳过，优先用还有额度的；全耗尽才回退。

旧 ID（`web-gemini-3.7-flash` 等）已删除，用旧名会 404。

### AI Studio 通道（`pggo-*`）

再导入一条 **`aistudio.google.com`** 的 Cookie（同一张面板、邮箱可选），`/v1/models` 会额外列出该账号在 AI Studio 里真实可用的模型：

| 模型 ID（示例） | 上游 | 最低档位 |
|---|---|---|
| `pggo-gemini-4-neon` | `models/gemini-4-neon` | Pro |
| `pggo-gemini-4-carbon` | `models/gemini-4-carbon` | Ultra |
| `pggo-gemini-4-hydrogen` | `models/gemini-4-hydrogen` | Free |
| `pggo-gemini-3.6-flash` | `models/gemini-3.6-flash` | Free |
| `pggo-gemini-3.1-pro-preview` | `models/gemini-3.1-pro-preview` | Pro |

- 导入时服务端会调 `ListModels` + `GetAiStudioBenefitTier` 校验 Cookie，并读取账号档位（Free/Pro/Ultra）；模型清单以该账号的实际目录为准，不是写死的。
- 上游是 AI Studio 的 MakerSuite 私有 RPC，需要容器里的 WAA（BotGuard）签名器：Docker 镜像自动带上（`WAA_SIGNER_PATH`），本地跑要指向 `waa-signer` 二进制。
- 网页版与 AI Studio 的档位/额度互不相干；4 Argon 这类付费模型仍可能返回 `503 high demand`，以 AI Studio 页面为准。
- 第一次调用要冷启动签名器（约 5–10 秒），再叠加模型思考时间，单次可能要 30–100 秒；之后热启动快得多。慢模型建议 `stream: true`，否则 Render 代理会在约 100 秒静默后断开。

---

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`；支持 system、多轮、`stream_options.include_usage`。
- **两条通道**：Gemini 网页版（`web-*`，Cookie 直连）+ AI Studio（`pggo-*`，邮箱 + Cookie + 服务端 WAA 签名）。
- **多凭证轮换**：Cookie 导入前验证；按最久未用优先；失败自动冷却并换号。
- **动态模型探测**：确认此刻哪个档位真正可用。
- **档位 / 额度自动检测**：Pro / Ultra / Plus / Free、5h 与 7d 剩余额度、模型所需档位；额度耗尽的账号自动跳过。
- **Clash 代理池**：内置 mihomo 内核，导入订阅后节点进入「默认分组」，可删除全部或单个节点；停止仅停止使用代理池 VPN，分组和订阅保留，可随时重新启用；自动跳过订阅里的“剩余流量/官网/时间戳”横幅节点；测速、每 10 分钟自动切最快；命中 `/sorry` 自动换节点重试。
- **管理面板**：凭证、API Keys、模型、日志、密码、代理池；桌面宽屏（1440px 双栏）与手机自适应。
- **零数据库**：JSON + 原子写；Cookie AES-256-GCM 加密；admin 密码 scrypt。
- **Cloudflare KV 持久化**：免费层重启不丢数据（可选）。

---

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `8787` | Render 会自动注入 |
| `DATA_DIR` | 否 | `./data` | Render 上建议 `/data` |
| `ADMIN_PASSWORD` | 推荐 | 随机生成并打印 | 设置后无法在面板内修改 |
| `ENCRYPTION_KEY` | PaaS 必填 | 本地 key 文件 | 加密 Cookie；**必须固定** |
| `SESSION_SECRET` | 否 | 由 `ENCRYPTION_KEY` 派生 | 面板会话签名 |
| `GATEWAY_API_KEYS` | 否 | — | 预置 key，逗号分隔（不落库） |
| `CF_KV_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` | 否 | — | 三项齐全才启用 KV |
| `CF_KV_BASE_URL` | 否 | `https://api.cloudflare.com` | 调试用 |
| `WEB_PROXY` | 否 | — | 单代理（`http://host:port`），优先于 `/sorry` 兜底 |
| `MIHOMO_PATH` | 否 | `/usr/local/bin/mihomo` | 代理池内核 |
| `WAA_SIGNER_PATH` | 否 | 镜像内 `/usr/local/bin/waa-signer` | AI Studio 通道的 WAA 签名器 |
| `WAA_DISABLED` | 否 | — | `1` 关闭 AI Studio 通道 |
| `AI_STUDIO_TIER` | 否 | `TIER1` | 未检测到档位时使用的 G1 头（Pro=TIER1, Ultra=TIER2, Plus=TIER0） |
| `PROXY_PORT` | 否 | `7891` | 本地 mixed 端口 |
| `PROXY_CONTROLLER_PORT` | 否 | `9090` | 仅监听 127.0.0.1 |
| `AUTO_FASTEST` | 否 | 开 | `0` 关闭自动切最快节点 |
| `AUTO_FASTEST_MS` | 否 | `600000` | 自动测速间隔 |
| `LOG_REQUESTS` | 否 | — | 记录每个请求 |

---

## API

公开（`/health`、`/v1/models` 免鉴权；聊天需 `Authorization: Bearer sk-robin-...`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 模型列表（含 `metadata`） |
| GET | `/v1/models/:id` | 单个模型 |
| POST | `/v1/chat/completions` | 聊天（流式/非流式） |

管理（需登录 Cookie 或 `X-Admin-Password`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/api/login` / `logout` | 登录 / 退出 |
| GET | `/admin/api/overview` | 概览（凭证、模型、代理、统计） |
| GET/POST | `/admin/api/keys`，DELETE `/keys/:id` | API Key 管理 |
| POST | `/admin/api/credentials/import-web-cookie` | 导入 Gemini Cookie |
| POST | `/admin/api/web/probe` | 单 Cookie 探测 |
| POST | `/admin/api/credentials/:id/test`，PATCH/DELETE `:id` | 测试 / 启停 / 删除 |
| GET | `/admin/api/web/models`，POST `web/models/probe` | 动态模型探测 |
| GET/POST | `/admin/api/proxy`，`proxy/import` `proxy/start` `proxy/select` `proxy/rotate` `proxy/test-all` `proxy/remove` `proxy/remove-all` `proxy/stop` | 代理池；`stop` 仅暂停使用并保留默认分组 |
| GET | `/admin/api/logs` | 最近日志 |
| POST | `/admin/api/password` | 改密码（`ADMIN_PASSWORD` 已设置时拒绝） |

---

## 本地运行

```bash
cd robin-gateway
npm install
ADMIN_PASSWORD=your-password npm start
# http://localhost:8787/admin/
```

数据在 `DATA_DIR`（默认 `./data`）。首次未设 `ADMIN_PASSWORD` 时会打印随机密码。

代理池要本地试的话，需要 `MIHOMO_PATH` 指向可执行的 mihomo；Docker 镜像已内置。

---

## 架构

```
src/server.js      Express：OpenAI 路由 + admin API + 静态面板
src/googleweb.js   Gemini 网页版会话（at/bl、StreamGenerate、帧解析、动态探测）
src/proxypool.js   mihomo 内核管理、Clash 订阅解析、测速/删除/自动切最快
src/proxyroute.js  出站代理选择
src/credentials.js Cookie 导入与测试
src/store.js       JSON + KV 持久化、加密、统计
src/translate.js   OpenAI ⇄ 内部结构、SSE chunk
src/crypto.js      AES-256-GCM / scrypt / HMAC
src/logger.js      内存环形日志
public/admin/      单文件管理面板
docs/              保姆级文档
```

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/README.md](docs/README.md) | 总览 + 5 分钟快速开始 |
| [docs/01-原理.md](docs/01-原理.md) | 协议细节、字段表、为什么这么做 |
| [docs/02-部署.md](docs/02-部署.md) | Fork → KV → Render → 首次登录 → 验证（含网址说明） |
| [docs/03-使用.md](docs/03-使用.md) | 取 Cookie、模型、API Key、客户端、代理池 |
| [docs/04-常见问题.md](docs/04-常见问题.md) | 22 个常见报错与处置 |

---

## 风险与合规

- 这是**非官方接口**，Google 随时可能改动 `StreamGenerate` 的字段/签名，需要跟着修。
- 对话会出现在该账号的 Gemini 历史里；Cookie 等价账号网页权限，**只导入到你自己的实例**。
- 请遵守 Google 服务条款。由此导致的账号限制/封禁由使用者自行承担。
- 不要把实例公开给陌生人用，也不要做商业转售。
