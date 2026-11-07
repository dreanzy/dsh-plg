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

export interface Effective {
  readonly complete: boolean
  readonly rows: readonly EffectiveRow[]
  /** 本轮到遮蔽的名字，已排序。清单不完整时为空：那一刻宁可不动。 */
  readonly hidden: readonly string[]
  isOpen(name: string): boolean
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
      itemGlobal: defaultPack.items[name] ?? null,
      itemWorkspace: policy.pack === null ? null : (policy.pack.items[name] ?? null),
      decidedBy: decision.packId,
      decidedVia: decision.via,
    })
  }
  const isOpen = (name: string): boolean => {
    const known = answers.get(name)
    // 清单外的名字仍可问：链本身对任意名字都有答案。
    return known === undefined ? resolver.decide(name).value : known.value
  }
  const hidden = complete ? names.filter((name) => !isOpen(name)).sort() : []
  return { complete, rows, hidden, isOpen }
}
