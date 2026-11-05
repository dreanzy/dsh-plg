# dsh-mcp-manager 规格

状态：设计已冻结（2026-11-05）。来源：与用户逐条确认 Q1–Q15；调研见 `research/community-and-host.md` 与 `research/repo-patterns.md`。

## 1 目标与边界

**做**：按工作区控制 MCP server 的可见性与加载方式，提供三种加载模式、工具过滤与名册面板。

**不做**：
- 不做 MCP 的唯一入口。用户已有的 server 定义（`mcp.cordis.yml` 及其 include）只读展示。
- 不管理预设平面的 MCP 行（只读展示，不增删改）。
- 不做 `mcp_search`、不做工具目录的 SQLite 持久化、不做 Claude 配置导入。
- 不做 server 定义的导入/导出、不做跨机器同步。

**与 dsh-plugin-manager 的分工**：那个管「包装贡献的工具与提示词段」，这个管「外接的工具」。两者不共享代码（仓库 ADR-0001 的零共享）。

## 2 术语

**行（Row）**：一台 MCP server 的配置声明，来源是组合里 `@deepseek-ai/dsh-mcp-client` 的 entry。行键 = `<来源>:<serverName>`。

**加载模式（Mode）**：`eager` / `dynamic` / `lazy` 三档之一，决定「什么时候连接」与「工具怎么进上下文」。模式与载体绑定，不做正交组合。

**载体（Carrier）**：模式的实现形态。`eager` 无载体（由宿主 `mcp-client` 挂载）；`dynamic` 用 `native`（原生注册工具定义）；`lazy` 用 `proxy`（不注册工具，经 `mcp_call` 转发）。

**名册段（Inventory section）**：`dynamic`/`lazy` 下写进系统提示的 server 清单（名字 + 描述），让模型知道有哪些可用。

**策略（Policy）**：一个工作区对若干行的决定，三件事：允许与否、模式、工具规则。

**求值链（Resolution chain）**：工作区层 → 全局层 → 默认。前一环存在即不读后一环。

**工作区（Workspace）**：一个目录路径。与 DSH `workspaceRegistry` 的持久化记录无关。

**屏蔽（Restriction）**：用 `tools.restrict({ allow, deny })` 在 scope 上摘掉已注册的工具，不停止进程。

**拦截（Suppression）**：在 Loader 层阻止行挂载，进程根本不启动。

## 3 工作区

- 身份 = 目录路径。策略文件 `<cwd>/.dsh/mcp-manager.json`，与 `dsh-skill-manager` 同目录，属于可提交的工程约定。
- 全局层文件 `$DSH_HOME/dsh-mcp-manager/global.json`。
- 写入经 `withFileLock` + `writeFileAtomic`；加锁前先建父目录。
- 事件源：`workingDirectory` 服务（会话级 cwd 投影）。`workingDirectory/change` 时重算**该会话**（该 agent）的行集合：注销不再允许的工具、注册新允许的。`workspaceRegistry` 只用于面板展示工作区名。
- 已知代价：会话中途切目录会触发一轮注销/注册，工具多时需要异步并给出状态。

## 4 加载模式

| 模式 | 连接时机 | 工具进上下文 | 载体 |
|---|---|---|---|
| `eager` | 宿主启动/预设重建，由组合挂载 | 全部 schema 进工具段 | 无 |
| `dynamic` | 首次 `mcp_load`，连接取自宿主级常驻池 | 默认不进；加载后经 `createMcpToolDefinition` 原生注册进调用方 agent scope | `native` |
| `lazy` | 同上 | 一个都不注册；schema 作为 `mcp_load` 结果返回，经 `mcp_call` 代理调用 | `proxy` |

**连接池**：宿主级常驻，键 = 行键 + 连接配置摘要。跨会话、跨子代理复用同一条连接（stdio 就是同一个子进程）。按会话引用计数，最后一个引用释放才停。不跨宿主重启——重启后需要重新 `mcp_load`。

**工具体**：`mcp_load`/`mcp_unload` 在 `dynamic` 与 `lazy` 下都注册；`mcp_call` 只在 `lazy` 注册；`eager` 下三个都不注册。

`mcp_load` 参数（全部保留）：
- `server`：行键或 server 名，必填
- `query`：词法匹配，只注册命中的工具；已加载的再给 query 只加宽不收窄
- `tool`：按名取一个工具并返回参数 schema
- `cursor` / `limit`：结果分页（默认每页 20）
- `detail` / `namesOnly`：返回形态，`tool` 调用默认升到完整 schema

## 5 可见性实现路线

**实现路线（2026-11-05 定稿）：闸门 + 屏蔽双保险。**

闸门（`src/gate.ts` + `src/suppress.ts`）：
- `dynamic`/`lazy` 的行在 `loader/entry-init` 时被摘掉：先 `Object.defineProperty(entry, 'disabled', { value: true })` 遮蔽原型 getter，再 `fiber.dispose()`。
- **顺序是硬要求**：Loader 的自处置分支先看 `entry.disabled`，为真直接 return；为假才会 `options.disabled = true` 并 `tree.commit()` 写回文件。顺序反了就把闸门状态写进用户的 `cordis.patch.yml`。
- 闸门状态只在内存：`delete entry.disabled` 即恢复，恢复用 `entry.update({ disabled: false }, false, true)`（`Entry.update` 不写文件）。
- 策略未就绪（`policyOf` 返回 null）时不动任何行，等下一轮。

屏蔽（`src/shield.ts`）：`agent/created` 时对非 `eager` 行按 `mcp__<server>__` 前缀 `restrict({ deny })`，兜住任何仍然挂载的全局工具。`mcp_load` 注册进 agent scope 的同名工具不受限（宿主保证 scope 自有注册对 restrict 免疫）。

