# 05 委派提示词

Status: ready-for-agent
Type: task
Blocked by: 04

## 目标

让模型知道该用 subagent_tier 而不是官方 subagent，并知道四档各干什么。

## 范围

`src/prompt.ts`：工具描述文本（不超过 400 token，含四档表）与系统提示词段 `model-scheme.delegation`（不超过 250 token）。段内不写模型名。段仅在该 agent 的 subagent_tier 注册成功时注入。

段必须明确：独立任务一律用 subagent_tier；只有需要本对话上下文才用 subagent_fork；并行派发；派完继续干活不轮询。

## 验收

`test/prompt.test.js` 断言两段字符数上限（按 UTF-8 字节或保守 token 估算，任选其一并写死阈值）；断言段内含 subagent_tier 与 subagent_fork 两个名字；断言段内不含任何模型 id。

## 边界

不改官方包文案；段名前缀统一 `model-scheme.`。