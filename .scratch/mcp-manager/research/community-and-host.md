# dsh-mcp-manager 社区实现与宿主 0.2.2-rc.1 调研

调研时间：2026-11-05。只读调查。三条来源：社区包本地副本（`<local-copy>\dsh-mcp-manager`，v1.6.0）、上游 issue #6、宿主安装包 `0.2.2-rc.1` 与对照版 `0.2.1-rc.5` 的 asar 内容。

## 一 结论

1. **这是单包插件，不是多包。** 一个 npm 包两个入口：host 侧 `lib/index.mjs`（来源 `src/`），client 侧 `lib/client.js`（来源 `src/client/`），用 `dsh.client.inject` 声明客户端注入依赖，用 `cordis.patch.yml` 声明 bundle 补丁。全部 dsh 依赖都是 optional 的 peerDependency，运行时靠宿主 module graph 取同一实例。
2. **三种模式的差别在「谁在什么时刻决定挂载」，不在工具实现。** `eager` 由组合挂载，工具在宿主启动时由 `dsh-mcp-client` 一次性注册；`dynamic` 与 `lazy` 由闸门在 Loader 的 entry 构造期（`loader/entry-init`）与 fiber 发布期（`internal/plugin`）就拦住行，之后再靠 `mcp_load` 首次调用时按需建连。`dynamic` 注册真实工具定义（native 载体），`lazy` 一个工具都不注册（proxy 载体）。
3. **issue #6 的根因已定位到确定的一处宿主 API 变化。** 社区包的全局行读取器要求 include 树上有公开 `write()` 方法（`isGlobalPlaneTree`）。`0.2.1-rc.5` 的 `@deepseek-ai/cordis-plugin-include` 1.0.10 有公开 `write()`；`0.2.2-rc.1` 换成 1.1.0，公开 `write()` 消失，只剩 `_write()`、`_writeText()`、`commit()`、`flush()`。判定恒 false，全局名册为空，连锁到 inventory、`mcp_load`、`releaseGlobalHold` 三处。
4. **宿主提供的能力足够，但可编程入口只有三种，且都要在正确的 scope 上登记。** 分别是组合行（patch/include）、`ctx.plugin(...)` 运行时挂载、`loader.internal.import(...)` 取模块。工具表本身是活表：`ToolsService.register()` 返回 disposer，任何时刻可变；`views` 按 agent scope 分层，`restrict()` 可按会话屏蔽全局工具。
5. **「一个会话能看到哪些工具」的唯一裁决点是 `ToolsService.view(scope)` 加上该次步骤的 `toolSet`，不是 MCP 客户端。** MCP 侧只负责把定义注册进某层；可见性与系统提示投影由 `tools` 服务的 scope 链决定。

## 二 社区包整体结构

**单包、双入口。** `<local-copy>\dsh-mcp-manager\package.json:2` 声明名 `@guowenzhang/dsh-mcp-manager`，`:25` `main: lib/index.mjs`，`:26-36` 导出表含 `.`、`./client`、`./cordis.patch.yml`、`./locale/*`。

**bundle 与 client 声明。**

- `package.json:40-52` `dsh.client.inject` 列了 7 个客户端包（`dsh-api-gateway`、`dsh-api-remotes`、`dsh-client-locale`、`dsh-client-store`、`dsh-client-ui-renderer`、`dsh-client-ui-settings`、`dsh-client-ui-slots`），`platform: web`。
- `package.json:53-55` `dsh.bundle.patch: ./cordis.patch.yml`。
- `package.json:37-39` `engines.dsh: >=0.1.7-0`。

**patch 写法：insert 一行，带自身去重守卫。** `<local-copy>\dsh-mcp-manager\cordis.patch.yml:6-9`：

```yaml
- insert:
    - id: mcp-manager
      name: '@guowenzhang/dsh-mcp-manager'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === '@guowenzhang/dsh-mcp-manager' && e.options.id !== 'mcp-manager' && !e.disabled)"
```

写法要点：`!!js` 表达式在 Loader 里求值（`_resolveDisabled`，见宿主 `cordis-plugin-loader/lib/index.js:476-478`），用来处理「已被别的 bundle 以不同 id 挂过」的重复注册。

**依赖的 dsh 内部包（`package.json:76-98`，全部 optional peer）：**

