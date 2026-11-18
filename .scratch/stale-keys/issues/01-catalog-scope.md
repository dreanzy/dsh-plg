# 01 插件目录只扫当前 profile

Status: resolved

## 问题

`catalog.ts:318-342` 的 `profileDirs()` 优先读 `$DSH_PROFILE_DIR`，读不到就退回扫 `$DSH_HOME/profiles/*` 全部 profile。而 `$DSH_PROFILE_DIR` 只由 `dsh-shell-env` 注入给 bash 子进程，插件进程里恒为 `undefined`——退回分支是常态。

后果：面板显示「这台机器上所有 profile 装过的插件」，不是「当前 profile 装了的插件」。用户在 web 里卸载一个包，只要 desktop 还装着，它就继续出现在 web 的面板里，且开关对它无效。

## 要做

1. 从 `ctx.get('profileContext')` 取 `dir`，只扫它。
2. `profileContext` 拿不到时（测试、非 profile 启动）退回扫全部 profile，但目录标记 `complete: false`，并在 `warnings` 里写明「无法确定当前 profile，归属可能来自其他 profile」。
3. `inject` 加 `profileContext`？**不加**——它是可选服务，加进 `inject` 会让没有它的 profile 起不来。用 `ctx.get` 探测并包 `try/catch`。

## 判据

- 单测：注入两个假 profile，`profileDirs()` 只返回 `profileContext.dir` 那一个。
- e2e：建两个 profile，A 装包 X，B 断言面板看不到 X。
- 拿不到 `profileContext` 时，`complete === false` 且 `warnings` 非空。

## 参考

- ADR 0002
- `catalog.ts:305-342`
- `dsh-app-boot/src/profile-context.ts`（`ProfileContext.dir`）
