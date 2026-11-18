# 05 skill-pack 补残留键

Status: resolved

## 现状

skill-pack 完全没有 `outOfScope` 字段。策略里有、名册里没有的 skill 名，面板上完全不可见。

## 要做

1. 视图加 `outOfScope`，用 core 的 `staleKeysOf`。
2. 面板加同样的提示与清理入口，交互与 plugin-pack 一致。
3. 名册来源是 `skills.snapshot()` 的 `skills` 数组——注意它随工作区与 preset 变化，残留键的判定也跟着变。

## 判据

- 单测：策略里有已删 skill 的键，`outOfScope` 列出它。
- 单测：清理后 `packs.json` 里该名字的所有键消失。
- 试算：响应变了但磁盘没变。

## 参考

- ADR 0002
- `routes.ts:67-96`（`GlobalView`）