**验证**（隔离 profile，2026-11-05）：带一条 stdio 探针行启动，结果为 `suppressed: ["probe"]`、探针进程 0、`cordis.patch.yml` 哈希与启动前一致。
- **判据按模块名**，不探测方法存在：include 树认 `cordis:include` / `@deepseek-ai/cordis-plugin-include` 的 owner 名，外加 `filename` 为字符串。**绝不依赖 `write()`**——宿主 0.2.2-rc.1 的 include 1.1.0 已移除它，这正是社区实现 issue #6 的根因。

**两条不能碰的红线**（来自宿主实测）：
- 在 root ctx 上 `register` 会变成全局注册，必须用 `agent.ctx.get('tools')`。
- 在全局 ctx 上 `restrict()` 直接抛错，必须用 scoped ctx。

## 6 策略与求值链

每行三件事各自独立求值，链：**工作区层 → 全局层 → 默认**。

- 允许与否：默认「允许」（存在即启用），工作区可显式关闭。
- 模式：默认取全局层的设置，全局默认 `dynamic`。
- 工具规则：工作区优先，全局层作缺省。

策略文件形态（工作区层）：

```json
{
  "version": 1,
  "rows": {
    "global:alibaba-devops-mcp": {
      "enabled": true,
      "mode": "dynamic",
      "tools": ["!delete_*", "read_*"]
    }
  }
}
```

## 7 工具过滤

语法照搬社区实现（`mcp-tool-filter.ts`，130 行）：

- 条目不带 `!` = 保留；有任一保留项即为白名单。
- `!` 开头 = 隐藏；只有隐藏项时为黑名单。
- `*` 匹配任意长、`?` 匹配一个字符，其余正则元字符转义，锚定 `^…$`，大小写敏感。
- 判定顺序：先 drop 再看 keep。
- 解析失败、空数组、类型不对 → 不过滤（打字错误不该静默藏掉一台 server）。

**两处过滤点**：`lazy` 下 `mcp_load` 的返回与 `mcp_call` 的入参校验都要过滤；`dynamic` 只需前一处（被隐藏的工具根本没注册）。

**三条约束**：
- 规则 reader 是活闭包，改规则不重建注册；下一次 `mcp_load` 读新值，已加载的 server 不追溯。
- `mcp_load` 结果带 `hidden` 计数，让模型知道「还有工具但不可调用」。
- `eager` 下行由宿主挂载，规则无法作用于工具段，但可用 `restrict` 从视图摘掉——这是与社区实现的差别（社区对该情形整体只读）。

## 8 名册段

`dynamic`/`lazy` 下出版，注册在 `systemPrompt.section`，位置 `MCP_SERVERS`。

- 渲染是纯函数，吃「名字 + 描述」与开关，不碰 Loader。
- 段文本是快照，装配时不能 `await`；由 `refresh()` 重读后渲染。
- **绝不写「是否已加载」**——那会让每次 `mcp_load` 重写系统提示，打断整个前缀。
- 预算只削描述不删名字：单条 80 字符、整段 900 字符；`interpolate: false`。
- 导语按模式点名可用工具，不存在的工具不提。

没有 `mcp_search` 时，发现 server 全靠这一段。

## 9 托管 server 的定义（2026-11-05 决策改为运行时挂载）

**不写任何 cordis 文件**。托管定义存 `$DSH_HOME/mcp-manager/servers.json`，由插件在运行时用
`ctx.plugin({ name, inject, apply }, config)` 挂载 `dsh-mcp-client` 实例。

- 只有 `eager` 的托管行才真挂；`dynamic`/`lazy` 走连接池，与用户配置的行同一路径。
- 托管行不在 Loader 的 entry 树里，视图与名册由 `mergeOwnedRows` 合并，行键 `own:<serverName>`。
- **与用户行同名会被拒绝**：宿主按 `serverName` 在同一 scope 内互斥，两个实例会互相拒绝。

否决过的替代方案：建 `mcp-manager.cordis.yml` 并往用户 `cordis.patch.yml` 插 `cordis:include` 行。
理由：那要程序改用户手写的 YAML（注释、缩进、引号风格都可能被破坏），与「闸门绝不写回」是同一条底线的两面。

## 10 首版范围

**做**：三档模式、工具过滤、名册段、工作区分层与重算、全局行只读展示 + 插件托管文件的读写、面板（名册 + 模式选择 + 工具勾选）。

**不做**：`mcp_search`、SQLite 目录、预设平面写操作、Claude 导入、`resources`/`prompts` 工具、server instructions（按需模式拿不到，与社区同）。

**已实现**（超出最初的首版范围）：三种模式全部落地、工具过滤、名册段、工作区重算、四个 UI 槽位、预加载闸门、托管 server 的运行时挂载与面板表单。

## 11 验收

- `pnpm typecheck`、`pnpm test` 全绿（`node --test` 直接测 `lib/` 产物）。
- 单测覆盖：求值链、过滤语法、名册渲染、策略读写与锁。
- 手工验证清单：`eager`/`dynamic`/`lazy` 三档各起一次会话；工作区切换生效；切目录重算；348 工具 server 加载后的请求体量对比。

## 12 已知风险

1. `createMcpToolDefinition` 依赖宿主导出（`dsh-mcp-client` 根导出，经 `loader.internal.import` 取同实例）。宿主缺失时要 fail loud，不静默降级。
2. 拦截路线依赖 Loader 内部事件（`internal/plugin`、`loader/entry-init`），这是社区实现反复踩坑处；判据必须按模块名，且每次宿主升级要复验。
3. `workingDirectory/change` 时的重算在大工具集下可能卡顿，需要做成异步并给状态。
4. PTC 模式下「每个工具占三份 schema」未经核实，影响 token 估算的准确性。