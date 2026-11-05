# 05 lazy 载体与 mcp_call 代理

Status: resolved
Type: task
Blocked by: 03

## 落地情况

- `lazy` 行的 `mcp_load` 不注册任何工具，只把过滤后的工具名与 inputSchema 作为结果返回，并登记在 per-agent 的加载表里。
- `mcp_call` 只在 `lazy` 行上工作：校验 server/tool，转发到池里的连接，`isError` 结果转成工具错误。
- 被过滤掉的工具在调用时同样拒绝（`admits` 二次校验）。
