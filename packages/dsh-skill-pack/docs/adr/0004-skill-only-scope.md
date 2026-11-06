# 只管理 skill，不管理 MCP

## 背景与决定

社区实现 dsh-skill-scope 同时管 skill 与 MCP。本包只管 skill。

MCP 一侧在 DSH 里没有干净的收窄点：ACP 每会话 MCP 注册在 agent 的 own 层，而 `restrictableNames` 只含继承来的工具名，own 层永远遮不住；另有同层 first-wins 竞争，别的插件先把同名工具注册进同一层时，后注册的收窄会失效。更实际的是，本机已有 `@guowenzhang/dsh-mcp-manager` 负责 server 的增删改、按需加载与工具过滤，作用域是 global 平面与 agent preset。再做一个按目录的 MCP 层，等于和它抢同一块地。

因此 MCP 的可见性交给 mcp-manager 的 per-row switch 与 agent preset 分流。

## 考虑过的替代方案

- **两者都做**：功能对齐社区实现，但要背下 own 层不可收窄这个硬伤，且与 mcp-manager 的功能重叠。
- **留一个将来单独做 MCP 工作区插件的计划**：不排除，但不是本包的范围。

## 后果

- 卸载 dsh-skill-scope 后，MCP 失去按目录的开关能力，粒度从目录退到 agent preset。
- 整条 MCP 分支不实现：`mcp__<server>__<tool>` 前缀解析、`restrict` 收窄、loader 行交叉校验、server 名最长前缀匹配。
- 两层策略文件因此同形（都只有 items 与 groups），求值可写成对层的统一折叠，不必为两个域各写一份。
