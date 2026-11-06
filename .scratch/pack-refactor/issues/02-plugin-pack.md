# 02 — dsh-plugin-pack

Status: needs-triage

## 范围

`packages/dsh-plugin-manager` → `packages/dsh-plugin-pack`，与 01 同构。差异只有三处：

1. item 键是插件包名，不是 skill 名。
2. 生效路径是「摘掉该插件注册的工具 + 剔除其注入的提示词段」，`hooks.ts` 里那套 restrict 与段装配要保持原样，只把取值来源从两层策略换成 pack。
3. `catalog.json`（归属扫描缓存）迁到 `$DSH_HOME/packs/plugin/catalog.json`。

顺带补齐 `normalizeCwd`：本包当前没有，工作区键直接拼原始 cwd。

## 前置

01 验收通过。骨架从 01 抄，不重新设计。

## 依赖

- [spec.md](../spec.md)
- [01-skill-pack.md](./01-skill-pack.md)
