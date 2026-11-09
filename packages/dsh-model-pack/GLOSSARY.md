# dsh-model-pack

按工作区为新建会话决定模型路由的 DSH 插件。本节只收本插件独有的词；DSH 装配语义与仓库约定见[根术语表](../../GLOSSARY.md)，这里不重复。

## 术语

**Pack（分包）**:
一张具名的路由配置，含一个可选的会话路由与最多四个档位。工作区绑一个 pack；未绑定走 `default`。`default` 是内置项，不可删除、不可改名，内容可编辑。本领域没有 item 与 group——pack 本身就是内容，不是逐项开关表。
_Avoid_: 方案、scheme、preset、profile、模板

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
工作区目录 → pack 的一对一映射，键是规范化后的 cwd（反斜杠为正斜杠、剥尾斜杠、Windows 转小写）。绑定只影响该目录下的[空白会话](#空白会话-blank-session)；已经开过轮次的会话不会换 pack。删除 pack 后残留的键是悬空引用，读侧按 `default` 求值。
_Avoid_: 关联、分配、默认 pack

**空白会话（Blank session）**:
还没开过任何一轮的会话：会话事件里既没有 `turn/start`，也没有 `request/header`。判据取并集且只有这一条，与宿主自己的 `blank` 投影一致（宿主用 `turn/start`，本插件再看一层 `request/header`，覆盖"消息发了、请求没出去"的情形）。

模型位在**三个时点**都会被重新施加：会话创建、会话恢复、用户切 pack。空白会话是唯一会被改写的会话；一旦开了轮次，模型选择就归用户，任何时点都不再动。因此"在空白会话里手选过模型"不是豁免条件——切 pack 与重开页面都会把它覆盖回 pack 的路由，这是有意的：用户切 pack 本身就是主动行为，而空白会话的选择还没有产生任何内容。
_Avoid_: 新会话、空会话、未使用的会话

**求值链（Resolution chain）**:
`工作区绑定的 pack → default pack → 出厂内置`。前一环存在就不读后面的。绑定悬空（指向已删 pack）时跳过第一环，并在面板标「绑定失效」。
_Avoid_: 合并、继承、两层

**跟随（Follow）**:
某处对该键没有记录，取值来自下一环。落盘表现为键不存在。本插件的跟随只有一环：工作区没有绑定（或绑定到 `default`）时取 `packs.default`；`packs.default` 也不存在时落回出厂内置。解绑即删除该键，从不写 `null`。通用定义见[根术语表](../../GLOSSARY.md)。
_Avoid_: 继承、默认

**提示词覆盖（Prompt override）**:
`prompts.json` 里对编排段与四档线索的逐键覆盖。与 pack **正交**：所有 pack 共用同一份，全局一份，不随绑定变化。
_Avoid_: pack 内提示词、方案提示词
