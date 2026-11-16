import { rankOf, type Rank } from '@dreanzy/dsh-pack-core'
import { createResolver, defaultPackOf, type Decision } from './policy.js'
import type { PolicyState } from './store.js'

/**
 * 一行的求值结论。
 *
 * `open` 为 `null` 表示这次结论不该被当成生效状态：目录残缺时插件名单本身就
 * 不完整，说「开」或「关」都是假话。`decidedBy` / `decidedVia` 仍保留链自己的
 * 答案，面板可以当诊断显示，但不能拿它当生效状态。
 */
export interface EffectiveRow {
  /** 插件包名，同时是策略里的键。 */
  readonly name: string
  /** 这一项所属的分组 id；未分组为 `null`。 */
  readonly groupId: string | null
  /** 生效值；目录残缺时为 `null`。 */
  readonly open: boolean | null
  /** 工作区绑定的 pack 里这一项的项级记录；未绑定或没有键为 `null`（跟随）。 */
  readonly itemWorkspace: boolean | null
  /** `default` pack 里这一项的项级记录；没有键为 `null`。 */
  readonly itemGlobal: boolean | null
  /** 只按 default pack 求值的值。它与目录是否完整无关。 */
  readonly openGlobal: boolean
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
  /** 决定落在 pack 的哪一级。 */
  readonly decidedVia: Decision['via']
}

export interface EffectiveInput {
  /** 已加载的状态；本模块不读盘。 */
  readonly policy: PolicyState
  /** 要算的名字，通常是目录里的全量包名。 */
  readonly names: readonly string[]
  /**
   * `global` 只走 default 层与内置缺省，`workspace` 从工作区绑定的 pack 起跳。
   * 绑定了 pack 时两者之差正是「这一行有没有被工作区覆盖」。
   */
  readonly scope: 'global' | 'workspace'
  /** 目录是否完整。不完整时 `open` 一律为 `null`。 */
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
  /**
   * 装配路径只要这一个：plugin 的遮蔽按「包 → 段 / 工具」展开，装配自己是展开者，
   * 不需要一份已经展开好的关闭名单。
   */
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
 * 求值链只在这里组装一次：面板读 `rows`，遮蔽读 `isOpen`，两者必定同源。
 * 浏览器侧不再重算——那条链已经从 client.js 删掉。
 */
export function effective(input: EffectiveInput): Effective {
  const { policy, names, scope, complete } = input
  const defaultPack = defaultPackOf(policy.packs)
  const groups = policy.groups
  const ownPack = policy.pack
  const resolver = createResolver(
    scope === 'workspace'
      ? { pack: ownPack, packId: policy.packId, defaultPack, groups }
      : { pack: null, defaultPack, groups },
  )

  const globalResolver = createResolver({ pack: null, defaultPack, groups })
  const rows: EffectiveRow[] = []
  for (const name of names) {
    const decision = resolver.decide(name)
    const groupId = resolver.groupOf(name)
    const landing = groupValueOf(ownPack, groupId) ?? globalResolver.decide(name).value
    rows.push({
      name,
      groupId: groupId ?? null,
      open: complete ? decision.value : null,
      itemWorkspace: itemValueOf(ownPack, name),
      itemGlobal: itemValueOf(defaultPack, name),
      openGlobal: globalResolver.decide(name).value,
      groupGlobal: groupValueOf(defaultPack, groupId),
      groupWorkspace: groupValueOf(ownPack, groupId),
      landing,
      rank: rankOf(itemValueOf(ownPack, name), ownPack === null, landing),
      decidedBy: decision.packId,
      decidedVia: decision.via,
    })
  }

  return {
    complete,
    rows,
    diff: diffOf(policy, names),
    groupRanks: groupRanksOf(policy),
    isOpen: (name) => resolver.isOpen(name),
  }
}
