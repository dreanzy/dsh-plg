# 04 plugin-pack 面板显示并清理残留键

Status: resolved

## 现状

`routes.ts:410-418` 已算出 `outOfScope`，`client.js:1242` 的 `OutOfScopeNotice` 折叠显示一句提示。缺的是：

1. 不区分「项级键」与「组级键」——`groups` 里的残留键完全没算。
2. 没有清理入口。

## 要做

1. `outOfScope` 扩成结构化：每个残留键带 `kind`（`item` / `group` / `assignment`）与出现在哪些 pack 里。
2. 面板按包名分组显示，每行一个「清理」按钮。
3. 清理走待保存改动：生成一批 `packItem: null` / `packGroup: null` / `assign: null` 命令，进确认条，可试算。
4. 加一个「清理全部残留」按钮，同样走待保存改动。

## 判据

- 单测：策略里有 `ghost-pkg` 的项级键与组级键，`outOfScope` 两条都列出。
- 单测：清理命令应用后，`packs.json` 里该包名的所有键消失，其余键不变。
- 试算：响应变了但磁盘没变。
- 面板：残留键可见、可清、清完名册回到初始。

## 参考

- ADR 0002
- `routes.ts:410-418`、`client.js:1242-1265`
