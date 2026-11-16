import { rankOf, type Rank } from '@dreanzy/dsh-pack-core'
import { defaultPackOf, resolveRow } from './policy.js'
import type { PolicyState } from './store.js'
import type { McpPack, McpRow, ResolvedRow } from './types.js'

/** 一次求值的产物：与输入行同序的结论，外加按 server 名查询的入口。 */
/** 一条差异：这张 pack 相对 default 记录过、且取值不同的键。 */
export interface EffectiveDiff {
  readonly key: string
  readonly isGroup: boolean
  readonly name: string
  readonly on: boolean
}

export interface Effective {
  /**
   * 这份结论是否该被信任。
   *
   * 行发现不完整时（扫描失败、目录读不到），下面的 `open` 只是「已看见的那部分」的
   * 答案，拿它去加载或卸载服务器就是凭半份清单做决定。可信度跟着结论一起走，调用方
   * 不需要再去别处拼一份。
   */
  readonly complete: boolean
  readonly rows: readonly ResolvedRow[]
  /** 选中 pack 相对 default 的差异。未绑定 pack 时为空。 */
  readonly diff: readonly EffectiveDiff[]
  /** 每个分组的排序档位，键是组 id。 */
  readonly groupRanks: Readonly<Record<string, Rank>>
  /** 该 server 在当前工作区是否启用。不在本轮清单里的名字一律 false：没有行就没有可加载的东西。 */
  isOpen(name: string): boolean
}

export interface EffectiveInput {
  readonly policy: PolicyState
  /** 本轮要算的行，通常是行发现与托管定义合并后的全量。 */
  readonly rows: readonly McpRow[]
  /** 行发现是否完整。不完整时这份结论只能显示，不能拿去落地。 */
  readonly complete: boolean
}

/**
 * 一次求值，一份答案。
 *
 * 快照（闸门、名册、`mcp_load`）与路由（面板）都从这里拿结论，浏览器侧不再重算
 * 求值链。纯函数：读盘、缓存与失效都在调用方，这里只吃已加载的状态与行清单。
 */
/**
 * 每个分组的排序档位。
 *
 * 与行的 `rank` 用同一条规则：显式记录优先，否则看跟随时落到哪。`default` 自己
 * 没有上一层，它的「未记录」就等于开。
 */
function groupRanksOf(policy: PolicyState): Record<string, Rank> {
  const pack = policy.pack
  const defaultPack = defaultPackOf(policy.packs)
  const out: Record<string, Rank> = {}
  for (const group of policy.groups.groups) {
    const own = groupValueOf(pack, group.id)
    const landing = groupValueOf(defaultPack, group.id) ?? true
    out[group.id] = rankOf(own, pack === null, landing)
  }
  return out
}

/**
 * 选中 pack 相对 default 的差异。
 *
 * 只比 `enabled`：`mode` / `tools` / `description` 只在内置 `default` 里求值，
 * 分包不读它们。把它们标成「差异」会让用户以为那条键有效，实际不影响任何结果。
 */
function diffOf(policy: PolicyState, rows: readonly McpRow[], computed: readonly ResolvedRow[]): EffectiveDiff[] {
  const pack = policy.pack
  if (pack === null) return []
  const defaultPack = defaultPackOf(policy.packs)
  const out: EffectiveDiff[] = []
  for (const group of policy.groups.groups) {
    const own = groupValueOf(pack, group.id)
    if (own === null) continue
    if (own === (groupValueOf(defaultPack, group.id) ?? true)) continue
    out.push({ key: 'group:' + group.id, isGroup: true, name: group.name, on: own })
  }
  for (const [index, row] of rows.entries()) {
    const resolved = computed[index]
    if (resolved === undefined) continue
    if (resolved.itemWorkspace === null) continue
    const base = resolved.itemGlobal ?? true
    if (resolved.itemWorkspace === base) continue
    out.push({ key: 'row:' + row.rowKey, isGroup: false, name: row.serverName, on: resolved.itemWorkspace })
  }
  return out
}

/** pack 里的组级显式值；没有键或没有组返回 `null`（跟随）。 */
function groupValueOf(pack: McpPack | null, groupId: string | null): boolean | null {
  if (pack === null || groupId === null || !Object.hasOwn(pack.groups, groupId)) return null
  return pack.groups[groupId] ?? null
}

export function effective(input: EffectiveInput): Effective {
  const { policy, rows, complete } = input
  const defaultPack = defaultPackOf(policy.packs)
  const computed = rows.map((row) =>
    resolveRow(row.rowKey, policy.pack, policy.packId, defaultPack, policy.groups, row.declaredDisabled),
  )
  // 宿主按 serverName 互斥，同一个名字最多一行；重复时后者覆盖，与 policies 一致。
  const byName = new Map<string, ResolvedRow>()
  for (const [index, row] of rows.entries()) {
    const value = computed[index]
    if (value !== undefined) byName.set(row.serverName, value)
  }
  return {
    complete,
    rows: computed,
    diff: diffOf(policy, rows, computed),
    groupRanks: groupRanksOf(policy),
    isOpen(name) {
      return byName.get(name)?.open ?? false
    },
  }
}
