# 09 文档与 ADR

Status: ready-for-agent
Type: task

## 目标

把「为什么不用官方 agent preset、为什么要 deny 官方 subagent」记下来，并补包级术语表。

## 范围

`packages/dsh-model-scheme/GLOSSARY.md`（方案、档、路由、首选/备选、绑定、跟随、思考等级跟随）；包内 `README.md` 与 `README.en.md`；`docs/adr/0003-model-scheme-over-agent-preset.md`；根 `GLOSSARY-MAP.md` 增加一条上下文。

ADR 需记录三案对比（preset 副本 / 自研工具 / 纯提示词）与选择理由，含「agentOptions 静态导致 preset 副本无法实现备选」与「select 触发重挂载」两条证据。

## 验收

ADR 与 GLOSSARY 用语与 spec §3 一致；README 的安装命令、配置示例、降级说明与实际行为一致。

## 边界

不改已有 ADR 0001/0002；不动根 `GLOSSARY.md`。