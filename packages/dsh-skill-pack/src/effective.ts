import { rankOf, type Rank } from '@dreanzy/dsh-pack-core'
import { createResolver, defaultPackOf, type Decision } from './policy.js'
import type { PolicyState } from './store.js'

/**
 * 一行的求值结论。
 *
 * `open` 为 `null` 表示这次结论不该被信任：清单不完整时遮蔽集会被当成空集，
 * 此时说「关」就是假话。`decidedBy` / `decidedVia` 仍保留链自己的答案，面板可以
 * 当诊断显示，但不能当生效状态。
 */
export interface EffectiveRow {
  readonly name: string
  readonly groupId: string | null
  /** 生效值；清单不完整时为 `null`。 */
  readonly open: boolean | null
  /** 只按 default pack 求值的值。它与清单是否完整无关。 */
  readonly openGlobal: boolean
  /** default pack 里这一项的项级记录；没有键为 `null`（跟随）。 */
  readonly itemGlobal: boolean | null
  /** 工作区绑定的 pack 里这一项的项级记录；未绑定或没有键为 `null`。 */
  readonly itemWorkspace: boolean | null
  /** default pack 里这一项所属组的组级记录；没有键为 `null`。 */
  readonly groupGlobal: boolean | null
  /** 工作区绑定的 pack 里这一项所属组的组级记录；没有键为 `null`。 */
  readonly groupWorkspace: boolean | null
  /** 跟随时会落到的值：选中 pack 的组级记录优先，否则 `openGlobal`。 */
  readonly landing: boolean
  /** 排序档位。四档的规则见 core 的 `rankOf`。 */
  readonly rank: Rank
  /** 做出决定的 pack id；落到内置缺省时是 `default`。 */
  readonly decidedBy: string
  readonly decidedVia: Decision['via']
}

export interface EffectiveInput {
  readonly policy: PolicyState
  /** 要算的名字，通常是清单里的全量名字。 */
  readonly names: readonly string[]
  readonly scope: 'global' | 'workspace'
  /** 清单是否完整。不完整时 `open` 一律为 `null`，`hidden` 为空。 */
  readonly complete: boolean
}

/** 一条差异：这张 pack 相对 default 记录过、且取值不同的键。 */
export interface EffectiveDiff {
  readonly key: string
  readonly isGroup: boolean
  readonly name: string
  readonly on: boolean
}

export interface Effective {
  readonly complete: boolean
  readonly rows: readonly EffectiveRow[]
  /** 选中 pack 相对 default 的差异。未绑定 pack 时为空。 */
  readonly diff: readonly EffectiveDiff[]
  /** 每个分组的排序档位，键是组 id。 */
  readonly groupRanks: Readonly<Record<string, Rank>>
  /** 本轮到遮蔽的名字，已排序。清单不完整时为空：那一刻宁可不动。 */
  readonly hidden: readonly string[]
  isOpen(name: string): boolean
}

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
 * 只列「记录过、且与 default 取值不同」的键。没有键是「不表态」，与 default 同值的
 * 记录不改变任何结果——两者都不算「差在哪」。
 *
 * 组已从注册表删掉时没有名字可显示：那是悬空引用，不是差异。
 */
function diffOf(policy: PolicyState, names: readonly string[]): EffectiveDiff[] {
  const pack = policy.pack
  if (pack === null) return []
  const defaultPack = defaultPackOf(policy.packs)
  const rows: EffectiveDiff[] = []
  for (const group of policy.groups.groups) {
    const own = groupValueOf(pack, group.id)
    if (own === null) continue
    if (own === (groupValueOf(defaultPack, group.id) ?? true)) continue
    rows.push({ key: 'group:' + group.id, isGroup: true, name: group.name, on: own })
  }
  for (const name of names) {
    const own = itemValueOf(pack, name)
    if (own === null) continue
    const groupId = policy.groups.assignments[name]
    const base = itemValueOf(defaultPack, name) ?? groupValueOf(defaultPack, groupId)
    if (own === (base ?? true)) continue
    rows.push({ key: 'item:' + name, isGroup: false, name, on: own })
  }
  return rows
}

/** pack 里的项级显式值；没有键返回 `null`（跟随）。用 hasOwn 防原型链。 */
function itemValueOf(pack: { readonly items: Readonly<Record<string, boolean>> } | null, name: string): boolean | null {
  if (pack === null || !Object.hasOwn(pack.items, name)) return null
  return pack.items[name] ?? null
}

/** pack 里的组级显式值；没有键或没有组返回 `null`（跟随）。 */
function groupValueOf(
  pack: { readonly groups: Readonly<Record<string, boolean>> } | null,
  groupId: string | undefined,
): boolean | null {
  if (pack === null || groupId === undefined || !Object.hasOwn(pack.groups, groupId)) return null
  return pack.groups[groupId] ?? null
}

/**
 * 一次求值，一份答案。
 *
 * 求值链只在这里组装一次：装配路径要 `hidden`，面板要 `rows`，两个读者拿到的
 * 必定是同一份结论。浏览器侧不再重算——那条链已经删掉了。
 */
export function effective(input: EffectiveInput): Effective {
  const { policy, names, scope, complete } = input
  const defaultPack = defaultPackOf(policy.packs)
  const groups = policy.groups
  const resolver = createResolver(
    scope === 'workspace'
      ? { pack: policy.pack, packId: policy.packId, defaultPack, groups }
      : { pack: null, defaultPack, groups },
  )
  const globalResolver = createResolver({ pack: null, defaultPack, groups })
  const answers = new Map<string, Decision>()
  const rows: EffectiveRow[] = []
  for (const name of names) {
    const decision = resolver.decide(name)
    answers.set(name, decision)
    rows.push({
      name,
      groupId: resolver.groupOf(name) ?? null,
      open: complete ? decision.value : null,
      openGlobal: globalResolver.decide(name).value,
      // 用 hasOwn 而不是直接索引：`items['toString']` 会拿到原型上的函数，
      // 被当成「用户设过这个键」。
      itemGlobal: Object.hasOwn(defaultPack.items, name) ? (defaultPack.items[name] ?? null) : null,
      itemWorkspace:
        policy.pack === null
          ? null
          : Object.hasOwn(policy.pack.items, name)
            ? (policy.pack.items[name] ?? null)
            : null,
      groupGlobal: groupValueOf(defaultPack, resolver.groupOf(name)),
      groupWorkspace: groupValueOf(policy.pack, resolver.groupOf(name)),
      landing: groupValueOf(policy.pack, resolver.groupOf(name)) ?? globalResolver.decide(name).value,
      rank: rankOf(
        policy.pack === null ? null : itemValueOf(policy.pack, name),
        policy.pack === null,
        groupValueOf(policy.pack, resolver.groupOf(name)) ?? globalResolver.decide(name).value,
      ),
      decidedBy: decision.packId,
      decidedVia: decision.via,
    })
  }
  const isOpen = (name: string): boolean => {
    const known = answers.get(name)
    // 清单外的名字仍可问：链本身对任意名字都有答案。
    return known === undefined ? resolver.decide(name).value : known.value
  }
  // 去重：宿主允许不同 provider 注册同名 skill，清单里会出现重复名字。
  // 不去重会让 hidden 里出现两份同名项，遮蔽注册与 stuck 复验都多算一次。
  const hidden = complete ? [...new Set(names)].filter((name) => !isOpen(name)).sort() : []
  return { complete, rows, diff: diffOf(policy, names), groupRanks: groupRanksOf(policy), hidden, isOpen }
}
