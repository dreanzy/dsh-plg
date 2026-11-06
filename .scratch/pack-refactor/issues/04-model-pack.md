# 04 — dsh-model-pack

Status: needs-triage

## 范围

`packages/dsh-model-scheme` → `packages/dsh-model-pack`。术语「方案」全部改称 pack。

1. `packs.json` 的每个 pack 就是原来的 `Scheme`：`{ name, session?, tiers }`。`default` 承接原出厂方案，但**可编辑**。
2. `defaultSchemeId` 字段消失：「工作区未绑定即用 default」取代它。
3. `workspaces.json` 统一形状，cwd 键改用 `normalizeCwd` 规范化（现在用原始 cwd）。
4. `prompts.json` 保留，与 pack 正交，不改语义。
5. 设置页只加「分包」页，不加「分组」页（没有可分组对象）：页签为 `模型 | 提示词 | 分包`。
6. `subagent_tier` 工具、`agent/created` 钩子、deny 官方 `subagent` 的次序全部不动——只换数据来源。

## 风险

`client.js` 2561 行，是全仓库最大的一块。改动集中在数据读取与「分包」页，避免顺手重排无关代码。

## 前置

01 验收通过。

## 依赖

- [spec.md](../spec.md)
- [01-skill-pack.md](./01-skill-pack.md)
- [ADR 0003](../../../docs/adr/0003-model-scheme-over-agent-preset.md)（自研委派工具的取舍，本次不重开）
