# 上游 API 观察清单

本项目对 `@deepseek-ai/*` 的脆弱依赖。检查 DSH 更新时先过这份清单，再做常规使用面比对。

三类条目：

| kind | 含义 | 判据字段 | 退役字段 |
| --- | --- | --- | --- |
| `replica` | 已手工复刻，怕上游改 | `check` | `retireWhen` |
| `fragile` | 在用，怕改名或改签名 | `check` | `retireWhen` |
| `blocked` | 想做，上游没开口 | `probe.upstream` + `probe.local` | `unblocksWhen` |

每条必有一个可执行判据和一个退役条件，缺一不收；条件达成就删，不留着。

## replica

### mcp-public-tool-name

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`publicToolName` —— `mcp__<server>__<raw>`，非法字符换 `_`，超 64 位截断并追加 12 位 SHA-256
- 位置：`packages/dsh-mcp-pack/src/public-name.ts:18`
- 起始版本：0.2.2-rc.1
- 为什么：宿主没导出公开名生成规则，本地按源码逐字复刻；规则一变，toolview 与命名空间会静默失准
- 判据：比对 dsh-mcp-client 公开名生成函数的前缀、字符集、长度上限与哈希长度
- 退役：上游导出该函数，或提供公开名校验入口

### mcp-server-name-pattern

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/`
- 位置：`packages/dsh-mcp-pack/src/servers.ts:7`
- 起始版本：0.2.2-rc.1
- 为什么：宿主对 `serverName` 的约束，超出即无法挂载；本地逐字复刻
- 判据：比对 dsh-mcp-client 的 `SERVER_NAME_PATTERN` 字符集与长度，并确认入口仍导出该常量
- 退役：上游把该常量移出入口后，本地复刻成为唯一来源，条目转 `fragile`；或上游提供公开名校验入口
- 备注：0.2.2-rc.3 入口已导出，但该导出登记在上游 `@deepseek-ai/dsh` 仓库的 `scripts/plugin-entry-existing-exports.ts` 债务清单里（原文 "existing debt, not an approved exception"），随时可能被清理，不能当稳定 API 依赖

### mcp-server-config-shape

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`ServerDef` 形状对齐宿主 `Config` —— stdio 的 `command`/`args`/`env`/`cwd`，streamable-http 的 `url`/`headers`；0.2.2-rc.3 起宿主另有 `startupTimeoutMs`/`closeTimeoutMs`/`expandTemplates`，0.2.2-rc.5 起另有 `failOnStartupError`/`maxInstructionBytes`/`reconnect`，本地均未复刻
- 位置：`packages/dsh-mcp-pack/src/servers.ts:10`
- 起始版本：0.2.2-rc.1
- 为什么：托管定义直接写进宿主的配置结构，字段增减不会编译报错，只会在运行时被忽略或拒绝
- 判据：比对 dsh-mcp-client 的 `StdioConfig` 与 `StreamableHttpConfig` 字段
- 退役：改为 import 宿主的 `Config` 类型校验，或宿主导出构造函数

### model-defineTool-shape

- 包：`@deepseek-ai/dsh-tools`
- 复刻对象：`defineTool` 产出的对象形状 —— `name` / `output` / `parameters`（原始 JSON Schema）
- 位置：`packages/dsh-model-pack/src/tools.ts:12`
- 起始版本：0.2.2-rc.1
- 为什么：`@deepseek-ai/dsh-tools` 不在 dsh-model-pack 的依赖里，只能手工构造同形状对象
- 判据：比对 `packages/core/tools/src/schema.ts` 中 `defineTool` 返回对象的字段与 JSON Schema 形态
- 退役：把 dsh-tools 加进依赖并改用 `defineTool`，或宿主导出构造器

### subagent-activation-spec-shape

- 包：`@deepseek-ai/dsh-subagent`
- 复刻对象：`SubagentActivationSpec` 的形状 —— `provider` / `delivery` / `prompt` / `parent` / `agentOptions` / `cwd` / `maxDepth` / `signal` 全部在 **spec 顶层**，没有 `request` 这一层；`signal` 必填
- 位置：`packages/dsh-model-pack/src/tools.ts:306`
- 起始版本：0.2.2-rc.1
- 为什么：`@deepseek-ai/dsh-subagent` 不在 dsh-model-pack 的依赖里，spec 只能以 `Record<string, unknown>` 手工构造，没有 import 宿主类型，签名比对抓不到。形状写错时 `startActivation` 在 `spec.parent.id` 处抛 `TypeError`，探测通过、启动失败，只在真正调用工具时暴露
- 判据：比对 `dsh-subagent/src/types.ts` 的 `SubagentActivationSpec` 字段集与嵌套层级，并确认 `signal` 是否仍必填
- 退役：把 `@deepseek-ai/dsh-subagent` 加进依赖并直接 import `SubagentActivationSpec` 类型，让编译器而不是测试来守这个形状

### agent-teams-is-enabled

- 包：`@deepseek-ai/dsh-agent-team`
- 复刻对象：团队开关的读取方式 —— `agentTeams.isEnabled(agent)` 读根会话投影里的 `team/mode` 事件；开关是**会话级**，不是工作区级
- 位置：`packages/dsh-model-pack/src/hooks.ts:218`
- 起始版本：0.2.2-rc.3
- 为什么：`@deepseek-ai/dsh-agent-team` 不在 dsh-model-pack 的依赖里，只能按服务名现取、按方法名现调。官方 `team:policy` 段（order 600）在团队开启时让模型用裸名 `subagent` 派成员，而本插件注册 `subagent_tier` 后会 deny 它——不读这个开关就无法只在团队开启时纠偏
- 判据：`packages/dsh-model-pack/test/hooks.test.js` 断言 `agentTeams.isEnabled` 返回 true 时 `model-pack.team` 段文本非空、返回 false 或抛错时为空串
- 退役：官方给 `systemPrompt` 段提供「按团队模式条件注入」的声明式入口，或 `team:policy` 段本身改为引用实际可用的委派工具

### team-policy-carries-claim-flow

- 包：`@deepseek-ai/dsh-tool-agent-team`
- 复刻对象：官方 `TEAM_POLICY` 文本承担任务板的**流程**（`list → get → claim with the current revision → complete`），本插件 `model-pack.team` 只补**判据**（何时建板、`write_scopes`），不重复流程
- 位置：`packages/dsh-model-pack/src/prompt.ts`（`TEAM_SECTION_TEXT`）
- 起始版本：0.2.2-rc.5
- 为什么：两段同题、进同一份 system prompt，靠「官方讲流程、本地讲判据」的分工避免第二个事实源。官方若删掉 claim/revision 流程（或把它挪进工具描述），本地判据就缺了执行步骤——模型会建板却不会推进
- 判据：`dsh-tool-agent-team/src/index.ts` 的 `TEAM_POLICY` 仍含 `claim with the current revision` 与 `complete`；`packages/dsh-model-pack/test/prompt.test.js` 断言团队段不含 `claim`
- 退役：官方把流程改由工具描述或输出 schema 承载（不再依赖段文本），或官方提供可组合的团队段扩展点

### session-resolve-services

- 包：`@deepseek-ai/dsh-agents` / `@deepseek-ai/dsh-session`（服务名 `agents` 与 `sessionQuery`）
- 复刻对象：把 `sessionId` 解析成工作目录的两条通道 —— `agents.get(id)` 返回的 Agent 本体（`session.projections.faceOf('workingDirectory')`），以及 `sessionQuery.observeSession(id)` 返回的观察体（`projections.values.workingDirectory`）。观察体只暴露 `Symbol.dispose`，没有 `.dispose()`，且必须在 `finally` 里释放
- 位置：`packages/dsh-pack-core/src/session.ts:32`
- 起始版本：0.2.2-rc.3
- 为什么：core 里第一个**主动探测宿主服务**的模块。`cwd.ts` 只吃已经拿到的对象，不探测；`session.ts` 按服务名现取、按方法名现调，形状写错时降级路径会静默失效（面板显示「未生效」而不是报错），而漏释放观察体是一条不可见的长期泄漏
- 判据：`packages/dsh-pack-core/test/session.test.js` 断言两条通道的降级顺序、`Symbol.dispose` 被调用一次、释放失败只记一条带包名的 warn
- 退役：宿主提供官方的「sessionId → 当前工作目录」解析接口，或把 `observeSession` 的释放改成显式 `dispose()` 方法

### atomic-write-lock-order

- 包：`@deepseek-ai/dsh-atomic-write`
- 复刻对象：`withFileLock` 用 `wx` 直接建 `<file>.lock`，**不建父目录**；`writeFileAtomic` 自己会 mkdir，但那是拿锁之后的事。因此父目录必须在拿锁之前建好
- 位置：`packages/dsh-pack-core/src/store.ts:93`
- 起始版本：0.2.2-rc.3
- 为什么：这是本地代码依赖上游的**未文档化行为**。上游哪天改成「父目录不存在就抛」，本地「先 mkdir 再拿锁」的顺序假设就从冗余变成必需；反过来若上游改成自己建父目录，本地那一步也不会坏——但没人会知道可以删
- 判据：比对 `dsh-atomic-write` 的 `withFileLock` 实现，确认它仍用 `wx` 建锁文件且不 mkdir 父目录
- 退役：上游在 `withFileLock` 里自己建父目录，或文档化这条顺序要求

### session-header-cwd-immutable

- 包：`@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-workspace`
- 复刻对象：会话所属工作区取 `SessionHeader.cwd`，并假设它**创建后不可变**。宿主把它声明为 `readonly`，`workspace.attachSession` 按它校验归属，注释原文：both inputs (stored header cwd, workspace path) are immutable
- 位置：`packages/dsh-pack-core/src/cwd.ts:22`
- 起始版本：0.2.2-rc.5
- 为什么：本项目的设计是「工作区由用户决定，模型无权变更」。UI 切换工作区是换到该工作区的 blank 会话或新建一个（`sessions.create({ workspaceId })` → `cwd = workspace.path`），不是改现有会话的 cwd。若上游哪天允许改 `header.cwd`，或把 UI 切换改成改现有会话，这条假设就破了——四个包的清单、绑定与开关会跟着模型的一次 `cd` 换目录
- 判据：确认 `dsh-session/src/types.ts` 的 `SessionHeader.cwd` 仍是 `readonly`，且 `dsh-workspace/src/entity.ts` 的 `attachSession` 仍按 `header.cwd === workspace.path` 校验
- 退役：宿主提供官方的「会话所属工作区」只读接口，或明确文档化 `header.cwd` 可变

### lsp-session-header-fields

- 包：`@deepseek-ai/dsh-agent`
- 复刻对象：`agent.session.header.id` 与 `agent.session.header.cwd` —— 前者当脏表键，后者当会话根
- 位置：`packages/dsh-lsp-lens/src/index.ts:109`（键）、`packages/dsh-lsp-lens/src/index.ts:99`（根）
- 起始版本：0.2.2-rc.5
- 为什么：宿主没导出「会话键」与「会话工作目录」的读取入口，插件只能按投影对象的字段名现取。字段改名时读到的都是 `undefined`，表现是脏表退化成一张全局表（串会话），不报错
- 判据：断言 `agent.session.header.id` 与 `.cwd` 存在；`sessionKeyOf` 三层回退由 `packages/dsh-lsp-lens/test/prestep.test.js` 覆盖
- 退役：宿主导出会话 id 与当前工作目录的读取入口，或 `agent/pre-step` 的 payload 直接带上两者

### lsp-fs-observed-signature

- 包：`@deepseek-ai/dsh-fs`
- 复刻对象：`fs/observed` 的监听签名 `(target, observation)` —— 只有目标与观察，**没有会话**
- 位置：`packages/dsh-lsp-lens/src/index.ts:214`
- 起始版本：0.2.2-rc.5
- 为什么：拿不到会话就只能把观测先落进程级候选池，再由 `agent/pre-step` 用当前会话根分流。宿主若给它加上会话参数，这层中转可以整个删掉
- 判据：比对 `ctx.on('fs/observed')` 的回调参数个数与含义（宿主自身的 `WorkspaceChangeFeed` 也只接两个参数）
- 退役：`fs/observed` 的监听器能拿到触发会话，届时把 `observed` 候选池改为直接按会话标脏

### lsp-fs-observed-target-fields

- 包：`@deepseek-ai/dsh-fs`
- 复刻对象：`fs/observed` 回调里 `target.displayPath`（回退 `target.targetKey`）是**绝对路径**
- 位置：`packages/dsh-lsp-lens/src/index.ts:219`
- 起始版本：0.2.2-rc.5
- 为什么：拿不到会话，只能靠这个字段拼可达性判定。字段改名、或改成相对会话根的路径时，观测来源会静默失效——不报错，只是少一个发现渠道，表现为「改了文件但没回灌」
- 判据：开 `LSP_LENS_DEBUG`，读一个受支持文件后看候选池是否收到该路径
- 退役：宿主把这个字段写进类型声明并导出，本地改为直接引用

## blocked

当前无条目。
