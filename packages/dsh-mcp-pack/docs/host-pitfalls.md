# 宿主行为陷阱

记录本插件依赖、但不在 DSH 公开文档里的行为。每条都是踩过之后实测确认的，改动相关代码前先看这里。

基准：DSH `0.2.2-rc.1`。

## `loader.internal.import` 必须保住接收者

它内部要读 `this.getOrCreateModuleJob`。解构出来单独调用会把 `this` 变成 `undefined`，报
`Cannot read properties of undefined (reading 'getOrCreateModuleJob')`。

正确写法是 `.call(internal, name, baseUrl, {})`。这类错误用简单替身永远测不出来——替身里没有 `this` 依赖。

## `client.callTool` 的第二参数是 zod result schema

`callTool(params, resultSchema?, options?)`。把 `{ timeout, signal }` 塞进第二参数，SDK 会去调
`resultSchema.safeParse`，报 `v3Schema.safeParse is not a function`。options 必须放**第三个**参数。

宿主 `dsh-mcp-client` 的源码里写法不同，那是它绑定的 SDK 版本不同——照抄会踩坑。

## `Entry.disabled` 是原型 getter

要摘掉一行，先在**实例**上 `Object.defineProperty(entry, 'disabled', { value: true })` 遮蔽它，再
`fiber.dispose()`。顺序反了，Loader 的 `internal/plugin` 自处置分支会执行
`entry.options.disabled = true` 并 `tree.commit()`，**把闸门状态写回用户的配置文件**。

遮蔽后 Loader 读到「已 disabled」就直接 return，不写文件。恢复时 `delete` 自有属性即可。

## 槽位 id 的两条相反规则

- 不同槽位之间：id **必须互不相同**，宿主按 id 去重，同 id 时后注册的被静默丢弃。
- `sidebar.panellist` 的 id 与 `main` 的 `key`：**必须相同**，宿主靠它把图标与面板配对。

两条规则方向相反，改一处很容易漏另一处，症状分别是「按钮点了没反应」和「图标点了没反应」。

## `defineTool` 的 schema 不是普通 JSON Schema

`parameters` 是属性映射，属性级用 `required: true`；`output.schema` 是值 schema，**不能**带
`required`。任何 `type: 'object'` 都必须显式写 `additionalProperties`，否则编译期就报错。

## `systemPrompt.section()` 在同一层内禁止同名重复注册

注册失败会抛 `prompt section "…" is already registered in this scope`，而且**不保留旧句柄**。
所以重算时必须先释放旧段、再注册新段；顺序反了，一次重算就把段弄没。

同理，不要在 root ctx 上注册一份「兜底段」再让每个 agent 注册同名段——root 段与 agent 段
若落在同一层，后者永远注册不上。

## `ctx.get('agents')` 在 apply 时可能未就绪

插件 `apply` 那一刻 `agents` 服务常常还没注册，直接 `get` 拿到 `undefined`，容易静默
放弃。要补历史会话，必须写成 `context.inject(['agents'], () => …)`。

## Streamable HTTP 的 session 归服务端，SDK 不会自愈

`StreamableHTTPClientTransport` 在 `initialize` 时拿到 `Mcp-Session-Id`，此后每个请求都带上它。
**session 的所有权在服务端**：空闲超时（mcp-for-unity-server 是 30 分钟）后服务端直接丢弃，
之后所有带旧 id 的请求返回 404 与 `Session not found`。

SDK 对此**不做任何处理**：不清 `_sessionId`、不触发 `onclose`、不重连。后果是
`connection.alive()` 一直报「活着」，池一直把这条死连接交出去，每次调用都失败，
直到进程重启。实测（`test/session-recovery.test.js`）：

```
DELETE (simulate idle timeout) -> 200
alive() after server reclaimed session = true
call after reclaim #1 -> ERROR: ... "Session not found"
```

**第二类同样不会自愈：传输层断了。** HTTP 没有长连接，服务端进程挂掉时客户端这边
什么都不会发生——`onclose` 不触发、`alive()` 一直报活着，下一次请求才报 `fetch failed`
（`cause.code` 是 `ECONNREFUSED` 一类）。实测：

```
服务端进程已杀
alive() = true          ← onclose 不触发
mcp_call -> ERROR: fetch failed
mcp_call -> ERROR: fetch failed   ← 重试多少次都一样
```

所以自愈必须由 `connectMcp` 自己做，判据是 `isConnectionLost`：

- `Session not found` 消息文本 —— **不认 404**：URL 写错、路径不存在也是 404，那种情况
  重连一次仍然失败，只会把真实错误盖成第二次的同一个错误。
- `fetch failed` + `cause.code` 在 `ECONNREFUSED` / `ECONNRESET` / `EPIPE` /
  `ETIMEDOUT` / `UND_ERR_SOCKET` 里 —— **不认 `ENOTFOUND` / `EAI_AGAIN`**：DNS 解析
  失败重连只会再失败一次，白多一次网络往返。

池这一层看不见连接失效，所以不要试图在 `pool.ts` 里补这个判据：`alive()` 拿不到
这个信息，加了也只是猜。池只做一件相关的事：**会话重建后刷新工具目录**（见下）。

## 会话重建后，池里的工具目录会过期

`pool.open()` 只在首次连接时 `listTools` 一次，之后 `handle.tools` 是缓存。服务端重启后
工具列表可能变了（插件升级、换项目），不刷新的话新工具永远看不到，`mcp_call` 的
`admitted` 检查还会用旧目录拒掉它。

所以 `McpConnection` 暴露 `generation()`：每重建一次底层会话 +1。池在 `acquire` 时比对
`entry.toolsGeneration` 与 `connection.generation()`，不一致就重新列一次。

注意这**不解决**「`mcp_load` 假成功」：`mcp_load` 读的是缓存，session 失效后它照样返回
完整工具列表而不发请求。这是刻意的——每次 load 都探活会给热路径加一次网络往返。
代价是模型可能先看到「加载成功」再在 `mcp_call` 上失败一次，然后自愈。

## `exec.agent` 与 `agent/created` 的 agent 未必是同一个对象

用 `WeakMap` 按对象身份索引会话状态时会落空。工具执行路径要准备按 `agent.id` 兜底。

## 事件负载形状

`loader/entry-init` 在 `options` 赋值**之前**发出，必须等下一个 microtask 再读 `name` 与 `config`。

`agent/created` 是 serial 派发，监听器抛错会让**会话创建失败**，所以这一层所有失败路径都必须是
`warn` + 降级。