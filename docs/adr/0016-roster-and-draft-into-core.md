# 名册与草稿进核心：ADR-0007 边界的延伸

## 背景与决定

[ADR-0007](./0007-shared-core-package.md) 把「四个 pack 插件共用的服务端骨架」收进 `@dreanzy/dsh-pack-core`，同时明确把**条目 schema** 留在各包，理由是「被管理对象不同（skill、插件贡献、MCP 行、模型路由）」。

那一轮没有覆盖到的是条目**之外**的两段：

1. **读侧框架**。三个包的 `parsePacks` 逐行相同：读 JSON、判顶层、按 id 排序、`MAX_NAMES` 截断、空 id 跳过、`default` 缺席时补一个空 pack 并留 warning。它与「条目长什么样」无关。
2. **写侧草稿辅助**。`setKey` / `findPack` / `assertNameFree` / `nextPackId` / `copyName` / `assertPackRoom` / `nextGroupId` 在三包各一份；`requireName` 与 `groupNameOf` 同样。

判断依据不是行数，而是 2026-11-26 的事实核查结果：**三份副本各自只管住了一处纪律，没有一份是完整的。**

| 纪律 | skill | plugin | mcp |
| --- | --- | --- | --- |
| 写 pack 键用 `defineProperty` | 有 | 无 | 无 |
| 写能力项键用 `defineProperty` | 无 | 有 | 无 |
| 取 pack 用 `Object.hasOwn` | 无 | 有 | 无 |
| 名字上限（64 字符）与控制字符拒绝 | 有 | 无 | 无 |
| `clonePack` 深拷 `tools` 数组 | 无（形状没有该字段） | 无 | 有 |

删掉任意一份，它独有的那条防护随之消失。这是复制品结构的必然结果，不是某次改动的疏忽。因此决定：

**新增两个模块，把上面两段收进 core。**

- `roster.ts`：`parseRoster(text, deps, config)` 收框架，`parsePack` 与 `parseUi` 由调用方以回调注入；`packViews` 返回中性结构 `{ id, name, row, builtin }`，值域字段（`items` / `rows`）由各包自己取。
- `draft.ts`：七个纯操作 + `requireName`。`setKey` 与 `findPack` 的分叉是纪律碎片，合并成三份里最严的一种；`assertPackRoom` 的 `maxNames` 改由调用方传入。

同时统一名字校验：plugin 与 mcp 从此也拒绝超过 64 字符、含控制字符的 pack 名与组名。

不抽的两处：

- `clonePack`：mcp 那份要深拷 `rows` 里每行的 `tools` 数组，skill 与 plugin 是布尔表浅拷。差异来自数据结构，不是纪律。
- `groupNameOf`：它只是从命令里取一个字段，校验已经由 `requireName` 统一，剩下两行留在包里读起来更直。

## 考虑过的替代方案

**维持三份，用测试锁死一致。** 这是 ADR-0007 对客户端的选择：规则进 core，实现仍是复制品，靠四份 `client.test.js` 逐 op 比对。否掉，因为客户端那条选择有一条硬约束——宿主不打包 `client.js`，浏览器半边走不了服务端模块。服务端没有这条约束，复制品唯一的产物就是上面那张表：四条纪律散在三处。

**只收读路径，草稿辅助留包内。** 否掉：读路径确实更干净，但四条纪律里有三条在写侧。只做一半，等于保留了这个候选最主要的收益。

**连 `clonePack` 一起收，用可选参数区分深拷。** 否掉：ADR-0007 的重新审视条件写着「若 core 的接口开始因为四包需求被迫长出开关参数（而不是收窄），说明边界切错了」。为一个字段的深拷加开关，正是那句话指的形状。

## 后果

- **行为变化**：plugin 与 mcp 的用户从此无法创建超过 64 字符的 pack 名或组名，粘贴含控制字符的文本会被拒。这是本轮唯一用户可见的变化，`scripts/e2e.mjs` 有「超长 pack 名被拒且带说明」与「超长名字未落盘」两组断言守着。
- 三包的 `parsePacks` 退化成一行调用；`packViews` 各自多出 6 行映射，把 `row` 里的值域字段搬进面板契约。
- `packViews` 返回中性结构后，**HTTP 响应的字段名不变**（仍是 `items` / `rows`）：映射发生在服务端路由层，客户端不感知。
- `setKey` 变成泛型 `setKey<T>(map, key, value)`；三包的调用点传布尔值，类型推断不需要显式参数。
- `assertPackRoom(packs)` 变成 `assertPackRoom(packs, maxNames)`，调用点各加一个实参。
- 新增两个术语：**名册框架**与**草稿操作**，见 [GLOSSARY.md](../../GLOSSARY.md)。
- core 升 `0.3.0`（新增导出为 minor），三个调用方包升中版本；`model-pack` 不使用这两组导出，不动。
- 已知局限：`model-pack` 的 `packs[id]` 写入同样是裸赋值（`policy.ts` 六处），本次未改——它的写侧是另一套 `applyTo*`，不在本候选的证据范围内。下次动它时按同一张表处理。

## 参考

- [ADR-0007](./0007-shared-core-package.md)：定义了 core 的第一版边界，本文是其延伸。
- [ADR-0012](./0012-reconciler-release-before-build.md)：同样是「三份不同语义，不强行统一」的判据。
- `GLOSSARY.md`：名册框架、草稿操作、共享核心。
