# 复盘：工作区可见性为什么反复失效

2026-11-05。现象：在 Naraka 工作区把 MCP server 设为启用，会话里却看不到、`mcp_load` 报
`unknown or disabled`。前后修了五轮才通。

## 根因是同一个模式的五个变体

「按工作区区分」这条语义在代码里有**多条实现路径**，每一轮只修了被观察到的那一条：

| # | 路径 | 缺陷 | 表现 |
|---|---|---|---|
| 1 | root 名册段 + per-agent 名册段 | 两段同名，宿主禁止同层重复注册 | `already registered in this scope`，段全部失效 |
| 2 | reconcile 的注册/释放顺序 | 先注册后释放，同名必冲突；抛错后旧 disposer 丢失 | 每次重算都把段弄没 |
| 3 | per-agent 视图的 `load` | 漏传 `owned`，托管 server 从不并入 | 名册空、`mcp_load` 查不到 |
| 4 | `mcp_load` 的目标查表 | 只用 root state，只读全局层 | 工作区启用、全局禁用时永远 `unknown` |
| 5 | 保存后的刷新 | 只刷 root，不刷 per-agent | 改完要重启才生效 |

三条视图路径（root state、per-agent state、routes 的 buildView）都调 `mergeOwnedRows`，
但只有两条传了 `owned`；`cwd` 的求值同理，只有部分路径带了对的 cwd。

## 为什么一轮轮没修到点子上

**诊断信息是按需生成的，不是常驻的。** `diag.json` 只在启动和 `/diag` 请求时写，而
`/diag` 又需要浏览器凭据（桌面版的 HTTP 走 `dsh-app://` 协议，命令行打不通）。于是每次都要
请用户手动打开面板、复制 JSON，一轮只能验证一个假设。

后来加了 `onSettled`（每次 agent 落地就刷新快照）与 `sectionError`（记录段注册失败的原话），
定位速度才上来——**错误信息从「看起来没生效」变成「already registered in this scope」**，
一句话就指向了根因。

## 三个宿主行为，没写在公开文档里

1. `systemPrompt.section()` 在**同一层**内禁止同名段重复注册，抛错且不留旧句柄。
2. `ctx.get('agents')` 在插件 `apply` 那一刻常常还没就绪，直接调用会拿到 `undefined`；
   必须包在 `context.inject(['agents'], …)` 里。
3. 工具执行时拿到的 `exec.agent` 与 `agent/created` 里那个，**未必是同一个对象实例**。
   用 `WeakMap` 按对象身份索引会落空，必须准备 id 兜底。

## 教训

1. **一条语义只留一个构造入口。** `owned` 合并、`cwd` 求值、策略求值这三件事，只要
   存在第二条实现，就一定会分叉。视图构造应收成一个函数，参数由调用点显式传入，
   而不是每个调用点各自拼装。
2. **诊断要在失败现场留下证据。** 能在进程内记录的状态（注册结果、失败原文、视图行数）
   不要等用户复现；落盘比看日志便宜。
3. **写入必须可验证。** 这一轮里有多次「以为改了其实没改」（`String.replace` 找不到锚点
   时静默返回原文），每次都要靠断言兜住——改完立刻回读，检查关键字命中。
4. 宿主升级后要复验的三条：`Entry.disabled` 遮蔽顺序、`systemPrompt.section` 的同层约束、
   `exec.agent` 的身份稳定性。
