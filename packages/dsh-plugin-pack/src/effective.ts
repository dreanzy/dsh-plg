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

export interface Effective {
  readonly complete: boolean
  readonly rows: readonly EffectiveRow[]
  /**
   * 装配路径只要这一个：plugin 的遮蔽按「包 → 段 / 工具」展开，装配自己是展开者，
   * 不需要一份已经展开好的关闭名单。
   */
  isOpen(name: string): boolean
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

  const rows: EffectiveRow[] = []
  for (const name of names) {
    const decision = resolver.decide(name)
    rows.push({
      name,
      groupId: resolver.groupOf(name) ?? null,
      open: complete ? decision.value : null,
      itemWorkspace: ownPack === null ? null : (ownPack.items[name] ?? null),
      itemGlobal: defaultPack.items[name] ?? null,
      decidedBy: decision.packId,
      decidedVia: decision.via,
    })
  }

  return { complete, rows, isOpen: (name) => resolver.isOpen(name) }
}
