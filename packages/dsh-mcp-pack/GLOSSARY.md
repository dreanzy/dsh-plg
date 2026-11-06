# dsh-mcp-pack

按工作区控制 MCP 服务器可见性与加载方式的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)。

## 术语

**行（Row）**:
组合里一条 `@deepseek-ai/dsh-mcp-client` 的 entry，代表一台 MCP server。
_Avoid_: 条目、服务器、连接

**行键（Row key）**:
行的稳定标识，形如 `global:<serverName>`（patch 里的行）或 `own:<serverName>`（托管行）。策略、分组归属与工具规则都按它索引。
_Avoid_: 服务器名

**Pack（分包）**:
一张具名的策略表，只含覆盖决定。工作区绑一个 pack；未绑定走 `default`。`default` 是内置项，不可删除、不可改名，内容可编辑。
_Avoid_: 方案、配置组、profile

**分组（Group）**:
与 pack 正交：分组描述「哪些行是一类」，pack 描述「这些行对这些工作区是开是关」。一行最多属于一个分组。组级只有开/关一个布尔，没有模式、工具规则与描述。
_Avoid_: 分类、标签

**绑定（Binding）**:
工作区目录 → pack 的一对一映射，键是规范化后的 cwd（反斜杠为正斜杠、剥尾斜杠、Windows 转小写）。绑定只影响该目录下**新开**的会话。删除 pack 后残留的键是悬空引用，读侧按 `default` 求值。
_Avoid_: 关联、挂载、切换

**模式（Mode）**:
`eager` / `dynamic` / `lazy` 三档之一，回答「这台 server 的工具什么时候进上下文」。
_Avoid_: 加载方式、加载策略

**载体（Carrier）**:
模式的实现形态。`native` = 把工具定义原生注册；`proxy` = 不注册，经代理调用。模式决定载体，用户不能单独选。
_Avoid_: 通道、实现

**名册段（Inventory section）**:
`dynamic`/`lazy` 下写进系统提示的 server 清单，每行一个名字与可选描述。模型据它决定加载谁。
_Avoid_: 清单、列表

**覆盖（Override）**:
某个 pack 对某个字段有记录，取值由它决定，不再向上读。覆盖可能恰好与上层同值，此时覆盖仍然存在且有意义——**`dynamic` 是覆盖，`null` 才是跟随**，两者不能合并。
_Avoid_: 冲突、强制、改写

**求值链（Resolution chain）**:
逐字段独立，四者互不影响：
```
enabled:  pack.rows ?? pack.groups ?? default.rows ?? default.groups ?? 开
mode:     pack.rows ?? default.rows ?? dynamic
tools:    pack.rows ?? default.rows ?? []
description: pack.rows ?? default.rows ?? ''
```
组级只出现在 `enabled` 那条链上。前一环存在即不读后一环。
_Avoid_: 合并规则、优先级

**三态（Tri-state）**:
开 / 关 / 跟随。键不存在即跟随，`false` 是明令关——两者不是一回事，界面上也不能共用一个按钮。`default` 没有上一层可跟（除内置缺省）。
_Avoid_: 开关

**闸门（Gate）**:
在 Loader 层摘掉 `dynamic`/`lazy` 的行，使连接与工具都不存在。状态只在内存，不写回用户配置。
_Avoid_: 拦截器、钩子

**屏蔽（Shield）**:
用 `tools.restrict({ deny })` 在某个 agent 的作用域上遮住已注册的全局工具。与闸门的分工：闸门让进程不起，屏蔽兜住仍然挂载的那些。
_Avoid_: 隐藏、禁用

**托管文件（Owned include）**:
本插件自己创建与维护的 include 文件。设计上只改它，不改用户已有的配置。
_Avoid_: 配置文件、数据目录