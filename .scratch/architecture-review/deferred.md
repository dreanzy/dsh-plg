# 架构评审：暂缓项

评审日期 2026-11-05。已完成的部分见当日提交（skill/mcp 的共享快照、诊断写盘、目录缓存、面板派生）。这里只记**评估后决定暂缓**的项，附判断依据，避免下次重新论证。

## C8 保存路径的重复求值：已由共享快照吸收

现象：`handleApply` 在 `afterWrite` 里刷新一轮，随后 `buildView` 又从盘上读一轮。

实测（`.tmp/c8-bench/bench.mjs`，一次全局保存）：

```
无 afterWrite        reads=1
有 afterWrite        reads=1   (refreshes=4，全被指纹命中)
```

同一键的多次 `refresh` 只在第一次真读，其余命中指纹。所以这里**不需要改代码**，改也只能再省一次 stat。

真正的 N 倍开销在 `reconcileAll`：每个 agent 一个 scope 键，键不同就不能共享。那是 scope 隔离换来的正确性（见 C6），不是重复计算。

## C9 三份同构求值模块：前置条件未满足

三处同构：`policy.ts` 的解析/序列化/求值链、`routes.ts` 的 `resolveSession`、以及两个 `snapshot.ts` 的缓存骨架。

为什么现在不抽：

1. ADR-0001 记录过真实失败——`workspace:` 协议在用户从 git 子目录安装时不会替换成真实版本，报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。
2. 抽包后三包都要依赖新包；新包**必须先发布到 npm**，否则源码安装（`github:<owner>/<repo>#<sha>&path:/packages/<pkg>`）解析不到依赖。
3. 本会话无法验证真实安装：需要发布 + 外部网络。

现有替代已经够用：两个 `snapshot.ts` 形状一致（同样的 `read` / `refresh` / `invalidate` / `stats` 与同样的键规则），由各自的测试守护；改一处语义时另一处是"抄一遍"，不是"猜一遍"。

触发条件（满足任一再动）：新包有明确发布计划；或三处同构的改动频率高到一次改动要在三个包各修一遍且已出过不一致的线上问题。

前置动作：先发一个空壳版本到 npm，再用真实源码安装验证一次，最后才改三包依赖。

## 面板的重复请求：未做

- `dsh-plugin-manager/client/client.js`：设置页把 `Panel` 嵌进来，而 `SettingsPanel` 自己也拉同一个 `/global`；一次进设置页两次全量请求。
- `dsh-mcp-manager/client/client.js`：弹层 `if (!open) return null`，每次重开都重挂、重拉 `/workspace` 与 `/diag`。

没做的理由：请求数量少、频率是人工点击量级；要修得引入一层请求缓存，而缓存的生命周期（会话切换、写入后失效）比省下的两次请求更贵。等真正出现"面板打开慢"再动。

## skill 的 `snapshot.stats()`

`createScopeSnapshot` 已经暴露 `hits / misses / reads / refreshes / size`，但没有出口。skill 没有 `/diag` 路由，mcp 有。等 skill 需要排查缓存命中率时再接。
