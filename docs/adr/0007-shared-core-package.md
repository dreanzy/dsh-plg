# 抽一个共享核心包，四个插件各自发版

## 背景与决定

[ADR-0002](./0002-keep-workspace-plugins-separate.md) 决定"三包保持独立发行，只共享词汇"，并留了一个触发条件：**等第四个 manager 出现再抽共享包；届时先解决 `workspace:` 或改为构建期生成**。现在两条都成立，而且当年用来否掉抽包的量化前提已经不成立。

### 当年的估计

ADR-0002 记的是"重复的基础设施约 150 行，对三包 13672 行约 1%"，因此否掉了抽包。

### 现在的实测（2026-11-10）

- **单个包的重复不是 1%**：`dsh-skill-pack/client/client.js` 的 1313 条长行里，1113 条（85%）与 `dsh-plugin-pack` 逐字相同、1077 条（82%）与 `dsh-mcp-pack` 相同。
- **同一个接口被写了四遍**：`policy.ts` 在 plugin 与 skill 之间行集合 Jaccard 0.90，注释 47 条里 41 条共享；`reconcile.ts` 三份 Jaccard 0.93–1.00，连函数位置都一样（`:8` `Dispose`、`:20` `createReconciler`）；`store.ts` 0.52–0.68。
- **热区就在重复处**：近 80 次提交里，四份 `client.js` 被改 16 / 15 / 13 / 10 次，是仓库第一热区。
- **一次改动四处修已经发生过**：待保存改动（[ADR-0006](./0006-pending-changes-before-commit.md)）由四个独立提交分别实现（`e2b4736`、`40b1342`、`c73f25a`、`9723e57`）。
- **深化动作本身在生产重复**：2026-11-10 的 D 组复审里，`cwd.ts` 写了三份（连同 skill 已有的 `projectedCwd` 共四份）、`createQueue` 四份、`frozenGroupNames` 三份。零共享的代价现在可数，不再是估算。

### 决定

抽出 `@dreanzy/dsh-pack-core`，**服务端半边共用**；**客户端半边只共享规则，由测试锁死**。四包继续各自发版、各自安装。

边界（服务端）：

| 进 core | 理由 |
| --- | --- |
| `cwd`（`projectedCwd` / `cwdFromAgent` / `cwdFromObserved`） | 四份逐字相同；语义已在根术语表的「会话目录」定死 |
| `session`（`resolveSession` / `RouteContext` / `SessionResolution`） | 三份逐字同构，skill 那份已漂移成内联 cwd 解析；`observeSession` 的释放纪律漏一次就是长期泄漏 |
| `reconcile` | 三份逐字相同，测试也一样 |
| `store` 的落盘骨架（原子写、`<cwd>/.dsh/<包名>.json`、`$DSH_HOME/<包名>/`） | 路径规则是四包共有的外部契约 |
| `store` 的写事务（`transact` / `previewText` / `writableReason`） | 四份骨架逐字相同，只有失败约定不同；试算与真写共用同一条前置判定，否则预览会显示一个永远不会发生的状态 |
| `policy` 的层 / 覆盖 / 跟随求值链 | plugin↔skill 0.90；各包的条目 schema 仍留在自己包里 |
| `ops` 的命令协议骨架（`OpSpec` / `OpTable` / `parseCommands` / `filesOf` / `MAX_COMMANDS`） | 四份 `parseCommands` 骨架逐字相同；`OpSpec` 的六个字段也各声明一次。加一个 op 要同步四个文件 |
| `effective` 的 `{ complete, rows, isOpen }` 骨架 | 三个包已同形，mcp 刚补齐 complete |
| `snapshot` 的缓存骨架（`read` / `refresh` / `invalidate` / `stats` 与键规则） | 两包形状一致，键规则各留参数 |
| 协议类型（`Envelope` / `ErrorCode` / 宿主 ctx 最小面） | 四份定义已经漂移（model 的 `ErrorCode` 少了 `'unknown-session'`）。`RouteContext` 本身三份逐字相同，随 `session` 一起进 core |
| `routes` 的注册骨架（`toResponse` / `wrap` / `readFetchFace` / `registerRoutes`） | 四份逐字相同，而「HTTP 恒 200、信封 code 一致」这条不变式原先只写在四份注释里，没有任何测试守护——mcp 的原型链 op 报 `internal` 就是这么漏掉的 |

