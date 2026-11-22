# 文档总览

> 目标：**照着做，从零到用 API 调通第一个回答，大约 15–25 分钟**（不含 Render 构建时间）。

## 这个项目是什么

把你**自己 Google 账号的 Gemini 网页版（以及 AI Studio）对话**，包装成本地/云端一个 **OpenAI 兼容 API**，让你可以在任意 OpenAI 客户端里用 Gemini 4 Hydrogen / Neon / Carbon 等档位。

两条通道：

- **Gemini 网页版**（`web-*`）：浏览器 Cookie 直连 `gemini.google.com`，对话会进你自己的 Gemini 网页/客户端；
- **AI Studio**（`pggo-*`）：`aistudio.google.com` 的 Cookie + 服务端 WAA 签名器，走 MakerSuite 私有 RPC，模型清单由账号实际权限决定。

它**不是**：

- ❌ 官方 Gemini API 的转发（那条路要付费 key）；
- ❌ 多人共享的公共池（只服务你自己导入的账号）；
- ❌ 支持图片输入 / 函数调用 / JSON mode 的完整 API（这两条通道本身不支持）。

## 五分钟路线图

```
Fork 仓库 → 建 Cloudflare KV（可选） → Render 建 Web Service（Docker）
   → 拿到 https://<服务名>.onrender.com 地址
   → /admin/ 登录 → 导入 Gemini / AI Studio Cookie → 建 API Key
   → 客户端填 Base URL + Key + 模型名 → 完成
```

## 按顺序读

| 文档 | 什么时候读 |
|---|---|
| [01-原理.md](./01-原理.md) | 想知道它到底怎么把「网页对话」变成 API 的；想改代码/排障 |
| [02-部署.md](./02-部署.md) | 第一次部署，或重新部署；**关于网址的疑问也在这里** |
| [03-使用.md](./03-使用.md) | 部署完成后：取两种 Cookie、建 Key、接各种客户端、开代理池 |
| [04-常见问题.md](./04-常见问题.md) | 遇到报错先查这里（Q1–Q22） |

## 快速开始（极简版）

> 详细步骤见 [02-部署.md](./02-部署.md)，这里只列顺序。

1. **Fork** 本仓库到你自己的 GitHub。
2. （推荐）Cloudflare → Workers & Pages → KV → 建 namespace；再建一个 API Token，权限 `Workers KV Storage:Edit`。
3. **Render** → New → Web Service → 连接你的 fork → Runtime 选 **Docker** → Plan 选 **Free**。
4. 填环境变量：
   - `ADMIN_PASSWORD`：你的面板密码（必填）；
   - `ENCRYPTION_KEY`：64 位随机 hex（必填，别改）；
   - 可选：`CF_KV_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`。
5. 等构建完成，打开 Render 服务页顶部那个 URL —— **注意它长这样**：

   ```
   https://rb-gate.onrender.com        ← 服务名你起的
   https://rb-gate-9x2k.onrender.com   ← 名字被占时自动加后缀
   ```

   **不是** `https://<你的Render用户名>.onrender.com`。以 Dashboard 显示为准。
6. 打开 `地址/admin/` → 用 `ADMIN_PASSWORD` 登录。
7. 「凭证」→ 粘贴 `gemini.google.com` 的 Cookie → **验证并导入**。
8. 「API Keys」→ 新建 → 复制 `sk-robin-...`。
9. 用 curl 测试：

   ```bash
   curl https://<你的地址>/v1/chat/completions \
     -H "Authorization: Bearer sk-robin-..." \
     -H "Content-Type: application/json" \
     -d '{"model":"web-gemini-4-hydrogen","messages":[{"role":"user","content":"你好"}]}'
   ```

10. 在客户端里填 Base URL `https://<你的地址>/v1`、Key、模型名，收工。

## 三个最常见的坑

| 症状 | 原因 | 去哪看 |
|---|---|---|
| `gemini page failed (302) -> .../sorry/index` | Render 出口 IP 被 Google 风控 | FAQ Q5 / 03 第 5 节（代理池） |
| `Cookie 验证失败` | 用了 `document.cookie`、或拿错站点（`aistudio`） | FAQ Q4 / 03 第 1 节 |
| 重新部署后凭证没了 | 免费层 `/data` 是临时的 | FAQ Q15 / 02 第 6 节（KV） |

## 术语

- **Cookie**：Gemini 网页版登录态，等价于账号在该站点的权限。
- **凭证（credential）**：面板里的一条 Cookie 记录，可测试/禁用/删除。
- **代理池**：服务端内置 mihomo 内核，用 Clash 订阅的多个节点出站，用来绕开 Google 的 IP 风控。
- **API Key**：给客户端用的 `sk-robin-...`，和 Google 无关。
