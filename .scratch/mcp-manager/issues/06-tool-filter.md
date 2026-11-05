# 06 工具过滤

Status: resolved
Type: task
Blocked by: 04, 05

## 目标

allow/deny + 通配的规则语法与两处过滤点。

## 落地情况

- `src/filter.ts`：`parseToolFilter` / `admits` / `filterTools`。语义照搬社区实现：`*`/\`?\` 通配、其余元字符转义、锚定、大小写敏感、先 drop 后 keep、解析失败不过滤。
- `dynamic` 的过滤点已接上（`carrier.ts` 造定义前先筛）。
- `lazy` 的两处过滤点（`mcp_load` 返回、`mcp_call` 校验）等 05。

## 偏差

未做「`eager` 下 warn 规则不生效」与「全局行只读」两条：本插件的可见性走屏蔽路线，eager 行也能用 `restrict` 摘掉，所以那两条限制不成立。等 07 的 per-agent 路径落地后一起验。