不抽：

- **`hooks`**：四份 Jaccard 0.04–0.10，是四套宿主接线，不是同一段代码。合并只会把四个适配器缝进一个文件。
- **`inventory` / `policy` 的条目 schema**：被管理对象不同（skill、插件贡献、MCP 行、模型路由）。
- **mcp 的 `carrier` / `pool` / `gate`**：只有 mcp 需要。
- **`tools`**：mcp 与 model 各一套，语义无关。
- **写循环（一批命令命中多个文件时的顺序与短路）**：skill 与 model 不短路（一个文件失败仍写其余），plugin 与 mcp 短路。这是各包的语义选择，不是重复代码——skill 的「先写 groups 再写 packs」有具体的 fail-open 理由。core 只提供单文件的 `transact`，循环留在包里。
- **字段级前置校验**：plugin 的 `brokenReason` 会逐字段查 `packs.items` 的值是不是布尔，那是它的领域知识。core 只提供最松的一档（JSON 合法 + 顶层是对象），plugin 在 `mutate` 之前自己再查一遍。

边界（客户端）：四份 `client.js` 是手写单文件，宿主不打包它，只能 `require('react')`。队列键这类**规则**放进 core（`PENDING_KEY_RULES`），客户端的实现仍是复制品，但四个包的 `test/client.test.js` 逐 op 比对两边结果，漂移会让用例直接失败。面板组件要不要共享，等真的改四遍、且出过一次不一致再谈构建期拼接——不提前引入第二套构建链。

## 考虑过的替代方案

### 继续零共享（维持 ADR-0002）

代价已经可数：每加一条包间共享的不变式，就要写四遍、测四遍、改四处。ADR-0006 那次是四次提交，本次 D 组是四份 `cwd.ts` 与四份 `createQueue`。继续不抽不是省事，是把成本摊到每一次改动上。

### 只抽服务端，不碰客户端

工作量最小，但重复的大头在客户端（85%）。只做一半，热区第一的位置不会变。

### 客户端走运行时 `require` 另一个插件 row

宿主机制支持（`dsh.client.external` 解析到指定的动态包 row），但组合阶段会拒绝"缺失提供方"：core 没装或被禁用时，四个面板一起起不来，浏览器端直接抛 `cannot resolve … not a row in the boot graph`。这正好踩在客户端红线上，因此否掉。

### 一次性把四包合成一个包

ADR-0002 已否掉一次，理由不变：只想管 skill 的人不该被迫跟 MCP 的版本走。本次决定不改变各包的发版粒度。

### 抽 `dsh-ui-kit` 共享面板样式

`docs/ui-baseline.md` 说「两个面板各有一份 `T` / `S`，约 200–290 行，几乎逐行相同」，并留了触发条件：等界面基调连续两次改动不再变动再抽。

实测（2026-11-17）：四份 `T` 的键交集只有 7 个（并集 16），`S` 的键交集 73 个（并集 113）。**不是「几乎逐行相同」，是「骨架相同、细节各自演化」**。抽 `T` 的 7 个键收益太小；抽 `S` 的 73 个键会把「哪些键该共享」这个还没定的事固化下来。触发条件未满足，暂缓。

### 删掉 `mcp/state.ts` 与 `plugin/capabilities.ts`

两个模块的 interface 与 implementation 几乎等高，删除测试说它们是 pass-through。但：

- `state.ts` 的 `target()` 有 6 行大小写兜底（「模型会把名字写成小写，而 serverName 是大小写敏感的」）。并进 `snapshot` 会让它的 interface 从「读缓存」变成「读缓存 + 名字匹配」，那是把 seam 画错。
- `capabilities.ts` 的 66 行虽然浅，但注释解释了「一旦确认支持就不再回退」这条纪律，删了要重新找地方放。

收益小、风险中等，不做。

