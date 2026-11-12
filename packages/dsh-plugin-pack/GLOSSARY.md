# dsh-plugin-pack

按工作区停用插件的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)，这里不重复。

## 术语

**Pack（分包）**:
一张具名的策略表，只含覆盖决定（项级与组级），不含成员清单。工作区绑一个 pack；未绑定走 `default`。`default` 是内置项，不可删除、不可改名，内容可编辑。
_Avoid_: 方案、配置组、profile

**副本（Copy）**:
以一张 pack 为底深拷贝出来的另一张 pack：项级与组级开关逐条复制，之后**与原 pack 再无关联**——改任一边都不影响另一边，删掉原 pack 副本照常存在，反之亦然。缺省名是「原名 + 空格 + 序号」（`前端` → `前端 2` → `前端 3`），不做尾部数字识别。副本不带任何工作区绑定：绑定是目录到 pack 的一对一映射，副本没有目录。
_Avoid_: 克隆、clone、派生、继承、模板、子 pack
**绑定（Binding）**:
工作区目录 → pack 的一对一映射，键是规范化后的 cwd（反斜杠为正斜杠、剥尾斜杠、Windows 转小写）。绑定只影响该目录下**新开**的会话；已经开着的会话不会换 pack。删除 pack 后残留的键是悬空引用，读侧按 `default` 求值。
_Avoid_: 关联、挂载、切换

**求值链（Resolution chain）**:
`pack.items ?? pack.groups ?? default.items ?? default.groups ?? 开`。前一环存在就不读后面的。
_Avoid_: 合并、继承

**三态（Tri-state）**:
开 / 关 / 跟随。键不存在即跟随，`false` 是明令关——两者不是一回事，界面上也不能共用一个按钮。`default` 没有上一层可跟，只有两态。
_Avoid_: 开关、覆盖

**插件（Plugin）**:
一个 npm 包，对模型的贡献可能是工具、提示词段，或两者都有。本插件以包名为键。
_Avoid_: 扩展、模块、bundle

**贡献（Contribution）**:
插件注入到模型可见范围内的东西，只有两类：工具（进入 API tools / PTC SDK）与提示词段（进入 system prompt）。
_Avoid_: 输出、内容、注入物

**归属（Attribution）**:
工具或段到插件的映射。宿主不记录它，本插件靠静态扫描各包源码里的 `defineTool({name})` 与 `systemPrompt.section({name})` 生成。
_Avoid_: 来源、出处、owner

**孤儿（Orphan）**:
认不出归属的段或工具。它们照常可见、照常可用，任何插件开关都管不到；面板只提示，不处理。
_Avoid_: 未知项、野项、脏数据

**停用（Disable）**:
本插件的开关语义，一次做两件事：该插件注册的工具进 deny 掩码，它注入的段从装配中剔除。只影响模型侧，不影响插件进程。
_Avoid_: 卸载、关闭插件、停用启用

**启停（Entry enable/disable）**:
profile 层面插件行是否加载。它换的是进程，本插件不碰它。
_Avoid_: 停用、开关

**快照（Snapshot）**:
某个 agent 当前生效的停用集合。装配与执行都读它，改策略后重建。
_Avoid_: 缓存、状态、配置

**可识别（Recognizable）**:
归属能从静态扫描里确证。不可识别的贡献一律当作孤儿——宁可少省几百 token，也不误删别人的段。
_Avoid_: 可靠、已匹配