`@deepseek-ai/cordis`、`cordis-plugin-include`、`cordis-plugin-loader`、`dsh-agent`、`dsh-agent-preset-registry`、`dsh-api-gateway`、`dsh-api-remotes`、`dsh-atomic-write`、`dsh-client-*` 六个、`dsh-host-plugin-inventory`、`dsh-mcp-client`、`dsh-scope`、`dsh-tools`、`dsh-typert-protocol`，外加 `react`/`react-dom`。

真正运行时用的：`dsh-mcp-client`（适配器与挂载）、`dsh-tools`（`ctx.tools.register`）、`dsh-scope`（scope 判定）、`cordis-plugin-include`（`entryListSchema`，见 `src/mcp-global-include.ts:20`）、`cordis-plugin-loader`（`EntryOptions` 类型）、`dsh-atomic-write`（`writeFileAtomic`）。

**源码规模（`src/`）：** host 侧 `lazy-mcp.ts` 1629 行、`mcp-remote.ts` 963 行、`mcp-gate.ts` 767 行、`index.ts` 414 行；client 侧 `McpSection.tsx` 1077 行、`McpEditor.tsx` 909 行。

## 三 三种加载模式：判定时刻与实现手段

模式取值见 `src/lazy-mcp.ts:109-123`（`eager`/`dynamic`/`lazy`，非法值回落 `dynamic`）。模式不是编译期常量，而是活设置：`src/index.ts:108` 首次读取，`src/index.ts:391-413` 在 `loader/volatile-update` 上重算（`src/index.ts:415-417`）。

**第一层判定：允许不允许用（composition 行的 `disabled`）与什么时候进上下文（`loading` 模式）是两个开关。** 社区包自己的规则文档写得很清楚：`<local-copy>\dsh-mcp-manager\.claude\rules\loading-modes-and-carrier.md:18-20`。

| 模式 | 谁决定不挂载 | 判定时刻（代码位置） | 工具何时进工具表 |
|---|---|---|---|
| `eager` | 无人拦；组合照常挂载 | `registerMcpTools` 直接返回空实现，见 `src/lazy-mcp.ts:551-553` | 宿主启动时，由 `dsh-mcp-client` 的 `apply` 连接后同步注册（宿主 `dsh-mcp-client/lib/index.js:810-833`，注册在 `:153`），`dynamic`/`lazy` 额外工具一个都不注册 |
| `dynamic` | 预加载闸门（gate） | 行已在组合里但尚未导入时，`loader/entry-init` 打标记（`src/mcp-gate.ts:412-429` 注释、`:517-542`）；fiber 发布时 `internal/plugin` 直接 `dispose`（`src/mcp-gate.ts:345-396`）；已挂载的全局行事后拦（`:607-632`） | `mcp_load` **首次调用**时：`agent.ctx.get('tools')` 上换一代注册（`src/lazy-mcp.ts:1092-1105`），定义由宿主适配器 `createMcpToolDefinition` 造（`src/mcp-carrier.ts:172-200`） |
| `lazy` | 同上 | 同上 | **永不注册工具**。`carrierFor` 返回 `proxy`（`src/mcp-carrier.ts:123-126`），`mcp_load` 只把 schema 当结果返回（`src/lazy-mcp.ts:1042-1043` 之后的 native 分支不执行），调用走 `mcp_call`（`:1360`） |

**闸门的两个拦截窗口，缺一不可。** 注释在 `src/mcp-gate.ts:343-345`（fiber 发布是最早能拦住进程启动的时刻，但只在行已存在时可观察）与 `:399-429`（在 `loader/entry-init` 里标记，因为构造期既无 options 也无 parent group）。`index.ts` 在 `apply` 的第一条语句就订阅这两个事件，见 `src/index.ts:109-141`，并在 `:192-199` 建闸门、`:216-218` 回放心跳。

**工具面的组成。**

- 按需模式注册：`mcp_load`（`src/lazy-mcp.ts:858`）、`mcp_unload`（`:1415`）两种模式都注册。
- `mcp_call` 只在 `lazy`（`:1360`）；`dynamic` 下注册的是真实工具名 `mcp__<server>__<tool>`。
- `mcp_search` 只在优化设置 `search` 打开时注册，且该答案会改变请求前缀，所以由 `mcpRegistrationKey` 触发整代重建（`src/lazy-mcp.ts:564` 与 `src/index.ts:305`、`:399-411`）。
- 服务器名册不做成工具，而是系统提示段 `mcp-manager:on-demand`（`src/lazy-mcp.ts:751-778`；渲染见 `src/mcp-inventory.ts:81-102`；预算 900 字符见 `:29-32`）。这是 issue #6 里「系统提示 inventory 段为空」的那一段。

