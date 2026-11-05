# dsh-plugin-manager

按工作区停用插件的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)，这里不重复。

## 术语

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
