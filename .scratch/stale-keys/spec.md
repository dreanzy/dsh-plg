# 残留键：看得见、清得掉

## 背景

面板把 `dsh-tool-antigravity` 与 `dsh-language-guard` 列了出来，但这两个包在当前 profile（`web`）里根本不存在。根因是 `catalog.ts` 的 `profileDirs()` 扫了 `$DSH_HOME/profiles/*` 全部 profile，而 `$DSH_PROFILE_DIR` 只注入给 bash 子进程，插件进程里恒为 `undefined`。

修复后，面板列出的包名就是当前 profile 真正装了的那些。「卸载了还在」只剩一种成因：策略文件里有、当前名册里没有的键——**残留键**。

## 目标

1. 面板能看见残留键，并知道它属于哪张 pack、是项级还是组级。
2. 面板能清理残留键，按能力项粒度，走现有的待保存改动 + 确认条。
3. 三包（plugin / skill / mcp）语义一致，判定逻辑进 `dsh-pack-core`。

## 非目标

- 不自动清理。卸载再装回来时决定还在，这是设计意图。
- 不跨 profile 汇总。别的 profile 装没装，对这里的开关没有决策价值。
- model-pack 不参与：它管的是模型路由，没有「名册」这个概念。

## 决定

见 [ADR 0002](../packages/dsh-plugin-pack/docs/adr/0002-catalog-scope-is-current-profile.md)。

## 术语

- **残留键（Stale key）**：策略文件里存在、但当前名册里找不到对应能力项的键。
- **当前名册（Current roster）**：此刻真实存在的能力项集合，只覆盖当前 profile。
- 两者与「孤儿」的分界见根 `GLOSSARY.md`。

## 验收

1. 单测：`profileDirs()` 注入两个假 profile，只返回 `profileContext.dir` 那一个。
2. e2e：建两个 profile，在 A 里装包 X，在 B 里断言面板看不到 X。
3. 每包至少覆盖：读初始状态、新建、改名、绑定、试算不落盘、删除、名册回到初始。
4. 试算必须验证「响应变了但磁盘没变」，两条都要断言。
5. 四包对比同一操作的信封 `code`。