**启停与连接复用。** 连接在宿主级池里，跨会话共用；`mcp_load` 的注册落在调用方 `agent.ctx`，会话结束只释放自己的注册与 claim（`src/lazy-mcp.ts:635-670`）。这就是「一台服务器在宿主内只起一次」（`.claude/rules/loading-modes-and-carrier.md:44-46`）。

## 四 issue #6

来源：`https://github.com/zhang-guo-wen/dsh-mcp-manager/issues/6`（本次通过 GitHub API 读取：`state: open`、作者 `dreanzy`、创建于 `2026-11-05T05:48:05Z`、`comments: 0`、`labels: []`）。

**维护者回复：无。** 该 issue 的 `comments` 字段为 0，评论端点取不到任何内容，因此没有维护者回复、没有被关闭、没有标签。

**报错原文（issue 正文摘录）：**

```
unknown or disabled MCP server
```

代码里的完整串在 `<local-copy>\dsh-mcp-manager\src\lazy-mcp.ts:1024-1028`：

```
unknown or disabled MCP server "${serverName}" — load one of the MCP servers listed in your system prompt
```

**复现条件（据 issue 正文）：**

1. 宿主 `0.2.2-rc.1`（Windows），插件 `1.6.0`，profile `~/.dsh/profiles/desktop`，单 preset。
2. 5 台 MCP server 全部写在 `mcp.cordis.yml`，由 profile 的 `cordis.patch.yml` 里 `id: mcp-manager-global` 的 `cordis:include` 行加载，不是补丁层顶层 `insert`。
3. 模式取 `dynamic` 或 `lazy`：MCP 工具注册数 0，`mcp_load` 报上述错，`mcp_search` 的 total/indexed/pending 全 0，系统提示无 inventory 段。
4. 模式取 `eager`：5 行全挂载，348 个工具可调用（说明抑制链正确、文件与行本身没问题）。

**根因：依赖了 `0.2.2-rc.1` 已移除的一处宿主 API。**

社区包的判定函数在 `<local-copy>\dsh-mcp-manager\src\mcp-gate.ts:253-257`：

```
return typeof candidate.filename === 'string' && typeof candidate.write === 'function'
```

读取器在 `src/mcp-gate.ts:554-566` 只用这一个判定拿全局树：

```
if (isGlobalPlaneTree(entry.subtree)) trees.push(...)
else if (entry.options?.group !== true) continue
else if (entry.subtree !== undefined) trees.push(entry.subtree)
```

两侧事实：

- `0.2.1-rc.5` 的 `@deepseek-ai/cordis-plugin-include` 1.0.10：`Include` 类有 `filename`（`<repo>\.tmp\mcp-manager-research\asar-021\@deepseek-ai\cordis-plugin-include\lib\index.js:111`，赋于 `:123`），有公开 `writeFile(config)`（`:218-234`）与公开 `write()`（`:239-242`）。
- `0.2.2-rc.1` 的 `@deepseek-ai/cordis-plugin-include` **1.1.0**：`filename` 仍在（`<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\cordis-plugin-include\lib\index.js:431`，赋于 `:452`），但全文件没有 `write()` 或 `writeFile()` 定义，只剩 `commit(change)`（`:519-525`）、`flush()`（`:500-511`）、`_write()`（`:584`）、`_writeText()`（`:656`）。`commit` 的语义也已不同：它由 Loader 在树变更后同步调用（`:518-520` 注释），不是「把当前树写回文件」的入口。

因此 `isGlobalPlaneTree` 恒 false。第二个分支也救不回来：patch 里 `insert` 的 include 行只写 `id`、`name`、`config`（`src/mcp-global-include.ts:102-109`），没有 `group: true`；而 Loader 不会替它补这个字段（`cordis-plugin-loader/lib/index.js:464`、`:485`、`:797` 都只是读 `this.options.group`）。于是 `trees` 为空。

**澄清 issue 里一处不准确的猜测。** 正文写「拿不到带 `filename` 的 `subtree`（或该行不在顶层 entries 里）」。实际不是这样：`EntryTree` 构造时若 `ctx.fiber.entry` 存在就把自己挂到该 entry 的 `subtree`（宿主 `cordis-plugin-loader/lib/index.js:207-212`），include 继承 `EntryTree`，所以 `entry.subtree` 存在且带 `filename`。缺的是 `write` 方法本身。

