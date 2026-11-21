# reconciler 先释放后施加，不采用上游的「先建后撤」

## 背景与决定

上游 `dsh-skill-scope` 在 v0.4.1 修了一个真实缺陷：原先「先释放旧 `tools.restrict` 句柄、再施加新的」，当 `restrict()` 抛错时旧掩码已经撤掉，被禁工具立刻全部可见，而状态仍指向已释放的句柄；下一轮若隐藏集不变，会复用那个死句柄，该 server 此后再也不会被收窄。它的修法是**先叠新层、成功后才撤旧层**，成立的依据是 restriction 是「相交」语义，叠一层再撤一层等价。

本项目的 `createReconciler` 采用相反顺序：同一 key 重算时**先 `drop` 旧资源、再 `build` 新的**（`packages/dsh-pack-core/src/reconcile.ts` 的 `apply`），并把这条写成了契约：`test/reconcile.test.js` 有两条断言锁死它（「先释放后施加」「build 抛错：返回 false，旧资源已释放」），`dsh-skill-pack` 的 `registerShadows` 注释也明说依赖「那一刻上一轮已经释放」。

决定：**保持先撤后建，不移植上游的修法**。

理由是这个 reconciler 由四个包共用，同时服务两类资源：

1. **可叠加的**：`tools.restrict` 的掩码，加一层再撤一层等价。
2. **不可叠加的**：skill 遮蔽副本（`skills.register` 同名注册，两份同时存在没有意义，先建会撞注册）。

对第 2 类，「先建后撤」不是优化而是破坏；对第 1 类，先撤后建多出的窗口是同一同步段内的微秒级，只有在 `build` 抛错时才会延长到下一次事件。为这一种情形给共享核心引入两套顺序语义，收益不抵复杂度。

## 考虑过的替代方案

**全局改成先建后撤。** 否掉：shadow 同名不可叠，会直接坏掉半数的消费方。

**给 `apply` 加 `overlap` 选项，只让 plugin-pack 的掩码路径用。** 否掉：共享核心里出现两种互斥的落地语义，调用方必须知道自己的资源能不能叠；还要改两条锁死契约的测试。换来的只有「restrict 抛错时旧掩码多留一会儿」，而那个抛错路径已经被 `unknownNamesIn` 剔除未知名后重试一次覆盖了大部分。

**在 plugin-pack 侧继续预检，不动顺序。** 已采纳为缓解（现状），它不是替代方案，是接受窗口期后的止损：`planned === null` 时把 `state.key` 清空，让下一次事件必然重算，而不是相信一个已经失效的 key 仍然生效。

## 后果

- `build` 抛错时存在「旧掩码已撤、新掩码未上」的窗口，直到下一次 `skills/change`、策略保存或 `agent/created` 才恢复。这是这条决定的已知代价，不是待修缺陷。
- 上游那次修复里**可以移植的部分不在这条顺序上**：它指出的真正病是「调用方 await 了一个不代表落地的 Promise」。这个病在本项目 `reapply` 上成立——`onChange` 在 `applying > 0` 时只置 `dirty` 就返回，而路由已按「已生效」回包。已按同一思路修掉（`guarded` 增加落地结算信号，`reapply` 等它收尾）。
- 已知局限：`dsh-skill-pack/src/types.ts` 的 `EMPTY_PACK`/`EMPTY_GROUPS`/`EMPTY_BINDINGS` 等共享缺省常量未冻结。本仓库所有 pack 变更都换新对象（`ops.ts` 的 `applyPacks`/`applyGroups` 一律 `{ ...pack, ... }` 或新数组），当前不存在原地写路径；冻结属未来防护，未做。
