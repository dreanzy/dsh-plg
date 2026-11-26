# 飞行结算抽成纯函数

## 背景与决定

`dsh-lsp-lens` 的 `apply` 有 224 行（129–352），里面同时装着会话脏表的生命周期、飞行表（`inFlight`）、跨步结算判定与两条钩子的接线。

其中「这次飞行该怎么处置」这条规则——未落定且未过期就继续等、超过 2 步或 30 秒就放弃、落定了就把结果取走——原先埋在 pre-step 的闭包里：

```ts
if (!flight.done) {
  const stale = step - flight.step > FLIGHT_MAX_STEPS || Date.now() - flight.startedAt > FLIGHT_MAX_MS
  if (!stale) continue
  state.inFlight.delete(flightKey)
  continue
}
state.inFlight.delete(flightKey)
if (flight.result !== null) feedback.push(flight.result)
```

要测这条规则，只能构造假 ctx、驱动整个 `apply`、让 pre-step 在合适的步号上跑一遍。

决定：把判定抽成 `flight.ts` 里的 `settleFlight(flight, step, now)`，返回四档之一——`pending` / `stale` / `take` / `empty`。它是纯函数：只读 `flight` 的三个时间字段与 `done`，不看表、不删项、不记日志。`apply` 的循环因此变成「判一次、按档处置」。

**不抽的是飞行表本身。** `Map<会话键, SessionState>` 挂在 `apply` 的闭包里，因为它是会话作用域的——抽出去就要把 `stateOf` 一起搬，而 `stateOf` 的懒建与会话键的解析耦合在宿主事件上。

## 考虑过的替代方案

**把整个飞行表与调度一起抽成 `flight.ts`。** 否掉：这会改变「什么时候读 `inFlight`」的时机。本包最近 10 次提交全在修时序（[ADR-0014](./0014-lsp-feedback-session-scope-and-async.md) 记了三条），时序回归只能靠 e2e 抓，单测抓不到。先抽无副作用的那一半，调用结构不动。

**不抽，保持现状。** 否掉：这条规则里有一个此前从未被测试固定下来的边界——「恰好第 2 步仍算 pending」，因为诊断可能刚好在那一步回来。把 `>` 写成 `>=` 会让第 2 步的结果被丢掉，而现有测试（23 条）一条都不会红。

## 后果

- `apply` 里的结算循环从 12 行变成 11 行：判一次 `settleFlight`，按 `pending` / `stale` / `take` 处置。`empty`（落定但没结果）与原来一样只删除、不产出。
- 新增 `test/flight.test.js` 6 条，把四档与两个边界（步数、时间）都固定下来。变异验证过：把 `>` 改成 `>=`，边界那条立即红。
- 已知局限：`settleFlight` 只判「这一次飞行」，不掌握表的大小与先后。真正的调度顺序仍在 `apply` 里，那部分继续由 e2e 守着。
- 这条改动没有触及 `sessionKeyOf` / `DirtySet` / `render.ts`，时序相关的三条决定（会话作用域、跨步异步、`seen` 记忆）不受影响。

## 参考

- [ADR-0013](./0013-lsp-feedback-three-sources.md)：三个发现来源与去重键。
- [ADR-0014](./0014-lsp-feedback-session-scope-and-async.md)：会话作用域与跨步异步，本文抽的是它的一部分判定。
- `packages/dsh-lsp-lens/GLOSSARY.md`：回灌、脏文件、发现来源、待处理。
