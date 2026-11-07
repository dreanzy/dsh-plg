import { defaultPackOf, resolveRow } from './policy.js'
import type { PolicyState } from './store.js'
import type { McpRow, ResolvedRow } from './types.js'

/** 一次求值的产物：与输入行同序的结论，外加按 server 名查询的入口。 */
export interface Effective {
  readonly rows: readonly ResolvedRow[]
  /** 该 server 在当前工作区是否启用。不在本轮清单里的名字一律 false：没有行就没有可加载的东西。 */
  isOpen(name: string): boolean
}

export interface EffectiveInput {
  readonly policy: PolicyState
  /** 本轮要算的行，通常是行发现与托管定义合并后的全量。 */
  readonly rows: readonly McpRow[]
}

/**
 * 一次求值，一份答案。
 *
 * 快照（闸门、名册、`mcp_load`）与路由（面板）都从这里拿结论，浏览器侧不再重算
 * 求值链。纯函数：读盘、缓存与失效都在调用方，这里只吃已加载的状态与行清单。
 */
export function effective(input: EffectiveInput): Effective {
  const { policy, rows } = input
  const defaultPack = defaultPackOf(policy.packs)
  const computed = rows.map((row) =>
    resolveRow(row.rowKey, policy.pack, policy.packId, defaultPack, policy.groups),
  )
  // 宿主按 serverName 互斥，同一个名字最多一行；重复时后者覆盖，与 policies 一致。
  const byName = new Map<string, ResolvedRow>()
  for (const [index, row] of rows.entries()) {
    const value = computed[index]
    if (value !== undefined) byName.set(row.serverName, value)
  }
  return {
    rows: computed,
    isOpen(name) {
      return byName.get(name)?.open ?? false
    },
  }
}
