# 仓库模式与架构调研报告（dsh-mcp-manager 侦察）

本报告对 `dsh-skill-manager` 与 `dsh-plugin-manager` 的架构、生命周期、持久化、界面基调、测试体系进行深度剖析，为新包 `dsh-mcp-manager` 的设计与复用提供确定性事实与证据支撑。

---

## 1. 插件骨架与装配契约

### 结论
DSH 插件遵循 Cordis 插件规范与 monorepo 统一约束。核心骨架由三部分组成：
1. **package.json 核心字段**：声明包格式（`type: "module"`）、运行时引擎要求（`node: ">=22"`）、Cordis bundle 补丁入口（`dsh.bundle.patch`）、前端面板入口（`exports["./client"]`）与前端依赖注入声明（`dsh.client.inject`），以及标准化脚本（`prepare/build/typecheck/test`）。
2. **cordis.patch.yml 形状**：遵循单一声明结构，使用 `- insert:` 列表将当前包注册进 profile 插件行。
3. **src/index.ts 生命周期**：显式声明包名与最小硬依赖（`name` 与 `inject`），在 `apply(ctx)` 中实现事件安装、重载补偿（`bootstrap`）、动态依赖注入（`context.inject(['connection'])`）与全生命周期清理（`context.effect`）。

### 证据与关键实现

#### (1) package.json 必需字段
- **Bundle 补丁**：必须提供 `dsh.bundle.patch: "./cordis.patch.yml"`，供宿主 profile 安装时合入插件列表。
- **客户端入口**：必须在 `exports` 中暴露 `"./client": "./client/client.js"`，宿主 Web 端会根据此子路径动态载入面板。
- **客户端环境**：必须声明 `dsh.client.platform: "web"` 以及客户端所需的服务注入：
  ```json
  "inject": [
    "@deepseek-ai/dsh-client-connection",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-locale"
  ]
  ```
- **构建与测试脚本**：
  - `"prepare": "tsc -p tsconfig.json"`：契约硬要求。用户以源码方式安装（`github:<owner>/<repo>#<sha>&path:/packages/<pkg>`）时由 npm/pnpm 自动触发编译。
  - `"build": "tsc -p tsconfig.json"`
  - `"typecheck": "tsc -p tsconfig.json --noEmit"`
  - `"test": "tsc -p tsconfig.json && node --test --test-isolation=none test/"`
- **来源出处**：`<repo>\packages\dsh-skill-manager\package.json:6-45`；`<repo>\packages\dsh-plugin-manager\package.json:6-45`；`<repo>\GLOSSARY.md:32-38`。

#### (2) cordis.patch.yml 规范形状
YAML 顶层为列表，使用 `- insert:` 节点，内部声明 `id`（全局唯一 entry id）与 `name`（npm 包名）：
```yaml
- insert:
    - id: dsh-skill-manager
      name: '@dreanzy/dsh-skill-manager'
```
- **来源出处**：`<repo>\packages\dsh-skill-manager\cordis.patch.yml:1-3`；`<repo>\packages\dsh-plugin-manager\cordis.patch.yml:1-3`。

#### (3) src/index.ts 插件生命周期
- **服务声明**：`export const name = '...'`；硬依赖通过 `export const inject = ['...'] as const` 声明。不依赖的不声明（如刻意不硬注入 `connection`，无连接服务的 profile 也能正常装载核心逻辑）。
- **apply/dispose 闭环**：
  1. 调用 `installHooks(context)` 订阅核心宿主事件。
  2. 重载补偿：异步调用 `void hooks.bootstrap().catch(...)`。宿主热重载时已有活跃会话不会重新收到 `agent/created`，补偿逻辑枚举已有 live Agent 重新补上限制/遮蔽。
  3. 路由动态装配：`context.inject(['connection'], () => { ... })`，待 `connection` 服务就绪后再挂载 HTTP 端点。
  4. 资源清理：使用 `context.effect(() => () => { ... })` 注册注销回调，在插件卸载或重载时注销所有 fetch 路由及事件监听。
- **来源出处**：`<repo>\packages\dsh-skill-manager\src\index.ts:4-119`；`<repo>\packages\dsh-plugin-manager\src\index.ts:12-141`。

---

## 2. 服务端与宿主调用机制（API/RPC）

