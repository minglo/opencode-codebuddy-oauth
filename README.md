# opencode-codebuddy-oauth

> 致谢：本插件基于 [HunkYuan/opencode-codebuddy-plugin](https://github.com/HunkYuan/opencode-codebuddy-plugin) 的灵感修改而来，感谢原作者的设计思路与贡献。

为 [CodeBuddy](https://www.codebuddy.cn)（即 **IOA**，腾讯编程助手）提供 OpenCode 插件，将 CodeBuddy 作为已认证 provider 接入 OpenCode。

支持 **两种鉴权模式**：

- **OAuth** — 走 IOA `/v2/plugin/auth/state` → 浏览器 → 轮询拿 token 流程。
- **API Key** — 直接粘贴在 CodeBuddy 官网生成的 `ck_xxx` Key，模型通过 `opencode.json` 配置。

---

## 安装

本插件**开箱即用** — 自动创建 `codebuddy` provider、提供 OAuth 登录入口、自动发现模型。支持以下安装方式：

> **版本要求**：`3.x` 仅支持 **OpenCode V2**（插件 API `@opencode/plugin`，对应 opencode `2.0.4+`）。
> OpenCode V1 用户请使用 **`2.2.0`**（V1 线最终版本，`npm install opencode-codebuddy-oauth@2`）；`2.x` 不再新增功能，仅作兼容保留。

### 方式 1 — npm 包（推荐）

在项目（或全局 `~/.config/opencode/opencode.json`）的 `plugins` 数组中声明：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-codebuddy-oauth"]
}
```

### 方式 2 — 本地目录（无需发布到 npm）

`plugins` 支持目录形式，但**目录内必须有 `index.js` 入口**（OpenCode V2 不读取 `main` 字段来解析目录形式的插件）。本仓库根目录已提供 `index.js`，因此可以直接指向仓库（或 `dist/` 所在目录）：

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-codebuddy-oauth"]
}
```

`npm run build` 之后新 `dist/index.js` 在 OpenCode 下次启动时自动生效（`index.js` 仅 re-export `./dist/index.js`）。

## 命令行认证

OAuth 流程可以完全在 TUI 内完成：

1. 运行 `/connect codebuddy`，选择 **IOA 登录 (浏览器)**。
2. 终端会输出 `url` 与 `instructions`（"请在浏览器中完成 IOA 登录"）——在**任意**浏览器中打开该 URL，完成 IOA 登录。
3. 插件随即轮询 `GET /v2/plugin/auth/token?state=<state>`（3 秒间隔、10 分钟超时），拿到 token 后由 OpenCode 核心凭证系统保存，认证完成。

对应源码：`src/integration.ts` 的 `authorize`（申请 `state`）与 `src/auth-flow.ts` 的 `pollForToken`（轮询拿 token）。

---

## 特性

- **OAuth 登录** — 直接在编辑器内走 IOA 流程：`/v2/plugin/auth/state` → 浏览器 → 轮询拿 token。
- **API Key 登录** — 在 `/connect codebuddy` 处粘贴 `ck_xxx` Key；无需浏览器、不轮询、不刷新。
- **自动模型发现** — OAuth 模式启动时调用 `GET /v3/config`（5 秒超时），提取 craft agent 的模型列表并注册为 provider 模型（5 分钟 TTL 缓存 + 并发单飞去重，401/403 不重新登录前不缓存）；API Key 模式下模型回退内置 `auto`。
- **401/403 自动刷新 token** — 凭证由 OpenCode 核心 `integration` 管理；插件注册 `refresh` 回调调 `/v2/plugin/auth/token/refresh` 拿新 token，核心负责刷新调度、并发去重与重试（`src/integration.ts`）。
- **瞬时 400（code 11133）自动重试** — CodeBuddy 网关偶发把上游厂商的瞬时校验失败包装成 HTTP 400 `{"code":11133,"msg":"Invalid request parameters"}` 返回（实测为服务端侧故障窗口，同构请求稍后重发即成功）。`http.response` hook 识别到该错误时按 **1s → 4s → 10s → 25s** 退避幂等重发（最多 4 次额外尝试，总等待 ≤40s），把偶发故障对对话的影响从「回合中断」降级为「无感重试」；其他 400（如 11101 参数解析错误）不受影响、原样透传。
- **模型兼容** — `compatibility.requireReasoning` 让核心为历史 `assistant` 消息补 `reasoning_content`（code 11155 兜底：带 `tools` 请求要求回传该字段，上游可跳过推理导致 400）；`variants` **直通上游 `supportedEfforts`**（实测组合为 `low/high/xhigh/max`，UI 档位与上游档位一一对应，不再归一）。
- **SSE 缓冲** — 流式响应按阈值/换行/标点/最大延迟合并分块输出，降低 UI 渲染频率；`reasoning_content` 与 `content` 混排保留。
- **session 级 `X-Conversation-ID` 稳定化** — 同一个 OpenCode session 内所有请求复用同一 UUID，跨 turn、跨 tool call 一致，提升上游 prompt cache 命中率（`session.compacted` / `session.deleted` 时清掉 LRU 条目）。
- **环境自动切换** — 同一份插件同时支持 `copilot.tencent.com`（国内版，默认）和 `www.codebuddy.ai`（国际版）；可通过 `CODEBUDDY_NETWORK` 切换，或直接用 `CODEBUDDY_ENDPOINT` 覆盖完整 URL。

---

## 架构

插件通过 `Plugin.define({ id: "codebuddy", setup })` 注册（OpenCode V2 插件 API），分为 3 个域 + 共享状态：

| 注册点 | 作用 |
| ---- | ---- |
| `ctx.integration.transform` | 注册 3 种登录方式：IOA OAuth（`authorize` + `refresh`）、API Key、环境变量 `CODEBUDDY_API_KEY`。 |
| `ctx.provider.transform` / `ctx.model.transform` | 注入 `codebuddy` provider（如缺失）与模型定义；OAuth 模式下用 `/v3/config` 发现结果填充，凭证事件与 TTL 定时器触发 `provider.reload()`。 |
| `ctx.session.hook("http.request")` | 注入认证头（`Authorization` / `X-Tenant-Id` / `X-User-Id` 等）与非认证头（`X-Conversation-ID`、B3、`X-Model-ID` 等 22 项），处理 body（`stream_options`、`reasoning_content` 兜底），缓存请求快照。 |
| `ctx.session.hook("http.response")` | SSE 缓冲；400 + `code 11133` 时用快照退避重发。 |
| `ctx.session.hook("retry")` | 观测日志（决策归核心）。 |
| `ctx.event.subscribe` | 监听 `session.compacted` / `session.deleted` 淘汰 conversationId；监听 `credential.switched` / `credential.updated` 触发模型刷新。 |

请求流：

```
OpenCode 收集用户输入
  │
  ▼  核心解析 provider（integrationID=codebuddy）并解析凭证
  │
  ▼  ctx.session.hook("http.request")
注入 Authorization / X-Tenant-Id / X-User-Id / X-Enterprise-Id 与
X-Conversation-ID / B3 / X-Model-ID 等非认证头；
body 注入 stream_options、补 reasoning_content；缓存请求快照
  │
  ▼  上游 CodeBuddy API（POST ${serverUrl}/v2/chat/completions）
  │
  ▼  ctx.session.hook("http.response")
400 + 11133（上游瞬时故障）→ 按 1s→4s→10s→25s 用快照幂等重发；
SSE 流式响应经缓冲器输出
```

---

## 环境变量

所有变量**只在插件加载时读一次**（`getConfig()` 调用时），运行时改 env 不会生效。

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 完整 base URL 覆盖（例如 `https://example.com`），**优先级最高**，跳过 `CODEBUDDY_NETWORK` 与 baseURL 判断。 |
| `CODEBUDDY_NETWORK` | `internal` | `internal` / `ioa` → 国内端点（`copilot.tencent.com` + `X-Domain: www.codebuddy.cn`）；其他值（含 `internet`）→ 国际（`www.codebuddy.ai`）。 |
| `CODEBUDDY_AUTH` | `auto` | `auto`（按 OpenCode 中当前选中的凭证自动选择）、`oauth`（强制 OAuth）、`api`（强制 API Key）。（注：V2 下凭证选择主要由 OpenCode 集成连接决定，此变量为兼容保留。） |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求使用的 model（写进 `X-Model-ID`）。 |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | 设为 `0` 降级为 per-request UUID（关闭 session 级 conversation-id 稳定化）。 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 的最大容量；`0` 时退化为仅保留最近一个 session。 |
| `CODEBUDDY_SSE` | `1` | 设为 `0` 禁用 SSE 缓冲（响应原样透传）。 |
| `CODEBUDDY_SSE_THRESHOLD` | `24` | SSE 缓冲字节阈值，达到即 flush；`0` 等价逐 delta 冲。 |
| `CODEBUDDY_SSE_DELAY_MS` | `40` | SSE 缓冲最大延迟（毫秒），到达即定时 flush。 |
| `CODEBUDDY_TENANT_ID` | _(从 JWT 提)_ | 覆盖从 JWT `iss` / `tenant_id` 自动提取的 tenant。仅 OAuth 模式。 |
| `CODEBUDDY_ENTERPRISE_ID` | _(从 JWT 提)_ | 覆盖从 JWT roles 自动提取的 enterprise。仅 OAuth 模式。 |
| `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖从 JWT `sub` / `user_id` 自动提取的 user。仅 OAuth 模式。 |
| `CODEBUDDY_API_KEY` | _(空)_ | CodeBuddy API Key（`ck_xxx`），可直接作为环境变量凭证（集成注册的 `env` 方法）。 |

### 地址优先级链

```
CODEBUDDY_ENDPOINT  >  CODEBUDDY_NETWORK  >  provider.codebuddy.options.baseURL  >  默认（internal）
```

1. **`CODEBUDDY_ENDPOINT`** 设置 → 直接使用（最高优先级）。
2. **`CODEBUDDY_NETWORK`** 决定国内 / 国际端点。
3. **`provider.codebuddy.options.baseURL`**（opencode.json 配置）→ 仅当 `CODEBUDDY_ENDPOINT` **未设置**时生效，可覆盖 `CODEBUDDY_NETWORK` 的结果。
4. 否则默认国内端点 `https://copilot.tencent.com`。

---

## API Key 模式

`/connect codebuddy` 提供两个选项：

1. **IOA 登录 (浏览器)** — 原始 OAuth 流程。
2. **API Key** — 粘贴 `ck_xxx` Key（由 OpenCode 核心凭证系统保存）。

也可以直接设置 `CODEBUDDY_API_KEY` 环境变量（作为集成注册的 `env` 方法），完全不需要走 `/connect` 流程。

API Key 模式下发的请求头：

- `Authorization: Bearer <key>`
- `X-API-Key: <key>`

**不发送** `X-Tenant-Id` / `X-Enterprise-Id` / `X-User-Id`（没有 JWT 可解）。

API Key 模式下**不会**自动发现模型（`/v3/config` 接口在 API Key 认证下不返回模型列表），模型回退内置 `auto`。

典型 `.env`：

```env
CODEBUDDY_API_KEY=ck_xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CODEBUDDY_NETWORK=internal
```

---

## 自动模型发现（OAuth 模式）

OAuth 模式下，插件加载时会调用 `GET ${serverUrl}/v3/config`（5 秒超时，`DISCOVERY_TIMEOUT_MS`），从响应的 `data.agents[]` 中寻找 `name === "craft"`（`AGENT_INTENT` 常量）的 craft agent，取其 `models[]` 模型 id 列表，逐个通过 `remoteModelToInfo()`（`src/provider.ts`）把 CodeBuddy 的 `RemoteModel` 转换为 `Model.Info`。

`RemoteModel` 字段（`src/models.ts`）：

| 字段 | 转换结果 |
| ---- | ---- |
| `id` / `name` | `id` / `modelID` / `name` |
| `maxInputTokens` / `maxOutputTokens` / `maxAllowedSize` | `limit.context`（优先取 `maxAllowedSize`）/ `limit.output` |
| `supportsToolCall` | `capabilities.tools` |
| `supportsImages` + `disabledMultimodal` | `capabilities.input` 是否含 `image` |
| `supportsReasoning` | `compatibility.reasoningField = "reasoning_content"` + `requireReasoning` |
| `reasoning.effort` / `defaultEffort` | `settings.reasoningEffort`（provider 默认档） |
| `reasoning.supportedEfforts` | `variants`（**直通上游档位**，见下） |

### variants 直通（3.0.0 起）

`buildVariants()` 直接按 `supportedEfforts` 原样生成 `variants`，不再归一。实测 codebuddy `/v3/config` 返回的档位组合（2026-09）：

| 模型 | `supportedEfforts` | UI 可见档位 |
| ---- | ---- | ---- |
| `deepseek-v4-pro` | `low/high/xhigh` | 三档 |
| `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash` | `low/high/max` | 三档 |
| `glm-5.2` | `high/xhigh` | 两档 |
| `hy3`、`hy3-x` | `low/high` | 两档 |
| `hy4-preview` | `high` | 单档 |
| `auto`、`glm-5.1`、`kimi-*`、`minimax-m3` | 无 `supportedEfforts` | 无档位（用 `reasoning.effort` 默认值） |

> **旧版归一的副作用**：`2.x` 把 UI 键固定为 `low/medium/high/max`，`medium` 恒映射到 `high`、`xhigh` 被折叠为 `max`——UI 会显示上游并不存在的 `medium` 档。3.0.0 起只显示上游真实档位。

### 缓存与降级

- 结果缓存 **5 分钟 TTL**（`DISCOVERY_CACHE_TTL_MS`），且**并发单飞**——同一时刻多个请求共享同一次抓取。
- **401/403 不缓存**：原样抛出并提示重新登录（token 可能已过期）。
- 发现失败（网络/5xx）或返回空时，回退内置 **`auto`** 模型（168k context / 32k output / `tool_call`）。
- 凭证切换（`credential.switched` / `credential.updated`）与 TTL 到期触发重新发现，仅当模型列表变化时才 `provider.reload()`。

**API Key 模式不执行发现**，模型回退内置 `auto`。

---

## SSE 缓冲

CodeBuddy 上游在打开推理模式后，会把 `reasoning_content` 切成大量小分块推送（旧版未做处理直接透传时，UI 出现严重的推理内容片断化——一两字一闪、频繁刷新）。`src/sse-buffer.ts` 的 `createSSEBufferedStream` 用 `TransformStream` 按行解析 SSE 分块，把 `reasoning_content` 与 `content` 各自攒入独立缓冲，满足以下任一条件才 flush：

| 触发条件 | 说明 |
| ---- | ---- |
| 字节阈值 | `CODEBUDDY_SSE_THRESHOLD`，默认 `24` 字节 |
| 标点 / 换行 | 正则 `/。！？.!?；;，,：:$/` 或 `\n` |
| 最大延迟 | `CODEBUDDY_SSE_DELAY_MS`，默认 `40ms` 定时 flush |

细节行为：

- **切换字段时强制冲刷**另一缓冲（如 reasoning → content 的过渡点）。
- `[DONE]` / 非 JSON 行 / 工具调用等**旁路原样透传**，不进入缓冲。
- 两字段**混排顺序保留**——先 reasoning 后 content，互不吞并。
- 效果：推理过程在界面流畅整段显示，不再碎片闪烁。

`CODEBUDDY_SSE=0` 可完全禁用缓冲（响应原样透传）。

---

## 缓存行为

OpenCode 每个 turn 都会把完整 message history 重发到 `/chat/completions`，客户端侧 prefix 天然稳定。插件在此之上加了一层 **session 级 conversation-id 稳定化**：

- `LRUMap<sessionID, conversationId>` 存储每个 OpenCode session 第一次请求时生成的 UUID。
- 同 session 内所有请求复用同一 `X-Conversation-ID`（跨 turn、跨 tool call）。
- 触发 `session.compacted` 或 `session.deleted` 时淘汰对应条目。
- LRU 容量由 `CODEBUDDY_CONVERSATION_MAP_MAX` 控制（默认 `1000`；`0` 退化为仅保留最近一个 session）。
- 设为 `CODEBUDDY_STABLE_CONVERSATION=0` 可关闭稳定化，降级为 per-request UUID。

缓存本身存放在上游，本插件不持久化任何模型输出。

---

## Token 存储

- 凭证由 **OpenCode 核心**管理（`~/.local/share/opencode/auth.json` 的 `codebuddy` 键，Linux；`%APPDATA%\opencode\auth.json` Windows；`~/Library/Application Support/opencode/auth.json` macOS）。插件不再直接读写该文件。
- OAuth 模式：集成注册 `refresh` 回调，核心在 token 即将过期或收到 401/403 时自动调用并写回新凭证；刷新调度、并发去重均由核心负责。
- API Key 模式：key 由核心凭证系统存储，**不刷新**（需要在 CodeBuddy 官网手动重新生成）。环境变量 `CODEBUDDY_API_KEY` 作为集成注册的 `env` 方法，无需存储即可使用。

---

## 构建与开发

```bash
npm install
npm run build        # tsup → dist/（ESM + d.ts + sourcemap）
npm test             # vitest 全套
```

`prepublishOnly` 会先跑 `npm test && npm run build`，发布前无需额外步骤。`npm pack` 产物包含 `dist/` + `index.js` + `README.md` + `LICENSE` + `package.json`（`files: ["dist", "index.js"]` 白名单；`index.js` 是目录形式插件的入口，必须随包发布）。

本地开发：`plugins` 指向仓库目录即可，改完 `npm run build` 后重启 OpenCode 生效。

### 目录结构

```
.
├── index.js            # 目录形式插件入口（re-export ./dist/index.js，OpenCode V2 要求）
├── src/
│   ├── index.ts        # V2 入口：Plugin.define({ id: "codebuddy", setup }) + 域注册错误隔离
│   ├── config.ts       # env 解析 + 地址优先级链
│   ├── integration.ts  # integration transform：IOA OAuth / API Key / env 三种登录
│   ├── provider.ts     # provider/model transform + 模型发现与刷新 + remoteModelToInfo
│   ├── requests.ts     # http.request / http.response / retry / 事件订阅
│   ├── credentials.ts  # 凭证解析（requests 与 provider 共用）
│   ├── state.ts        # setup 闭包共享状态
│   ├── auth-flow.ts    # state 请求 / token 轮询 / 刷新
│   ├── models.ts       # /v3/config 发现 + DiscoveryCache + buildVariants
│   ├── headers.ts      # X-Conversation-ID / B3 / X-Model-ID 等 22 头
│   ├── sse-buffer.ts   # 流缓冲（reasoning/content 合并 flush）
│   ├── jwt.ts          # JWT 解码与身份提取
│   ├── lru.ts          # LRUMap
│   ├── fetch-json.ts   # 带超时的 JSON fetch
│   └── log.ts          # 日志
├── test/               # vitest 用例（镜像源文件）
├── dist/               # 编译产物（已 gitignore）
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

> `3.0.0` 已删除 V1 遗留模块（`index.v1.ts` / `auth-fetch.ts` / `auth-state.ts`）及其测试与 `RefreshLock`、`getAuthJsonPath`、`remoteModelToConfig`、`mergeModelEntry` 等符号。V1 支持已冻结在 `2.2.0`。

---

## 许可证

[MIT](./LICENSE) — © 2026 Ming Lo。
