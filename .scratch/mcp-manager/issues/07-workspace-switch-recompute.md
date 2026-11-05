# 07 按 agent 落地与工具屏蔽

Status: resolved
Type: task
Blocked by: 02, 04

## 目标

`agent/created` 时按该 agent 的 cwd 求值策略，并让 `dynamic`/`lazy` 行的工具对模型不可见。

## 落地情况

- `src/hooks.ts`：`agent/created` 时在自己的 `agent.ctx` 上注册名册段（scoped 段遮蔽 root 兜底段），并对非 `eager` 行调用 `tools.restrict({ deny })`。
- `src/shield.ts`：`denyNamesFor` 按 `mcp__<server>__` 前缀从 `view(agent).restrictableNames` 里挑名字。
- `agent/disposed`：释放段、解除限制、`releaseAgent`。
- `working-directory/change`：重算该 agent。
- `agent/created` 之后 1.5 秒补一次重算：`mcp-client` 是异步连上才注册工具，创建那一刻全局工具表常常还是空的。

## 关键发现

`ToolsService.view(scope)` 里，**scope 自己的注册不受 restrictions 影响**（`own.tools.entries()` 直接并入 visible）。所以「全局层被罩住、`mcp_load` 注册的同名工具可见」是宿主原生保证的分层，不需要跟 Loader 抢生命周期。

## 偏差

原计划的「启动零进程」没有实现：现在进程照起，省的是上下文与可见性。Loader 拦截依赖私有事件，另行评估。