**连锁后果（三条，与代码对应）：**

1. 名册空：`readGlobalRows()` 返回 `[]`（`src/mcp-gate.ts:554-592`）。
2. 系统提示段空：`renderMcpInventory` 对空数组返回 `''`（`src/mcp-inventory.ts:86`），`mcp_load` 于是在 `allowedRows().find(...)` 处落空并抛错（`src/lazy-mcp.ts:1022-1028`）。
3. 已经 hold 的全局行放不回来：`for (const row of readGlobalRows())` 循环体不执行，`releaseGlobalHold` 从不被调用（`src/mcp-gate.ts:669-690`），所以只能重启宿主。

**另一处可能更耐久的判定（社区包已有但全局读取器没用）。** `ownsGlobalTree`（`src/mcp-gate.ts:260-275`）按模块名 `cordis:include` / `@deepseek-ai/cordis-plugin-include` 判，不依赖 `write`。它已被 `namePreHeld`（`:529`）使用，但 `readGlobalRows` 与 `includeEntries`（`:287-296`）没有用。这是本 issue 最小改动的落点。

## 五 宿主 0.2.2-rc.1 实际提供了什么

### 5.1 可编程注册 MCP server 的入口

三种，全部在宿主代码里可证：

1. **组合行。** `dsh-mcp-client` 是 namespace 插件，一个实例一个 server（`dsh-mcp-client/lib/index.js:747-757`），配置 schema 在 `:781-801`（`transport` 只能是 `stdio` 或 `streamable-http`，`serverName` 限 `^[A-Za-z0-9_-]{1,32}$`）。行可以写在 include 文件里（社区包的做法：`src/mcp-global-include.ts:25-34` 写 `mcp.cordis.yml` 与 patch 里的 `cordis:include` 行），也可以写在 preset 组合里。
2. **运行时挂载。** `ownerCtx.plugin({ name, inject, apply }, entryConfig)`：社区包 `src/index.ts:277-292` 就是这么托管「资源仓库」型 MCP 的（传入 `failOnStartupError: true`），拿到 handle 后可在任意时机 dispose。
3. **取模块同一实例。** `ctx.get('loader').internal.import('@deepseek-ai/dsh-mcp-client', ctx.baseUrl, {})`，见 `src/lazy-mcp.ts:196-212`；这是拿 `createMcpToolDefinition`（宿主 `:179-198` 定义、`:836` 导出）的唯一正路，能保证与组合挂载用的是同一个模块实例。

### 5.2 按 agent / session 粒度差异化

**可以，而且宿主是按 scope 分层设计的。**

- 注册接口：`ToolsService.register(definition, { when })` 注册到「调用它的 ctx 的 scope」，返回精确的 disposer（`dsh-tools/lib/index.js:426-445`）；重复名报错文案本身就区分了全局与 per-agent 两种情况（`:385`）。
- 可见性：`view(scope)` 把全局层、scope 链上的层、自身层合并，再逐层过 `restrictions`（`:469-508`）。近层遮蔽远层。
- 按会话屏蔽全局工具：`restrict({ allow, deny })` 必须用 scoped ctx 调（`:453-468`，全局调会直接抛错）。
- MCP 侧同样分 scope：`activeServerNames` 是 `WeakMap`，按注册 scope 记 `serverName` 保留名，因此不同 agent 可复用同名（`dsh-mcp-client/lib/index.js:770-774`、`:812-822`）。

结论：**「只给这一个会话」的做法是挂到 `agent.ctx`；「给这个 preset 的所有会话及其子代理」的做法是写成 preset 行。** 社区包的实测笔记同结论（`.claude/rules/loading-modes-and-carrier.md:74-79`）。

### 5.3 工具表可变时机

**任何时刻可变，且变更会自动让系统提示重算。**

- `register` 返回 disposer，注销即调它（`dsh-tools/lib/index.js:433-445`）。
- 层变更会 `ctx.emit('tools/change')`（`:410-412`）。
- 系统提示的工具体是每次装配时现算的 hook：`ctx.systemPrompt.tools(({ scope, toolSet }) => selectExecutor(scope).describe(definitions(scope, toolSet)))`（`:418-424`）。
- 每次模型步骤的门控：`resolve(context)` 对每个可见定义跑 `when` 条件，产出冻结的 `toolSet`，步骤结束 `dispose`（`:542-572`）。

