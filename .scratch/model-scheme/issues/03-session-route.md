# 03 新会话模型注入

Status: ready-for-agent
Type: task
Blocked by: 02

## 目标

`agent/created` 时按 cwd 求值方案，把会话路由写进该会话。

## 范围

`src/hooks.ts`：订阅 `agent/created`，按 spec §6.1 的过滤与顺序执行。只在 source 为 startup、origin 不是 subagent、cwd 存在、方案有会话路由、且 `agent.model.current()` 无 pending/lastUsed 时调 `agent.model.select()`。

监听器整段 try/catch，失败只 `logger.warn` 并写入内存 lastError（带原始错误文本）。登记 `agent/disposed` 清理。

## 验收

`test/hooks.test.js`：source 为 resume 时不调 select；origin 为 subagent 时不调；无 cwd 不调；已有 lastUsed 不调；正常路径调一次且参数逐字段相等。抛错路径不影响 create。

## 边界

不注册工具、不注入提示词段（那是 04、05）。