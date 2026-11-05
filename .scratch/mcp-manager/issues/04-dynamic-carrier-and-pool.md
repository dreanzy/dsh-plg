# 04 连接池、native 载体与按需工具

Status: resolved
Type: task
Blocked by: 02, 03

## 目标

宿主级常驻连接池 + `dynamic` 的原生注册 + `mcp_load`/`mcp_unload`。

## Scope 落地情况

- `src/mcp-connection.ts`：SDK 直连；stdio 子进程环境先剔除凭证形状与 `DSH_*` 变量再叠加声明里的 env。
- `src/pool.ts`：键 = 行键；并发首次 acquire 只连一次；引用计数，最后一个释放才 close；连接或列工具失败时删槽位并关闭已建连接。
- `src/carrier.ts`：`buildNativeDefinitions` 只造定义不注册；被过滤掉的工具根本不造定义。
- `src/public-name.ts`：逐字复刻宿主命名契约（64 字符、非法字符替换、有损时附 12 位 SHA-256）。
- `src/tools.ts`：`mcp_load`/`mcp_unload`；注册落在 `agent.ctx.get('tools')`；注册失败整代回滚并释放连接；重复加载先释放上一代。
- `src/adapter.ts`：经 `loader.internal.import` 取 `defineTool` 与 `createMcpToolDefinition`，取不到 fail loud。

## 顺带补上的缺口

`McpRow` 原本只保留定义摘要，无法构造连接参数。已加 `config` 字段保存原始配置，并在 `state.ts` 里做 `connectionSpecOf`。

## 未验证

`loader.internal.import` 的调用形状与 `createMcpToolDefinition` 的导出，只按宿主源码推断，未在真实实例上跑过。首个待验点。