`dsh-mcp-client` 自己也是活表：`syncTools` 采用「先取新代、再换旧代」的两阶段（`:127-161`），`tools/list_changed` 走一遍重新同步。

### 5.4 「一个会话能看到的工具」由谁决定

链路是：**该 agent 的 scope 决定层集合，`ToolsService.view(scope)` 决定可见集合，executor 决定投影到系统提示的形态，步骤的 `toolSet` 决定本轮可执行集合。**

- MCP 客户端只往某一层塞定义，不决定可见性。
- 系统提示里的工具清单来自 `ToolsService` 的 `systemPrompt.tools` hook（`:418-424`），不是 MCP 插件自己写段。
- 额外段落可由插件用 `systemPrompt.section` 加，比如社区包的名册（`src/lazy-mcp.ts:753-778`）与宿主 MCP 的 server instructions（`dsh-mcp-client/lib/index.js:736-743`）。

### 5.5 工作区与会话 cwd 的关系

三个概念，层次不同：

- **会话 cwd 是会话头字段，也是可继续变的投影。** `dsh-working-directory` 提供 `workingDirectory` 服务，投影 key 为 `workingDirectory`，初值取 `header.cwd`（`<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\dsh-working-directory\lib\index.js:34-44`，`:38` 是 `init: (header) => header.cwd ?? null`），每次变更追加 `working-directory/change` 事件（`:138-143`）。该服务的 `set()` 只改会话目录，不重建已有进程与权限（`:108-124` 注释）。
- **工作区是持久化实体，绑定规范化的 cwd。** `workspaceRegistry` 是服务名（`@deepseek-ai/dsh-workspace/lib/index.js:272` 注释、`:376` 声明）。把会话附加到工作区时要求 `header.cwd` 能 realpath 规范化且等于工作区路径，否则抛 `WorkspaceMoveInvalidError`（`:114-123`）。
- **session 与 cwd 的关系是「会话头携带 cwd，工作区要求该 cwd 与自身路径规范一致」。** 也就是说改会话 cwd 不会自动改工作区归属，跨工作区要靠 attach 校验。

对 MCP 的意义：MCP server 的 `config.cwd` 是子进程工作目录（`dsh-mcp-client/lib/index.js:40-45` 传给 `StdioClientTransport`），与会话 cwd、工作区路径三者互不联动。这一点决定了「按工作区自动启用某组 MCP」在宿主里没有现成钩子，只能由插件自己按 `workspaceRegistry` 或 `workingDirectory` 监听并重算。

## 六 结论表

| 类别 | 条目 | 依据 |
|---|---|---|
| 可直接复用 | `ctx.tools.register(def)` + disposer，做按需注册/注销 | `dsh-tools/lib/index.js:433-445` |
| 可直接复用 | `agent.ctx.get('tools')` 落 per-session 注册，跨会话隔离 | `src/lazy-mcp.ts:1092-1105`；`dsh-tools/lib/index.js:469-508` |
| 可直接复用 | `tools.restrict({ allow, deny })` 按会话屏蔽全局工具 | `dsh-tools/lib/index.js:453-468` |
| 可直接复用 | `createMcpToolDefinition` 经 `loader.internal.import` 取同实例，别自己拼定义 | 宿主 `:179-198`、`:836`；社区包 `src/lazy-mcp.ts:196-212` |
| 可直接复用 | `systemPrompt.section` 追加名册段，用 `MCP_SERVERS` 序位 | `src/lazy-mcp.ts:753-778` |
| 可直接复用 | 运行时挂载：`ownerCtx.plugin({name,inject,apply}, config)` | `src/index.ts:279-286` |
| 必须绕开 | 用 include 树的 `write` 方法认「这是全局平面」：`0.2.2-rc.1` 已无此方法 | `asar\...\cordis-plugin-include\lib\index.js:431-520` 对照 `asar-021` 同名文件 `:239-242` |
| 必须绕开 | 指望 `entry.options.group === true` 兜底 include 行：patch 的 insert 不写该字段，Loader 也不补 | `src/mcp-global-include.ts:102-109`；`cordis-plugin-loader/lib/index.js:464`、`:485` |
| 必须绕开 | 在 root ctx 上调 `register` 想给某个会话加工具：会变全局注册 | `dsh-tools/lib/index.js:385` 报错文案；`.claude/rules/loading-modes-and-carrier.md:55-57` |
| 必须绕开 | 在全局 ctx 上调 `restrict()`：直接抛错 | `dsh-tools/lib/index.js:454-455` |
| 必须绕开 | 改 `lib/` 期望热更新 host 侧插件代码：host 半边进程内模块，需重启宿主 | `.claude/rules/loading-modes-and-carrier.md:103` |
| 缺口 | 全局平面的树判定没有稳定协议：`filename` 是巧合可用的标记，`write` 已失效，`commit` 语义是 Loader 回写而非用户写回 | 两版 include 对照 |
| 缺口 | 宿主没有「按工作区自动启用某组 MCP」的钩子：cwd、工作区、MCP 子进程 cwd 互不联动 | `dsh-working-directory/lib/index.js:34-44`；`dsh-workspace/lib/index.js:114-123` |
| 缺口 | 宿主不暴露「按 preset 作用域枚举 MCP 行」的公开服务，只能自己走 Loader entry 树 | 社区包 `src/preset-mounts.ts`、`src/mcp-gate.ts:278-296` 自建 |
| 缺口 | `mcp_load` 的按需名册（系统提示段）宿主不提供，必须插件自渲染 | `src/mcp-inventory.ts:81-102` |

