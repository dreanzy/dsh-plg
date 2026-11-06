# @dreanzy/dsh-model-scheme

按工作区为新建会话指定模型与子智能体档位。

## 它做什么

把「哪个工作区用哪个模型、子智能体各档怎么路由」组合成一个可命名的**方案**，绑定到工作区。只作用于该目录下**之后新建**的会话，已有会话不受影响。两件事：

1. 会话使用的 provider / model / reasoningEffort；
2. 子智能体（`subagent_tier` 工具）四档难度各自的路由，含首选与备选。

会为空白会话把全局方案的会话路由同步成进程级默认显示（不改写任何已有会话的选择），不接管官方 composer 模型选择器的交互，不管智能体团队（`spawn_teammate`）的成员路由。

## 状态

功能完整：两层求值链、`subagent_tier` 工具、委派提示词段、设置页与模型位方案名都已实现。宿主缺少子智能体服务或 `tools.restrict` 时按 spec §6.4 降级，面板显示原因。

## 配置

```jsonc
// $DSH_HOME/model-scheme/schemes.json
{ "version": 1, "defaultSchemeId": "standard", "schemes": { "standard": {
  "name": "标准",
  "session": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
  "tiers": { "tier1": { "name": "侦察", "primary": { "provider": "deepseek", "model": "deepseek-chat" }, "fallbacks": [] } }
} } }
```

## 安装

```sh
dsh plugin --profile <profile> add ./packages/dsh-model-scheme
```

装完重启宿主。未绑定工作区、也未设全局默认时，插件不改变任何行为。
