/** 内置 pack 的 id。它是求值链的终点。 */
const DEFAULT_PACK_ID = 'default'

/**
 * 工作区键归一：同一目录的不同写法必须落到同一个键。
 *
 * 反斜杠转正斜杠、剥除尾部斜杠、Windows 下转小写；盘符根目录保留尾斜杠。
 * 这份实现是**唯一一份**：绑定表的键（store）、求值缓存的键（snapshot），以及任何
 * 按 cwd 找绑定的调用点都调它。此前三个包各抄一份，注释里写着「必须逐字节一致」——
 * 那正是它该住在这里的理由。
 */
export function normalizeCwd(cwd: string | null): string | null {
  if (cwd === null) return null
  const trimmed = cwd.trim()
  if (trimmed === '') return null
  let unified = trimmed.replace(/\\/gu, '/')
  if (process.platform === 'win32') unified = unified.toLowerCase()
  if (unified.length > 1) {
    const stripped = unified.replace(/\/+$/u, '')
    if (stripped === '') return '/'
    // `C:/` 去掉尾斜杠会变成 `C:`，那不是一个目录。
    return /^[a-z]:$/iu.test(stripped) ? stripped + '/' : stripped
  }
  return unified
}


/**
 * 一行的排序档位。
 *
 * 四档：显式开、显式关、跟随且落到开、跟随且落到关。两种跟随在界面上长得一样，
 * 但一个等于开、一个等于关，混在同一档里用户没法按状态扫读。
 *
 * `default` 没有上一层，它的「未记录」就等于开，所以直接归 `explicit-on`——否则
 * 同一屏会出现「排在跟随档、按钮却亮在开上」的错位。
 *
 * 落点未知（清单没扫全）按跟随档排：档位只是视觉分段，不拿它表达不确定性。
 */
export type Rank = 'explicit-on' | 'explicit-off' | 'follow-on' | 'follow-off'

/** 档位的排序序：显式在前，跟随在后，同档内按名字。 */
export const RANK_ORDER: Readonly<Record<Rank, number>> = {
  'explicit-on': 0,
  'explicit-off': 1,
  'follow-on': 2,
  'follow-off': 3,
}

/**
 * 算一行的档位。
 *
 * `explicit` 是这一行在**当前 pack** 里的显式记录（`null` 表示跟随）；
 * `isDefault` 表示当前看的正是 `default` 自己（它没有上一层）；
 * `landing` 是跟随时会落到的值，`null` 表示落点未知。
 */
export function rankOf(explicit: boolean | null, isDefault: boolean, landing: boolean | null): Rank {
  if (explicit === true) return 'explicit-on'
  if (explicit === false) return 'explicit-off'
  if (isDefault) return 'explicit-on'
  if (landing === null) return 'follow-on'
  return landing ? 'follow-on' : 'follow-off'
}

/** 一次求值的结论：值、做出决定的 pack，以及落在 pack 的哪一级。 */
export interface Decision {
  readonly value: boolean
  /** 做出决定的 pack id；取内置缺省时是 `default`。 */
  readonly packId: string
  /** `builtin` 表示两层都没有记录，取缺省值 `true`。 */
  readonly via: 'item' | 'group' | 'builtin'
}

/** 求值链需要的最小 pack 形状：项级开关表 + 组级开关表。 */
export interface PackLike {
  readonly items: Readonly<Record<string, boolean>>
  readonly groups: Readonly<Record<string, boolean>>
}

/** 组定义与归属；指向不存在分组的残留归属不参与求值。 */
export interface GroupRegistryLike {
  readonly groups: readonly { readonly id: string; readonly name: string }[]
  readonly assignments: Readonly<Record<string, string>>
}

/** 求值上下文：工作区绑定的 pack、default pack 与组归属。 */
export interface ResolverInput {
  /** 工作区绑定的 pack；未绑定、绑定悬空或绑定到 `default` 时为 `null`。 */
  readonly pack: PackLike | null
  /** `pack` 的 id；`pack` 为 `null` 时忽略。 */
  readonly packId?: string
  /** 求值链的终点：`packs.json` 里的 `default`。 */
  readonly defaultPack: PackLike
  /**
   * 组定义与归属。只有仍存在于 `groups` 里的 id 才参与组级求值：指向已删分组的
   * 残留归属若照旧去 `pack.groups` 取值，一个早已不存在的组还能决定项可不可见。
   */
  readonly groups: GroupRegistryLike
}

export interface Resolver {
  /** 某一项此刻是否开着。 */
  isOpen(name: string): boolean
  /** 某一项的分组 id，未分组时 `undefined`。 */
  groupOf(name: string): string | undefined
  /** 某一项的决定来源；都没有记录时返回内置缺省。 */
  decide(name: string): Decision
}

/**
 * 建一个求值器，链序是：
 *
 * ```
 * pack.items[项] ?? pack.groups[组] ?? default.items[项] ?? default.groups[组] ?? true
 * ```
 *
 * 用 `!== undefined` 而不是 `||`：`false` 是「明令关」，必须原样保留。
 * 绑定悬空时调用方传 `pack: null`，求值自然退回 `default`。
 */
export function createResolver(input: ResolverInput): Resolver {
  const { pack, defaultPack, groups } = input
  const packId = pack === null ? DEFAULT_PACK_ID : (input.packId ?? DEFAULT_PACK_ID)
  const groupOf = (name: string): string | undefined => {
    const groupId = groups.assignments[name]
    if (groupId === undefined || groupId === '') return undefined
    for (const group of groups.groups) {
      if (group.id === groupId) return groupId
    }
    return undefined
  }
  const decide = (name: string): Decision => {
    const groupId = groupOf(name)
    if (pack !== null) {
      const own = pack.items[name]
      if (own !== undefined) return { value: own, packId, via: 'item' }
      if (groupId !== undefined) {
        const byGroup = pack.groups[groupId]
        if (byGroup !== undefined) return { value: byGroup, packId, via: 'group' }
      }
    }
    const top = defaultPack.items[name]
    if (top !== undefined) return { value: top, packId: DEFAULT_PACK_ID, via: 'item' }
    if (groupId !== undefined) {
      const byGroup = defaultPack.groups[groupId]
      if (byGroup !== undefined) return { value: byGroup, packId: DEFAULT_PACK_ID, via: 'group' }
    }
    return { value: true, packId: DEFAULT_PACK_ID, via: 'builtin' }
  }
  return { isOpen: (name) => decide(name).value, groupOf, decide }
}
