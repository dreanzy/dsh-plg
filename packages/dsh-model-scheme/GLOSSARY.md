# dsh-model-scheme

按工作区为新建会话决定模型路由的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)，这里不重复。

## 术语

**模型方案（Scheme）**:
一套命名的路由配置，含一个可选的会话路由与最多四个档位。本插件拥有的对象，与官方 `agent preset`、profile 无关。
_Avoid_: preset、profile、配置、模板

**档（Tier）**:
子智能体的难度等级，固定四个：`tier1` 侦察（只读定位）、`tier2` 速办（1-3 文件小改）、`tier3` 攻坚（跨模块）、`tier4` 深算（根因与架构取舍）。id 稳定，显示名可改。
_Avoid_: 级别、等级、模型组

**路由（Route）**:
`{ provider, model, reasoningEffort? }`。省略 `reasoningEffort` 表示交给适配器默认值。
_Avoid_: 模型选择、选择项、目标模型

**首选 / 备选（Primary / Fallback）**:
一个档位内的有序路由列表。首选不可用或确定失败时按序换下一个；不重试已失败的子任务。
_Avoid_: 重试、降级、候选

**内置提示词（Built-in prompt）**:
随插件发布的编排段与四档判定线索。用户以 `prompts.json` 逐键覆盖，缺省即跟随内置。内置更新不自动合并已有覆盖。
_Avoid_: 默认提示词、模板、文案

**思考等级跟随（Effort follows the model）**:
路由省略 `reasoningEffort` 时，取该模型自己的默认强度，不继承会话路由的强度。这是官方 `agentOptions` 的既有语义（换路由而未显式给强度时会清掉继承来的强度）。
_Avoid_: 继承强度、沿用、透传

**绑定（Binding）**:
工作区到方案的映射。只作用于该目录下之后新建的会话。
_Avoid_: 关联、分配、默认方案

**跟随（Follow）**:
某层对该键没有记录，取值来自上一层。落盘表现为键不存在。本插件的跟随有两环：工作区层缺 `schemeId` 时取全局层的 `defaultSchemeId`，全局层也缺时落回出厂方案；解绑即删除该键，从不写 `null`。通用定义见[根术语表](../../GLOSSARY.md)。
_Avoid_: 继承、默认
