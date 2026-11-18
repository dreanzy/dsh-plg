# 06 mcp-pack 补残留键

Status: resolved

## 现状

mcp-pack 的行来自 `loader.entries()`（`inventory.ts:82`）。行被删掉后，`packs.json` 里针对它的 `enabled` / `mode` / `tools` / `description` 记录与分组归属都成了残留键，面板上完全不可见。

## 要做

1. `RowsView` 加 `outOfScope`，用 core 的 `staleKeysOf`。
2. 面板加提示与清理入口。
3. 清理要删掉该行键在**所有 pack** 里的 `rows` 条目与 `assignments` 条目。注意 `rows` 是逐字段的（`enabled` / `mode` / `tools` / `description`），删的是整个行键条目，不是单个字段。

## 判据

- 单测：策略里有已删行的键，`outOfScope` 列出它。
- 单测：清理后 `packs.json` 里该行键的所有条目消失，其余行不变。
- 试算：响应变了但磁盘没变。

## 参考

- ADR 0002
- `inventory.ts:82-135`、`routes.ts:62-91`（`RowsView`）
