# 03 残留键判定进 core

Status: resolved

## 问题

三包都要「策略里有、名册里没有」这个判定，各写一遍必然分叉。ADR 0007 的边界是：共用的骨架进 core，各包的条目 schema 留在自己包里。

## 要做

在 `dsh-pack-core` 加一个纯函数：

```ts
export function staleKeysOf(
  policyKeys: Iterable<string>,
  roster: ReadonlySet<string>,
): string[]
```

返回排序后的残留键。不读盘、不碰策略文件形状——调用方各自把「策略里有哪些键」与「名册里有哪些键」喂进来。

## 判据

- 单测：空策略、空名册、全交集、全不相交、部分相交五种情形。
- 三包各自调用它，不各写一份。

## 参考

- ADR 0007
- 根 `GLOSSARY.md`：残留键、当前名册