### 结论
服务端与 UI 半边之间通过 HTTP 端点通信。服务端通过 `connection.fetch.register` 注册标准化路由，所有响应均采用 Envelope 信封格式包装。为防止前端在非 2xx 时丢弃响应体，HTTP 状态码恒定返回 200。

### 证据与关键代码位置

#### (1) 端点注册与路径规范
宿主按完整 pathname 匹配，`/api` 前缀不可省略。三个标准路由：
- `/api/<manager>/global`：获取全局策略与全集清单。
- `/api/<manager>/workspace`：传入 `{ sessionId }`，获取当前工作区层状态与视图。
- `/api/<manager>/apply`：传入 `{ sessionId?, commands }`，提交绝对状态修改意图，写入后立即触发重算。
- **来源出处**：`<repo>\packages\dsh-skill-manager\src\index.ts:16-20`；`<repo>\packages\dsh-plugin-manager\src\index.ts:25-29`。

#### (2) 接口信封协议（Envelope）
- **类型定义**：
  ```typescript
  export type Envelope<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: 'bad-request' | 'unknown-session' | 'internal'; readonly message: string } }
  ```
- **HTTP 200 恒定响应规则**：
  ```typescript
  function toResponse(envelope: Envelope<unknown>): Response {
    // HTTP 状态恒为 200：前端只认信封里的 code，非 2xx 会让它丢掉 body。
    return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
  }
  ```
- **来源出处**：`<repo>\packages\dsh-skill-manager\src\index.ts:33-58`；`<repo>\packages\dsh-plugin-manager\src\index.ts:42-68`。

#### (3) UI 前端发起调用
前端在 `client/client.js` 中封装 `post(path, body)`，通过标准 fetch 发送 POST 请求，检测到 `payload.ok === true` 解包 `value`，否则抛出 `payload.error.message`。
- **来源出处**：`<repo>\packages\dsh-skill-manager\client\client.js:25-53`。

---

## 3. 工作区识别、文件存储与按 Agent 状态维护

### 结论
工作区身份严格等同于「文件系统目录路径」（cwd），与 DSH 的 `workspaceRegistry` 记录脱钩。策略分两层存储，写侧使用跨进程排他锁与原子写入，读侧免锁。生命周期内通过 `Map<string, AgentState>` 按活跃 Agent 实例维护进程内状态。

### 证据与行号

#### (1) cwd 的确定方式
服务端通过双重机制获取工作区 cwd：
1. **事件流场景**：从 `agent/created` 的 payload 中逐层解析：`payload.agent.session.header.cwd`。
   - **代码位置**：`<repo>\packages\dsh-skill-manager\src\hooks.ts:29-46, 250-259`；`<repo>\packages\dsh-plugin-manager\src\hooks.ts:324-338`。
2. **HTTP 路由场景**（根据 `sessionId` 解析）：
   - 先尝试从活跃 Agent 获取：`ctx.get('agents').get(sessionId)`，读取 `agent.session.header.cwd`。必须使用宿主返回的 Agent 对象本体（作用域链按对象身份索引）。
   - 活跃 Agent 未命中时，降级使用 `ctx.get('sessionQuery').observeSession(sessionId, { projectionMode: 'none' })` 获取会话元数据中的 cwd。
   - 泄漏防护：`observeSession` 返回的观察体必须在 `finally` 块中调用 `[Symbol.dispose]()` 释放，否则会导致会话订阅泄漏。
   - **代码位置**：`<repo>\packages\dsh-skill-manager\src\routes.ts:78-126`。

