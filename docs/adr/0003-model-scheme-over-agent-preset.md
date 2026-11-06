# 模型方案走自注册的委派工具，不复制官方 agent preset

## 背景与决定

DSH 里有三套名字撞在一起的「preset」，先说清它们各自是什么，才能说清本插件不是其中任何一个：

- **agent preset**：Agent 的能力组合，即工具、提示词与技能的子插件列表。字段只有 `id/name/description/order/plugins`，**不含任何模型字段**。
- **ModelSelection**：`{ provider, model, reasoningEffort? }`，由 `agent.model` 承载，每个 Agent 各一份，另有 `agentDefaultModel` 管进程级默认值。
- **permission-presets**：沙箱模式与审批策略的捆绑，同样与模型无关。

本插件的**模型方案（Scheme）**是第四种：一套命名的路由配置，含一个可选的会话路由与最多四个子智能体档位，可在设置页增删、可绑定到工作区。它与官方三种 preset 不通用、不互操作，也不打算复用它们的名字。

产品要的两件事——按工作区决定新会话的模型、四个难度档各自路由到哪个模型——在官方 API 上没有现成承载物。可用的接缝只有两个：`agent/created` 里调 `agent.model.select()`，以及派发子智能体时显式给 `agentOptions`。

**决定**：不复制、不派生官方 agent preset。本插件在 `agent/created` 里为每个新会话注册自己的委派工具 `subagent_tier`，由它按档位查表后显式调用 `subagents.startActivation` 并传 `agentOptions`；同时 deny 官方 `subagent`，保留 `subagent_fork`。

## 考虑过的替代方案

### 复制官方 agent preset

做法：注册若干 preset，每档一个，preset 的 `plugins` 里放一行 `dsh-tool-subagent`，行内 `config.agentOptions` 固定 provider/model/reasoningEffort；再按工作区调 `agentPresets.select()`。

两条硬证据把它否掉：

1. **`agentOptions` 是静态配置。** 它只存在于插件行的 `config` 里，随挂载固定，运行期没有求值钩子。因此「一个档位内首选 + 多条备选，按可用性依次前进」无法表达——一个 preset 只能给出一个固定路由。备选是本插件的核心语义，这条直接判死。
2. **`agentPresets.select()` 会触发 `recompose()` 重挂载。** `select` 不是改字段，是重建挂载：新代际建立、旧代际标记退役并回收。每个新会话因此多一次「挂载默认 preset → 退役 → 挂载目标 preset」，两次 `apply` 都会真实执行。而模型档位只需往会话日志 append 一条 `model/selection`，两者代价不在一个量级。

另有两笔附带成本：注册的 preset 必须自带完整 `plugins` 列表（基础工具 40 行以上），官方明说不与内置列表的未来更新自动合并，版本漂移由本插件承担；preset 定义不落盘，持久化只能改写 bundle patch 再走 `pluginManager.installBundle()`，而官方明禁 `plugin_manager` 编辑 preset 组合。

### 纯提示词

做法：不注册工具，只在系统提示词段里写明各档用哪个模型，让模型自己调官方 `subagent` 并传 `provider/model/reasoning_effort`。

代价：完全取决于模型是否照做，没有强制。模型一旦不照做，配置与提示词各说各话，没有任何地方能验证；官方 `subagent` 一次派发只带一个路由，没有备选概念，选错就是错。设置页也无法如实显示「模型现在被约束在档位上」，只能显示「提示词里写了」。

### 自研委派工具（选定）

做法：档位的 `primary`/`fallbacks` 是运行期数据。`subagent_tier` 的 execute 按 cwd 解析方案、取该档路由链，逐条 `llm.resolveCallConfig` 探测，通过才用，再 `startActivation({ provider: 'spawn', delivery: 'parent', request: { prompt, agentOptions: route } })`。

代价：激活语义被本插件重造一角，官方改 `startActivation` 或 provider 的 `capabilities` 时要跟着改，只能靠能力探测降级；还要自己解决「官方工具还在，模型绕过档位」的问题。

## 后果

- 档位是**工具参数**而不是模型可见的自由选择：`subagent_tier` 的 `tier` 是枚举，路由由插件查表决定，模型只决定「这活有多难」。
- **deny 官方 `subagent`**：注册成功后调 `tools.restrict({ deny: ['subagent'] })`。顺序是硬要求——先注册成功再 deny，反过来一旦注册失败，模型会完全失去委派能力。`tools.restrict` 不存在时只注册不 deny，面板标红说明官方工具未被屏蔽、模型可能绕过档位。
- **保留 `subagent_fork`**：fork 的价值是复用父会话前缀，换模型等于把前缀作废。因此 fork 不参与档位，也不 deny；提示词里划清分工——独立任务用 `subagent_tier`，只有需要本对话上下文才用 fork。
- **智能体团队不受控**：团队派发直接调 `subagents.startActivation`，不经过任何插件可介入的接缝，成员路由由官方团队功能自决。这是已知边界，面板如实说明，不假装覆盖。
- 会话路由与档位路由走两条路：会话侧 `agent.model.select()` 只 append 事件，不动 `agentDefaultModel`，全局默认因此不被工作区方案污染；子智能体侧靠 `agentOptions`。
- 与社区同类插件并存：不注册同名工具，不写 `subagent-model-selection` 命名空间，文档给出并存说明。

## 何时重新考虑

- 官方给 `agentOptions` 加运行期求值（函数、resolve 钩子，或任一可在派发前改路由的接缝），「首选 + 备选」能在 preset 行里表达时，preset 副本方案重新回到桌上。
- `subagent` 服务提供路由中间件，在 `startActivation` 之前有可插拔的选路由钩子时，本插件的工具层可以整层撤掉，退化成纯配置。
- `agentPresets.select()` 不再重挂载，或官方提供一个不带挂载代价的「仅模型」preset 维度。
- 官方让 `agentDefaultModel` 从进程级单值变成可分层（例如接受工作区维度），本插件的工作区层可以整体退役。

判定标准只有一条：官方能把「一个档位的多条备选」和「按工作区求值」同时表达出来，本插件的自研工具层就该删。
