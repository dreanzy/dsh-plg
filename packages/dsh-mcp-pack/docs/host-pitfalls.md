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

## `exec.agent` 与 `agent/created` 的 agent 未必是同一个对象

用 `WeakMap` 按对象身份索引会话状态时会落空。工具执行路径要准备按 `agent.id` 兜底。

## 事件负载形状

`loader/entry-init` 在 `options` 赋值**之前**发出，必须等下一个 microtask 再读 `name` 与 `config`。

`agent/created` 是 serial 派发，监听器抛错会让**会话创建失败**，所以这一层所有失败路径都必须是
`warn` + 降级。