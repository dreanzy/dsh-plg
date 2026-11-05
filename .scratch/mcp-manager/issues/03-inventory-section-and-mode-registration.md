# 03 名册段渲染与出版

Status: resolved
Type: task
Blocked by: 01, 02

## 目标

`dynamic`/`lazy` 行在系统提示里出版的服务器名册。工具注册与连接池拆到 04。

## 范围

- `src/inventory-section.ts`：`renderInventory` 纯函数，单条 80 字符、整段 900 字符预算，只削描述不删名字。
- `src/state.ts`：同步快照 + 异步重算的缓存层，因为 `section.text` 在装配时同步求值。
- `src/index.ts`：注册 `systemPrompt.section`（序位取 `MCP_SERVERS`，`interpolate: false`），`/apply` 写入后重算。
- 策略层加 `description` 字段（工作区层与全局层都可写）。

## 偏差说明

导语不按模式分叉：名册是**一段**文本，而每行各有模式，按模式分叉会在混合配置下说错话。改为一次说全三条路径（`mcp_load` / `mcp_unload` / `mcp_call`），具体某台怎么调由 `mcp_load` 的结果再说一遍。

## Answer

已完成，33 项单测全绿。

产出：
- `src/inventory-section.ts`、`src/state.ts`、`test/inventory-section.test.js`、`test/plugin.test.js`。
- 名册段注册在 root ctx（所有 agent 共享，只按全局层求值）；按工作区差异化留给 07。
- `RowPolicy` 增加 `description`，四字段独立求值。

已知边界：
- 名册段是全局段，因此**暂时**忽略工作区层；07 改成 per-agent 注册后才按工作区不同。
- `eager` 行不进名册（工具已经在请求里）。
