# 宿主行为陷阱

记录本插件依赖、但不在 DSH 公开文档里的行为。每条都是踩过之后实测确认的，改动相关代码前先看这里。

基准：DSH `0.2.2-rc.1`。

## `skills.register()` 会让 `skills.get()` 的缓存失效

`dsh-skill` 的 `register()` 无条件调用 `invalidateCache()`：注册表 `revision += 1`，并且 `collectCache.clear()`。而 `get()` 的收集缓存正是按 revision 做键。

所以**「读一个、注册一个」的循环是 O(n²)**：每注册一次，下一个 `get()` 必然缓存未命中，触发一次完整的全量枚举。

实测影响：86 个隐藏项，逐个 `get()` 约 22–25ms，合计约 2 秒。这段代码在 `agent/created` 里被宿主串行 `await`，用户看到的就是「点新会话要等很久才出来」。

正确写法：**先把所有定义取完，再统一注册**。分段后只有第一次 `get()` 可能全量，其余命中缓存；注册本身约 0.06ms/次。见 [src/hooks.ts](../src/hooks.ts) 的 `buildShadows`。

## `snapshot({})` 只查 global 层

`dsh-skill-filesystem` 由 agent preset 挂载，注册在 **preset 层**。`snapshot()` 不传 `scope` 时只读 `[global]`，于是只能看到直接注册在根 ctx 的插件 provider（实测 4 个 provider、15 条），`.agents/skills` 与工程 skill 全部缺失。

面板要列全量，必须传任意一个 live Agent 的 `scope`（并带上它的 `cwd`）。带 scope 的读取天然包含 global 层（`collectFresh` 是 `[global, ...chainLayers(scope)]`），因此**不要再读一次全局清单做并集**——那会让每次请求变成两次全量扫描。

## scope 必须传 Agent 对象本体

`dsh-scope` 按**对象身份**索引（`scopeParents` 是 WeakMap）。用 `agents.get(id)` 返回的对象原样传下去才对；另造一个字段相同的替身、或包一层 Proxy，都查不到 agent 层，结果是静默退化成「只读全局层」——不报错，只是策略不生效。

## `agent/created` 里绝不能抛错

该事件是 serial 派发，监听器抛错会让**会话创建失败**。所以这一层所有失败路径都必须是 `warn` + 降级，不能 `throw`。同理，任何挂在 waterfall 事件（`agent/pre-step`、`system-prompt/assemble`）上的监听器必须 `await next()` 并透传返回值。

## `skills/change` 不改策略文件，指纹挡不住

`ScopeSnapshot` 只按三份状态文件的指纹短路。用户在外部安装或卸载 skill 时，三份
文件都没变，宿主只发 `skills/change`；不显式 `invalidate()` 的话，重新落地会一直
读到旧清单。`hooks.ts` 的 `onChange` 因此在每个清单事件到来时先失效缓存。

## 插件重载会清空进程内的会话表

`states` 只存在于插件实例里。disable/enable 之后，**已经存在的会话不会再收到 `agent/created`**，于是一直停在「没有遮蔽」的状态，直到用户重开会话。这就是 `bootstrap()` 存在的原因：`apply` 结束时主动枚举一次 live Agent 补落地。

## `skills.list()` / `snapshot()` 是 invocation-neutral 的

`invocation`（`modelInvocable` / `userInvocable`）原样透出，**服务端不做任何过滤**：官方注释写明「Consumers apply model or user invocation policy at their operational boundary」。所以清单里永远有已关闭的名字，判据在消费方手里：

- 模型目录与 `skill` 工具：`isModelInvocable`
- `agent/pre-step` 的 `/name` 注入：`isUserInvocable`
- 官方 `/` 菜单：**只读 `modelInvocable` 加标签，不按 `userInvocable` 过滤**

## 官方 `/` 菜单由远端 `skills.list` 过滤，判据是 `isUserInvocable`

`dsh-client-ui-skill` 的 `candidates` 本身不过滤，但它拿的是远端 `skills.list`，而那一层已经过滤过了：`dsh-api-session-controller` 的 `skill-catalog` 在 `list()` 末尾执行 `.filter(isUserInvocable)`。所以 `userInvocable: false` 的遮蔽副本根本到不了客户端，`/` 菜单里不会出现。

这条与 `dsh-skill` 自身的 `list()` 形成对照：注册表那一层是 invocation-neutral 的，过滤发生在 Remote 边界。查「菜单为什么不显示」时别停在客户端。

## `registerSource` 对 `(trigger, name)` 唯一性抛错

`ctx.inputTriggers.registerSource()` 遇到同 `trigger` 同 `name` 直接 `throw`，没有覆盖或优先级机制。官方那批已占用 `("/", "skill")`，所以第三方插件**无法**替换、过滤或隐藏它的候选；另注册一个 `/` source 只会让菜单多一组。

## 用户消息的 `skillNames` 来自 `skill-invocation` 注入事件

`dsh-client-ui-chat` 的 `SkillNameProjector` 只收 `kind === "skill"` 的 context 节点，而这类节点由宿主在 `/name` **成功注入**时写入。因此：

- 正常 skill：`skillNames` 含该名字 → 官方 `skillReferenceRule` 把它画成 chip
- 被关掉的 skill：注入被跳过 → `skillNames` 不含它 → 只剩字面文本，**不会**变成 chip

插件若要在消息里补一个「已关闭」标记，判据必须同时是「在已关闭集合里」且「不在 `skillNames` 里」；否则会抢走官方对正常 skill 的渲染。
