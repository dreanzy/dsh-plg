# 01 插件骨架与只读行发现

Status: resolved
Type: task
Blocked by: 无

## 目标

建立 `packages/dsh-mcp-manager` 骨架，实现从 Loader 读出现有 `@deepseek-ai/dsh-mcp-client` 行并只读展示。不碰拦截、不碰注册、不碰模式。

## 范围

- 新建包骨架：`package.json`（`@dreanzy/dsh-mcp-manager`、entry id `dsh-mcp-manager`）、`cordis.patch.yml`、`tsconfig.json`。
- `src/types.ts`：行、loader 面、配置的类型。
- `src/inventory.ts`：遍历 `loader.entries()`，筛选 mcp-client 实例，提取 `serverName`/`transport`/定义摘要与来源。
- `src/index.ts`：`apply` 挂一个只读路由 `/api/dsh-mcp-manager/rows`，Envelope 信封，HTTP 恒 200。
- `test/inventory.test.js`：fake loader，覆盖 htt/stdio 两种配置、include 子树递归、非 mcp-client 行忽略。

## 验收

- `pnpm --filter @dreanzy/dsh-mcp-manager typecheck` 通过。
- `pnpm --filter @dreanzy/dsh-mcp-manager test` 通过。
- 路由返回的行里带 `rowKey`、`serverName`、`transport`、`source`、`readOnly`。

## 边界

- 判据按模块名判 include 树，**不得**探测 `write()`（issue #6 根因）。
- 读操作无锁；不写任何文件。
## Answer

包骨架与只读行发现已落地，20 项单测全绿（含 02 的策略层）。

产出：
- `packages/dsh-mcp-manager/{package.json,cordis.patch.yml,tsconfig.json}`，包名 `@dreanzy/dsh-mcp-manager`，entry id `dsh-mcp-manager`。
- `src/types.ts`、`src/inventory.ts`：遍历 `loader.entries()`，识别 `@deepseek-ai/dsh-mcp-client` 的 entry，抽出 `serverName`/`transport`/定义摘要与来源。
- `src/index.ts`：注册四条路由，Envelope 信封，HTTP 恒 200。
- 判据只读 `options.name` 与树的 `filename`，**不探测 `write()`**。

关键实现说明：
- `EntryTree.entries()` 自己递归进 `entry.subtree`，include 文件里的行无需额外展开。
- rowKey 按来源前缀：托管文件里的行是 `own:`，其余是 `global:`。
- 形状不认识的配置跳过并记 warning，不猜测。
