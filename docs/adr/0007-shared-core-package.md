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

抽出 `@dreanzy/dsh-pack-core`，**服务端半边共用**，**客户端半边走构建期生成**。四包继续各自发版、各自安装。

边界（服务端）：

| 进 core | 理由 |
| --- | --- |
| `cwd`（`projectedCwd` / `cwdFromAgent` / `cwdFromObserved`） | 四份逐字相同；语义已在根术语表的「会话目录」定死 |
| `reconcile` | 三份逐字相同，测试也一样 |
| `store` 的落盘骨架（原子写、`<cwd>/.dsh/<包名>.json`、`$DSH_HOME/<包名>/`） | 路径规则是四包共有的外部契约 |
| `policy` 的层 / 覆盖 / 跟随求值链 | plugin↔skill 0.90；各包的条目 schema 仍留在自己包里 |
| `effective` 的 `{ complete, rows, isOpen }` 骨架 | 三个包已同形，mcp 刚补齐 complete |
| `snapshot` 的缓存骨架（`read` / `refresh` / `invalidate` / `stats` 与键规则） | 两包形状一致，键规则各留参数 |
| 协议类型（`Envelope` / `ErrorCode` / 宿主 ctx 最小面） | 四份定义已经漂移（model 的 `ErrorCode` 少了 `'unknown-session'`） |

不抽：

- **`hooks`**：四份 Jaccard 0.04–0.10，是四套宿主接线，不是同一段代码。合并只会把四个适配器缝进一个文件。
- **`inventory` / `policy` 的条目 schema**：被管理对象不同（skill、插件贡献、MCP 行、模型路由）。
- **mcp 的 `carrier` / `pool` / `gate`**：只有 mcp 需要。
- **`tools`**：mcp 与 model 各一套，语义无关。

边界（客户端）：四份 `client.js` 是手写单文件，宿主不打包它，只能 `require('react')`。共享的只有队列、冻结排序、面板通用件与 i18n 表，**在构建期拼进各包的 `client.js`**，不做运行时跨包 `require`。

## 考虑过的替代方案

### 继续零共享（维持 ADR-0002）

代价已经可数：每加一条包间共享的不变式，就要写四遍、测四遍、改四处。ADR-0006 那次是四次提交，本次 D 组是四份 `cwd.ts` 与四份 `createQueue`。继续不抽不是省事，是把成本摊到每一次改动上。

### 只抽服务端，不碰客户端

工作量最小，但重复的大头在客户端（85%）。只做一半，热区第一的位置不会变。

### 客户端走运行时 `require` 另一个插件 row

宿主机制支持（`dsh.client.external` 解析到指定的动态包 row），但组合阶段会拒绝"缺失提供方"：core 没装或被禁用时，四个面板一起起不来，浏览器端直接抛 `cannot resolve … not a row in the boot graph`。这正好踩在客户端红线上，因此否掉。

### 一次性把四包合成一个包

ADR-0002 已否掉一次，理由不变：只想管 skill 的人不该被迫跟 MCP 的版本走。本次决定不改变各包的发版粒度。

## 后果

- 四包各加一条依赖。**普通安装写 `dependencies` 就够**：解析锚点是 profile 根，core 会落到 `~/.dsh/profiles/<name>/node_modules` 顶层，四包都能原生解析，用户无需额外操作。
- **开发期 link 要写 `peerDependencies`**：宿主认符号链接（symlink 走 linked 层，带 realpath 规范化与前缀白名单），但只有包名出现在插件的 `peerDependencies` 里才走拦截路由，否则按原生解析。
- **发布不能留 `workspace:` 协议**：`scripts/release.mjs` 走 `npm publish`，npm 不认这个协议；ADR-0001 记的死因（用户从 git 子目录安装时 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）也是同一个根因。依赖一律写真实 semver，本地靠 pnpm 的 workspace 链接行为。
- **源码安装仍然要求 core 先发版**：`github:<owner>/<repo>#<sha>&path:/packages/<pkg>` 会解析包的 `dependencies`，core 没发布就装不上。这是抽包的真实代价，不是可以绕过的细节。
- **entry id 与包名都不能撞**：同 id 的 Loader 条目会被静默复用覆盖（`store[id] ??=`），两个 active 来源解析到同一包名会让客户端组合失败。
- **客户端构建多一步**：生成式拼接必须挂在发布前，否则 `client.js` 缺一段。仓库原本的"避免第二套构建链"因此让步，但换取的是单文件形态不变、宿主机制不变。
- 五个 manager 的 `ops` 表（D5）的形态随之确定：服务端的 union / OPS / 校验器 / apply 分派进 core，客户端的 `pendingKey` 由同一张表在构建期生成，不再手写第四份。
- **重新审视的条件**：若 core 的接口开始因为四包需求被迫长出开关参数（而不是收窄），说明边界切错了，应退回按包拆分。

## 参考

- [ADR-0001](./0001-multi-bundle-monorepo.md)：多包单仓、`workspace:` 的实测失败。
- [ADR-0002](./0002-keep-workspace-plugins-separate.md)：本决定推翻其"零共享"结论，保留其"各自发版"部分。
- `GLOSSARY.md`：会话目录、生效视图、工作区、pack、层、跟随、覆盖、求值链。
