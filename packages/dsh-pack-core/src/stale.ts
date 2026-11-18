/**
 * 残留键：策略里有、当前名册里没有的能力项。
 *
 * 通用定义见根 `GLOSSARY.md`。它与「孤儿」的分界是：孤儿是「有东西但认不出归属」，
 * 残留键是「有决定但没有东西」。
 *
 * 判定本身只有一行集合差，抽出来不是为了复用代码，是为了让三包对「什么算残留」
 * 有同一个答案——各写一遍必然分叉，而分叉的后果是同一个包在 plugin 面板里算残留、
 * 在 mcp 面板里不算。
 */

/**
 * 策略里有、名册里没有的键，排序后返回。
 *
 * 不读盘、不碰策略文件形状：调用方各自把「策略里有哪些键」与「名册里有哪些键」
 * 喂进来。策略键通常来自 `pack.items` / `pack.groups` / `assignments` 的并集，
 * 名册来自当前 profile 装了的包名、宿主 skill 快照或 Loader 里的行。
 *
 * @param policyKeys - 策略文件里出现过的键。
 * @param roster - 当前名册里的键。
 * @returns 排序后的残留键；没有时返回空数组。
 */
export function staleKeysOf(
  policyKeys: Iterable<string>,
  roster: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of policyKeys) {
    if (key === '' || seen.has(key) || roster.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out.sort()
}
