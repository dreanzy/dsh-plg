# dsh-skill-pack

按工作区绑定的 pack 控制 skill 可见性的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)，这里不重复。

## 术语

**能力项（Item）**:
本插件管理的一个 skill，以名字为键。
_Avoid_: 条目、skill 条目、开关

**开关状态（Switch）**:
某个能力项在某一层被显式定下的取值，只有开与关两种。键不存在不是一种状态，那是跟随。
_Avoid_: 启用、禁用、打开

**绑定（Binding）**:
某个工作区绑到哪个 pack 的那一条记录，键是规范化后的目录。未绑定、或绑定的 pack 已不存在时，按 `default` pack 求值。
_Avoid_: 关联、映射、选择、作用域

**层（Layer）**:
通用定义见[根术语表](../../GLOSSARY.md)。本插件的层内键分两类：项级与组级。
_Avoid_: 范围、作用域、级别

**求值链（Resolution chain）**:
四个决定的先后顺序：工作区绑定的 pack 的项级、同一 pack 的组级、`default` pack 的项级、`default` 的组级，四者都缺席时取内置缺省（开）。前一环存在即不读后面的。
_Avoid_: 合并规则、覆盖顺序、优先级

**分组（Group）**:
一组能力项的命名集合，一个能力项最多属于一个分组。未归属的项不属于任何分组，它们本身不构成一个分组。
_Avoid_: 标签、类别、文件夹、集合

**组定义（Group definition）**:
分组的身份与成员来源，存在 `groups.json` 里，不含任何开关决定。pack 里的组级开关引用它的 id，因此改名不影响任何 pack。
_Avoid_: 组配置、分组设置

**官方技能（Official skill）**:
路径含 `@deepseek-ai`，或 provider 为 `dsh-office` 的 skill。面板默认不展示，但模型仍可调用。
_Avoid_: 内置技能、系统技能、官方包

**意图（Intent）**:
一次写入表达的目标状态，与写入者读到的现状无关。
_Avoid_: 补丁、差量、变更集