## 后果

- 四包各加一条依赖。**普通安装写 `dependencies` 就够**：解析锚点是 profile 根，core 会落到 `~/.dsh/profiles/<name>/node_modules` 顶层，四包都能原生解析，用户无需额外操作。
- **开发期 link 要写 `peerDependencies`**：宿主认符号链接（symlink 走 linked 层，带 realpath 规范化与前缀白名单），但只有包名出现在插件的 `peerDependencies` 里才走拦截路由，否则按原生解析。
- **发布不能留 `workspace:` 协议**：`scripts/release.mjs` 走 `npm publish`，npm 不认这个协议；ADR-0001 记的死因（用户从 git 子目录安装时 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）也是同一个根因。依赖一律写真实 semver，本地靠 pnpm 的 workspace 链接行为。
- **源码安装仍然要求 core 先发版**：`github:<owner>/<repo>#<sha>&path:/packages/<pkg>` 会解析包的 `dependencies`，core 没发布就装不上。这是抽包的真实代价，不是可以绕过的细节。
- **entry id 与包名都不能撞**：同 id 的 Loader 条目会被静默复用覆盖（`store[id] ??=`），两个 active 来源解析到同一包名会让客户端组合失败。
- **客户端仍是复制品**：规则只有一份（core 的表），实现有四份。守护靠测试而不是生成：改 core 会让四包用例变红，改客户端那份同样。代价是每加一个 op 要动一次客户端；收益是不给手写单文件加构建链。
- 五个 manager 的 `ops` 表（D5）：骨架在 core，四包各自提供 `parse` 与 `apply*` 的 adapter。`OpSpec.key` 已删——它全仓零消费点，队列键由 core 的 `pendingKeyOf` 直接查表；客户端的 `pendingKey` 以 `PENDING_KEY_RULES` 为单一真源，由测试守护。
- **`apply*` 的批处理语义留在包里**：skill/plugin/mcp 的 `OpSpec.apply*` 是「一条命令一次」，model 的 `applyTo*` 是「一次遍历处理整批」。core 只收 `parse` 与 `files`，不强行统一批处理。
- **`ROUTES` 常量留在包里**：路径是各包对外的 API 契约，写死比生成更清楚——`/api/skill-pack/global` 一眼能看出是哪个包的哪个路由。`registerRoutes` 只保证 `routes` 与 `handlers` 同键不错位。
- **`resolveSession` 的 null 语义仍归各包**：mcp 的 `handleApply` 在解析不出会话时拒绝写入，skill 与 plugin 继续写入并降级为全局视图。这是行为差异，不是重复代码，core 只负责「sessionId → 结论」，null 之后怎么用由调用方决定。
- **求值链的显示态归服务端**：`rank` / `landing` / `groupGlobal` / `groupWorkspace` / `diff` / `groupRanks` 由 `effective` 算好，客户端只渲染。`rank` 的取值是 `'explicit-on' | 'explicit-off' | 'follow-on' | 'follow-off'`，不是数字——数字在代码里没有注释，读的人要靠注释才知道 `2` 是「跟随且落到开」。`check-panels.mjs` 的 `mustNot` 守着客户端不再写一遍 `rankOf` / `diffOf` / `itemValue` / `groupValue` / `rowOpen`。
- **`bind` 的队列键两边语义不同**：客户端按归一化后的 cwd 算（渲染处也按它查），服务端 `pendingKeyOf` 按原值算（归一化发生在落盘时）。其余 op 两边必须逐字相同，由四份 `test/client.test.js` 逐 op 比对。
- **重新审视的条件**：若 core 的接口开始因为四包需求被迫长出开关参数（而不是收窄），说明边界切错了，应退回按包拆分。

## 参考

- [ADR-0001](./0001-multi-bundle-monorepo.md)：多包单仓、`workspace:` 的实测失败。
- [ADR-0002](./0002-keep-workspace-plugins-separate.md)：本决定推翻其"零共享"结论，保留其"各自发版"部分。
- `GLOSSARY.md`：会话目录、生效视图、工作区、pack、层、跟随、覆盖、求值链。