## 七 未证实项

1. 「include 行落在顶层 `loader.entries()` 里」是据 `EntryTree.entries()`（`cordis-plugin-loader/lib/index.js:217-223`）与 patch 层 insert 语义推断的，未在运行实例上打印验证。
2. `0.2.1-rc.5` 上本插件三种模式是否全部实测通过，只有 README 的一句话声明（`README.zh.md:70-71`：「DSH Desktop 当前版本（`0.2.1-rc.5`）已验证可用」），没有逐模式记录。
3. issue 正文说「`eager` 下 348 个工具全部可调用」，未在本机复现。
4. 宿主 `0.2.2-rc.1` 对 include 1.1.0 的 `commit()` 是否有其他公开契约（例如只由 Loader 调用）只有注释旁证（`asar\...\cordis-plugin-include\lib\index.js:518-520`），未见类型声明或 README 确认。
5. PTC 模式下「每个工具占三份 schema」来自 issue 的陈述，本次未核对 PTC executor 的投影实现。

## 八 来源

**本机文件（社区包）：**

- `<local-copy>\dsh-mcp-manager\package.json`
- `<local-copy>\dsh-mcp-manager\cordis.patch.yml`
- `<local-copy>\dsh-mcp-manager\README.zh.md`
- `<local-copy>\dsh-mcp-manager\src\index.ts`
- `<local-copy>\dsh-mcp-manager\src\lazy-mcp.ts`
- `<local-copy>\dsh-mcp-manager\src\mcp-gate.ts`
- `<local-copy>\dsh-mcp-manager\src\mcp-carrier.ts`
- `<local-copy>\dsh-mcp-manager\src\mcp-inventory.ts`
- `<local-copy>\dsh-mcp-manager\src\mcp-global-include.ts`
- `<local-copy>\dsh-mcp-manager\src\mcp-modules.ts`
- `<local-copy>\dsh-mcp-manager\.claude\rules\loading-modes-and-carrier.md`

**本机文件（宿主，asar 解包副本）：**

原始安装位置 `%USERPROFILE%\scoop\apps\deepseek-harness-pre\0.2.2-rc.1\resources\app.asar`，asar 内路径前缀 `dsh/node_modules/`。下列行号对应本次提取的只读副本（内容逐字节来自 asar）：

- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\dsh-mcp-client\lib\index.js`
- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\dsh-tools\lib\index.js`
- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\cordis-plugin-loader\lib\index.js`
- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\cordis-plugin-include\lib\index.js`（版本 1.1.0）
- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\dsh-workspace\lib\index.js`
- `<repo>\.tmp\mcp-manager-research\asar\@deepseek-ai\dsh-working-directory\lib\index.js`

对照版 `0.2.1-rc.5`（`%USERPROFILE%\scoop\apps\deepseek-harness-pre\0.2.1-rc.5\resources\app.asar`）：

- `<repo>\.tmp\mcp-manager-research\asar-021\@deepseek-ai\cordis-plugin-include\lib\index.js`（版本 1.0.10）

**网页：**

- `https://github.com/zhang-guo-wen/dsh-mcp-manager/issues/6`（正文与元数据经 GitHub API 读取）
