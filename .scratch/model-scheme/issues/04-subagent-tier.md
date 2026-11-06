# 04 subagent_tier 工具与备选推进

Status: ready-for-agent
Type: task
Blocked by: 02

## 目标

单一委派工具 `subagent_tier`，按档位路由委派，首选失败前进到备选。

## 范围

`src/tools.ts`。定义 `subagent_tier(tier, prompt, label?, cwd?)`，tier 为枚举；execute 按 spec §6.2 五步。在 `agent/created` 里从 `agent.ctx` 取 tools 注册到该 agent 作用域，注册成功后再 `tools.restrict({ deny: ['subagent'] })`；注册失败时不 deny。

能力探测：subagents 服务存在、startActivation 是函数、provider.capabilities.agentOptions 为 true。任一不满足则不注册、不 deny。

## 验收

`test/tools.test.js` 用替身服务：正常路径调 startActivation 且 agentOptions 等于该档首选；resolveCallConfig 抛错时换下一条；全不可用时返回错误结果而非抛出；注册抛错时 restrict 未被调用。

## 边界

不改官方工具；不实现 fork；不处理 maxDepth（沿用 Host 设置）。