#### (2) 策略文件存放位置
- **全局层**：`$DSH_HOME/<plugin-id>/global.json`，通过 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath` 获取。
- **组定义**：`$DSH_HOME/<plugin-id>/groups.json`，跨工作区共享。
- **工作区层**：`<cwd>/.dsh/<plugin-id>.json`，放在工程内跟随代码仓库版本管理。
- **代码位置**：`<repo>\packages\dsh-skill-manager\src\store.ts:22-35`；`<repo>\packages\dsh-plugin-manager\src\hooks.ts:45-59`；`<repo>\packages\dsh-skill-manager\docs\adr\0003-workspace-is-directory.md:1-26`。

#### (3) 读写与事务保证
- **读操作**：`readFile(path, 'utf8')`，无锁直接读取。由于写入总是通过原子重命名完成，读取方绝不会读到半截数据。若文件返回 `ENOENT` 则降级为默认空策略。
- **写操作**：`transact(path, mutate)` 事务函数：
  1. 必须在加锁前创建父目录：`mkdir(dirname(path), { recursive: true, mode: 0o700 })`（因为 `withFileLock` 直接以 `wx` 模式创建 `<file>.lock`，若父目录不存在会直接崩溃）。
  2. 跨进程文件锁：`await withFileLock(path, async () => { ... })`。
  3. 锁内执行：读取当前内容 -> `mutate(current)` 内存修改 -> `writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })` 原子覆盖。
- **代码位置**：`<repo>\packages\dsh-skill-manager\src\store.ts:37-58`；`<repo>\packages\dsh-plugin-manager\src\hooks.ts:101-112`。

#### (4) 监听的宿主事件
- `agent/created`：创建新 Agent 时触发。用于捕获新会话、记录状态并同步施加策略。
- `agent/disposed`：Agent 销毁时清理进程内句柄与状态。
- `skills/change`（针对 skill 变更）或 `system-prompt/assemble`（针对提示词装配瀑布）。
- 注意：事件名称必须包含正斜杠（如 `agent/created`），不可写成点号。
- **代码位置**：`<repo>\packages\dsh-skill-manager\src\hooks.ts:300-304`；`<repo>\packages\dsh-plugin-manager\src\hooks.ts:504-509`。

#### (5) 进程内状态按 Agent 维护
- 核心结构：`const states = new Map<string, AgentState>()`，键为 `agent.id`。
- `AgentState` 结构包含：
  - `agent`: 最小化 AgentLike 引用；
  - `dispose`: 释放当前施加效果的回调句柄（或 null）；
  - `key`: 隐藏名单/规则的签名串，用于避免无实质变更时的重复重算；
  - `stuck`: 施加后复验仍被其他插件占用的冲突项。
- 循环风暴守卫：SM 在注册遮蔽副本时会触发 `skills/change`，通过 `let applying = 0` 计数器防重入。
- 重载补偿：`bootstrap()` 通过 `ctx.get('agents').list()` 枚举现有 Agent 补建 `states`。
- **代码位置**：`<repo>\packages\dsh-skill-manager\src\hooks.ts:66-74, 180-198, 343-365`。

---

## 4. 持久化、并发与意图模型（ADR-0005 深度分析）

### 结论
写入协议采用「绝对状态意图命令」（Command）模型，彻底抛弃带版本号的乐观锁。文件并发写入依赖文件锁与固定顺序事务保证。前端通过 ADR-0005 确立的「草稿与保存」（Draft and Save）模式消除快速连击导致的在途乱序跳动。

### 证据与实现

#### (1) ADR-0005「草稿与保存」的核心逻辑
- **解决的痛点**：若用户每拨一次开关就发送一次 HTTP 请求并全量替换前端视图，快速连点时多个在途请求乱序返回，导致界面在不同状态间来回跳动。
- **解决方案**：将「编辑」与「提交」明确解耦：
  1. 开关拨动仅修改浏览器内存中的 React 状态（草稿），底部浮出常驻条（显示 `N 处未保存`、`撤销`、`保存`）。
  2. 点击保存时，将全部未保存的修改打包成一条批处理请求一次性写入。
  3. 点击撤销或直接关闭面板弹层，草稿直接随组件卸载丢弃。
- **特例边界**：分组定义增删改及项的组归属（`assign`）不进草稿，**保持即时写入**。因为分组跨工作区全局共享，不属于当前工作区会话的撤销范畴。
- **来源出处**：`<repo>\packages\dsh-skill-manager\docs\adr\0005-draft-and-save.md:1-22`；`<repo>\packages\dsh-skill-manager\client\client.js:773-790`。

#### (2) 意图写入如何避免覆盖（无版本乐观锁）
- **命令模型（Command）**：客户端提交的是幂等的绝对状态表达，如 `{ op: 'item', layer: 'workspace', name: 'xxx', value: false }`（`value: null` 表示删除键回到跟随）。
- **无版本比对**：服务端不校验快照 revision。每次在文件锁内读取最新文本 -> 应用命令 -> 原子落盘。写入遵循后点者胜（Last Write Wins），由于单项命令幂等且可交换，消除了冲突报错的可能。
- **固定加锁顺序**：涉及多文件写入时（全局、工作区、组定义），严格按固定顺序拿锁事务（全局 -> 工作区 -> 组），避免并发写入时交叉等待产生死锁。
- **使用的包**：
  - `@deepseek-ai/dsh-atomic-write`：提供 `withFileLock` 与 `writeFileAtomic`。
  - `@deepseek-ai/dsh-home-paths`：提供 `dshHomePath`。
- **来源出处**：`<repo>\packages\dsh-skill-manager\docs\adr\0001-intent-writes.md:1-26`；`<repo>\packages\dsh-skill-manager\src\store.ts:208-223`。

---

## 5. UI 半边组织与 UI Baseline 红线

### 结论
UI 端采用手写单文件 Vanilla JS 方案（`client/client.js`），不引入 JSX 或打包器，由宿主动态加载。样式基于设计令牌 `T` 与样式工厂 `S`。UI 必须严格遵守 `docs/ui-baseline.md` 规定的视觉红线，违规直接被 CI 静态检查脚本阻断。

### 证据与红线清单

#### (1) 前端文件组织与挂载
- **模块加载器**：通过 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 暴露给宿主。通过 `require('react')` 拿到 React，纯手写 `React.createElement`（别名 `h`）。
- **槽位挂载**：在 client 的 `apply(ctx)` 中注入并注册以下标准槽位：
  1. `settings.section`：全局设置页中的管理入口。
  2. `sidebar.panellist`：宿主左侧栏图标入口。
  3. `main`：点击侧栏展开的主视图全屏面板。
  4. `conversation.input.right`：对话框输入框右侧 Chip 按钮（标注 Skills / Plugins）。
  5. `shell.overlay`：全局弹层容器（挂载 `WorkspaceModal`）。
- **来源出处**：`<repo>\packages\dsh-skill-manager\client\client.js:1-16, 964-1095`。

#### (2) 与宿主事件及状态的联动刷新
- 对话框输入框右侧 Chip 从宿主 props 接收当前的 `sessionId`。
- 点击 Chip 使用 React 18 的 `useSyncExternalStore` 切换弹层打开状态。
- 打开弹层发起 `api.workspace(sessionId)` 获取数据；保存时调用 `api.apply(commands, sessionId)`，服务端落盘后显式调用 `reapply()` 刷新 live Agent 状态并返回最新视图更新本地 React state。
- **来源出处**：`<repo>\packages\dsh-skill-manager\client\client.js:1058-1091`。

#### (3) UI Baseline 的五大硬约束（红线）
来自 `docs/ui-baseline.md` 及自动化检查器 `scripts/check-ui-vars.mjs`：
1. **只使用宿主 `--dsw-*` 变量，禁止引入第三方插件变量（如 `--dsh-*`）**：
   - 理由：第三方主题变量不可靠，宿主未装该插件时变量落空；在官方暗色主题下整块面板发灰。
   - 强制检查：CI 脚本 `scripts/check-ui-vars.mjs` 会正则扫描 `client/*.js`，字符串中出现 `--dsh-` 直接 `process.exit(1)`。
2. **开关颜色语义禁止按变量名猜测，必须用反色设计**：
   - 踩坑教训：`--dsw-alias-state-idle-primary` 在暗色主题下解析为近白色，与白圆点重叠成为纯白胶囊，开与关无法分辨。
   - 正确实现：开态轨道取 `--dsw-alias-label-primary`（暗色下亮白）配 `--dsw-alias-bg-layer-1` 圆点（近黑）；关态用半透明中灰轨道配浅圆点。
3. **严禁用品牌色做实心高亮**：
   - 分段控件、Tag 标签等小块元素一律采用「浅底（如 `rgba(127, 127, 127, 0.22)`）+ 主文字色」。在暗色主题下，纯蓝品牌实心块会严重遮盖周边视觉层次。
4. **面板底色必须用 `--dsw-alias-bg-layer-1`，禁用 `--dsw-alias-bg-overlay`**：
   - 踩坑教训：`--dsw-alias-bg-overlay` 在暗色主题下绑定的是中灰（`neutral-bluish-700`），做底色时弹窗比整个页面亮一大截。它的语义是半透明浮层，卡片底必须用 layer-1。
5. **原生表单弹层必须显式指定对比度**：
   - 原生 `<select>` 必须显式声明 `colorScheme: 'light dark'`，选项 `<option>` 采用系统色 `color: 'CanvasText', background: 'Canvas'`，防止系统原生弹出菜单出现白底浅字。
- **来源出处**：`<repo>\docs\ui-baseline.md:1-42`；`<repo>\scripts\check-ui-vars.mjs:1-55`；`<repo>\packages\dsh-skill-manager\client\client.js:66-93, 222-236`。

---

## 6. 测试与构建体系

### 结论
仓库采用「先 tsc 编译，后以原生 Node.js 测试 runner 直接执行编译产物（lib/*.js）」的策略。测试文件使用原生 JavaScript ESM，搭配测试替身（Fake），不依赖任何重型测试框架或外部 Mock 工具。

### 证据与测试组织

#### (1) test 目录组织
- 测试文件全部命名为 `*.test.js`，放置于各包的 `test/` 目录下（如 `policy.test.js`, `hooks.test.js`, `routes.test.js`, `catalog.test.js`）。
- 测试文件直接从编译输出目录导入待测模块：
  ```javascript
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { createResolver, hiddenNames } from '../lib/policy.js'
  import { installHooks } from '../lib/hooks.js'
  ```
- **来源出处**：`<repo>\packages\dsh-skill-manager\test\policy.test.js:1-12`；`<repo>\packages\dsh-skill-manager\test\hooks.test.js:1-6`。

#### (2) 测试运行命令
- 各包内部执行：`pnpm test` -> `tsc -p tsconfig.json && node --test --test-isolation=none test/`。
- 根目录执行：`pnpm test` -> `node scripts/check-ui-vars.mjs && pnpm -r test`。
- **参数说明**：`--test-isolation=none` 让 Node 在同一主进程中运行所有测试文件，消除每个测试文件冷启动 Node 进程的开销，数十个用例在百毫秒内完成。
- **来源出处**：`<repo>\package.json:4-6`；`<repo>\packages\dsh-skill-manager\package.json:37-42`。

#### (3) 编译产物测试模式与轻量替身
- 坚决不使用 ts-node、esbuild-register 或 ts-jest，直接测试真实编译产物（`lib/` 下的编译代码），彻底规避转译器行为不一致问题。
- 测试替身完全手写，例如在 `hooks.test.js` 中手写 `fakeCtx()`，支持事件监听模拟、同步/异步派发、警告收集；手写 `fakeSkills()` / `fakeTools()`，保证单元测试可独立、高并发运行。
- **来源出处**：`<repo>\packages\dsh-skill-manager\test\hooks.test.js:8-60`。

---

## 7. 结论：dsh-mcp-manager 复用模式清单与 MCP 专属改写

### (1) 可直接复用的模式清单（模板文件与代码定位）

| 复用维度 | 模板文件位置 | 具体复用模块/函数 | 为什么可直接复用 |
| :--- | :--- | :--- | :--- |
| **构建与包骨架** | `packages/dsh-skill-manager/tsconfig.json` | 全文配置（ES2022, NodeNext, strict） | 纯 TypeScript 编译配置，完全通用 |
| **装配补丁** | `packages/dsh-skill-manager/cordis.patch.yml` | 全文结构（替换 id 和 package 名称） | Cordis bundle 接入标准格式 |
| **两层策略计算** | `packages/dsh-skill-manager/src/policy.ts` | `parseLayer`, `parseGlobal`, `parseGroups`, `serializeLayer`, `serializeGlobal`, `serializeGroups`, `createResolver`, `hiddenNames` | 核心层级优先级算法：`工作区项 ?? 工作区组 ?? 全局项 ?? 全局组 ?? 默认开` 完全一致 |
| **持久化与事务锁** | `packages/dsh-skill-manager/src/store.ts` | `transact`, `applyCommands`, `loadState`, `globalPath`, `workspacePath`, `groupsPath` | 基于 `@deepseek-ai/dsh-atomic-write` 的跨进程锁与原子写逻辑完全相同 |
| **HTTP 路由脚手架** | `packages/dsh-skill-manager/src/routes.ts` | `wrap`, `toResponse`, `parseCommands`, `resolveSession` (带 `Symbol.dispose` 资源保护) | 宿主 connection 端点注册、入参校验、Envelope 信封协议完全一致 |
| **UI 令牌与样式** | `packages/dsh-skill-manager/client/client.js` | 设计令牌 `T`, 样式工厂 `S`, 通用组件（`Switch`, `Segmented`, `Reset`） | 保证完全符合 `ui-baseline`，无需重新调试暗色模式与高对比度样式 |
| **UI 交互骨架** | `packages/dsh-skill-manager/client/client.js` | 传输层 `post`, 草稿状态机 `dirtyCount`, 底部操作栏 `actionBar`, 槽位注册器 | 标准的 5 槽位挂载体系与 ADR-0005 草稿提交模型 |
| **测试架构** | `packages/dsh-skill-manager/test/policy.test.js` | `fakeCtx` 模拟器、测试用例结构 | 原生 Node.js 测试体系与编译后断言范式 |

---

### (2) 必须针对 MCP 场景改写的地方

虽然策略架构与 UI 基调高度统一，但由于 MCP（Model Context Protocol）的独特性质，以下四个方面必须针对性重构与重写：

#### 1. 管理粒度与分层模型（Server 级 vs Tool/Resource 级）
- **现有实现**：
  - `dsh-skill-manager` 的颗粒度是单一 Skill（单个字符串 name）；
  - `dsh-plugin-manager` 的颗粒度是单个 npm 插件包（控制该包所有的 tools 与 sections）。
- **MCP 改写要求**：
  - MCP 具有天然的**双层结构**：第一层是 **MCP Server**（如 `unityMCP8081`, `joplin`），第二层是每个 Server 暴露的 **Tools / Resources / Prompts**（如 `mcp__unityMCP8081__batch_execute` 或 resource URI）。
  - 开关策略需要决定是仅在 **Server 级别** 提供开关，还是支持 **Server 级与 Tool/Resource 细粒度级** 双层控制。若支持细粒度控制，命令 op 与策略文件字段需要扩展 Server 命名空间。

#### 2. 生效通道与宿主接入机制（核心分水岭）
- **现有实现**：
  - Skill Manager 通过在 `agent.ctx.get('skills')` 注册相同名字的遮蔽副本（`invocation: { modelInvocable: false, userInvocable: true }`）使模型不可见；
  - Plugin Manager 通过 `agent.ctx.tools.restrict({ deny })` 施加工具掩码，并通过 `system-prompt/assemble` 剔除提示词段。
- **MCP 改写要求**：
  - DSH 宿主对 MCP 工具的挂载通常通过 MCP 客户端服务或前缀映射（如 `mcp__<server>__<tool>`）。
  - 若宿主已有专门的 MCP 运行时服务（需核验宿主是否有 `mcp` 实例或连接池管理），停用 Server 可能表现为断开连接/跳过初始化，或者同样通过 `agent.ctx.tools.restrict({ deny: [...] })` 批量屏蔽该 Server 下的所有工具名。必须根据宿主 MCP 模块实际暴露的 API 决定生效方式。

#### 3. 清单与配置发现源（Inventory & Configuration）
- **现有实现**：
  - Skill 清单通过 `skills.snapshot({ cwd, scope })` 动态获取；
  - Plugin 清单通过对 profile node_modules 的静态 AST 扫描生成静态 catalog 缓存。
- **MCP 改写要求**：
  - MCP Server 的定义通常来源于配置文件，例如全局的 `~/.dsh/mcp.json`、profile 配置或工作区级别的 `<cwd>/.dsh/mcp.json`（或工程级配置文件）。
  - MCP Manager 需要解析这些 MCP 配置文件，提取出 configured servers 列表，并通过宿主连接状态或工具注册表反查当前已探测到的 tools/resources 清单。对于未启动或连接超时的 Server，需要妥善处理「离线/探测中」状态。

#### 4. 实时连接状态展示（Live Connection State）
- **现有实现**：
  - Skill 和 Plugin 均为本地代码文件或模块，不存在长连接与网络延时，开关直接对应可用性。
  - 面板只有「开/关/关不掉（stuck）」三种状态。
- **MCP 改写要求**：
  - MCP Server 具有网络生命周期（如 stdio / sse 进程、HTTP/RPC 连接、心跳、ping 延时、错误退出码）。
  - UI 界面在展示开关的同时，通常需要展示该 Server 的连接状态标签（如 `Connected`, `Disconnected`, `Error`），甚至需要提供「重新连接（Reconnect）」按钮。这需要新端点支持（如 `/api/mcp-manager/reconnect`）或在全局/工作区视图中携带 live runtime 诊断信息。
