import {
  DEFAULT_PACK_ID,
  DEFAULT_PACK_NAME,
  EMPTY_BINDINGS,
  EMPTY_GROUPS,
  EMPTY_PACK,
  EMPTY_UI,
  type Bindings,
  type GroupDef,
  type GroupRegistry,
  type Pack,
  type PackBook,
  type ParseResult,
  type UiState,
} from './types.js'

/** 单个域的名字上限，只为防止文件被写成无界清单。 */
const MAX_NAMES = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortMap(map: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const key of Object.keys(map).sort()) {
    const value = map[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 解析一张「名字 → 布尔」表。
 *
 * **不校验名字形状**：表里记录的是用户的决定，不是当前清单的投影；
 * 名字暂时不存在（还没装、已卸载）时仍要保留，否则卸载再装回来决定就没了。
 */
function parseMap(raw: unknown, label: string, warnings: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warnings.push(`${label} 不是对象，已忽略`)
    return out
  }
  const names = Object.keys(raw).sort()
  if (names.length > MAX_NAMES) {
    warnings.push(`${label} 超过 ${MAX_NAMES} 项，已只保留前 ${MAX_NAMES} 项`)
    names.length = MAX_NAMES
  }
  for (const name of names) {
    const value = raw[name]
    if (typeof value !== 'boolean') {
      warnings.push(`${label}.${name} 不是布尔值，已忽略`)
      continue
    }
    out[name] = value
  }
  return out
}

function readJson(text: string | undefined, warnings: string[]): Record<string, unknown> | null {
  if (text === undefined || text.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    warnings.push(`文件不是合法 JSON，已按空策略处理：${String(error)}`)
    return null
  }
  if (!isRecord(raw)) {
    warnings.push('文件顶层不是对象，已按空策略处理')
    return null
  }
  return raw
}

/**
 * 工作区键归一：同一目录的不同写法必须落到同一个键。
 *
 * 反斜杠转正斜杠、剥除尾部斜杠、Windows 下转小写；盘符根目录保留尾斜杠。
 * 这份实现是**唯一一份**：绑定表的键（store）、求值缓存的键（snapshot），
 * 以及任何按 cwd 找绑定的调用点都调它。复制一份必然分叉，表现是「绑定了却不生效」。
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

/** `packs.json` 的解析结果：pack 名册与 `ui` 段同住一个文件。 */
export interface ParsedPacks {
  readonly book: PackBook
  readonly ui: UiState
}

function parseUi(raw: unknown, warnings: string[]): UiState {
  if (raw === undefined) return { ...EMPTY_UI }
  if (!isRecord(raw)) {
    warnings.push('ui 不是对象，已用缺省值')
    return { ...EMPTY_UI }
  }
  // chip 缺省开着：文件里没写这个键时，用户期待入口在。
  // 未知键（例如已废弃的 `showSidebarEntry`）原样忽略，不报警告。
  return {
    showOfficialSkills: typeof raw['showOfficialSkills'] === 'boolean' ? raw['showOfficialSkills'] : false,
    showChip: typeof raw['showChip'] === 'boolean' ? raw['showChip'] : true,
    defaultTab:
      raw['defaultTab'] === 'packs' || raw['defaultTab'] === 'workspace' ? raw['defaultTab'] : 'groups',
  }
}

function parsePack(id: string, raw: unknown, warnings: string[]): Pack {
  if (!isRecord(raw)) {
    warnings.push(`packs.${id} 不是对象，已按空 pack 处理`)
    return { name: id, items: {}, groups: {} }
  }
  const nameRaw = raw['name']
  const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw : id
  if (name !== nameRaw) warnings.push(`packs.${id}.name 缺失或不是非空字符串，已用 id 代替`)
  return {
    name,
    items: parseMap(raw['items'], `packs.${id}.items`, warnings),
    groups: parseMap(raw['groups'], `packs.${id}.groups`, warnings),
  }
}

/**
 * 解析 `packs.json`。
 *
 * `default` 缺席时补一个空 pack：它是求值链的终点，不能不存在。补的行为留一条
 * warning，因为正常写入路径永远会写出 `default`，缺席意味着文件被外部改坏。
 */
export function parsePacks(text: string | undefined): ParseResult<ParsedPacks> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  const ui = parseUi(raw?.['ui'], warnings)
  const packs: Record<string, Pack> = {}

  if (raw !== null) {
    const rawPacks = raw['packs']
    if (rawPacks !== undefined) {
      if (!isRecord(rawPacks)) {
        warnings.push('packs 不是对象，已忽略')
      } else {
        const ids = Object.keys(rawPacks).sort()
        if (ids.length > MAX_NAMES) {
          warnings.push(`packs 超过 ${MAX_NAMES} 个，已只保留前 ${MAX_NAMES} 个`)
          ids.length = MAX_NAMES
        }
        for (const id of ids) {
          if (id === '') {
            warnings.push('packs 里有空 id 的条目，已忽略')
            continue
          }
          const pack = parsePack(id, rawPacks[id], warnings)
          // 内置 pack 的显示名固定「默认」：文件里可能是旧名（default 等），读侧一并归一。
          packs[id] = id === DEFAULT_PACK_ID ? { ...pack, name: DEFAULT_PACK_NAME } : pack
        }
      }
    }
  }

  if (packs[DEFAULT_PACK_ID] === undefined) {
    if (raw !== null) warnings.push('packs 缺少 default，已补一个空 pack')
    packs[DEFAULT_PACK_ID] = EMPTY_PACK
  }
  return { value: { book: { packs }, ui }, warnings }
}

/**
 * 解析 `workspaces.json`。绑定键在读取时归一，缺失即空表。
 *
 * 早期版本这里还有一个 `extra` 数组（手动添加、不属于任何会话的目录）。那个能力已经
 * 移除：目录由宿主提供，本插件只决定绑定。旧文件里的 `extra` 读取时直接忽略，下次写盘
 * 就自然消失——不做迁移，也不为它保留任何分支。
 */
export function parseBindings(text: string | undefined): ParseResult<Bindings> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  if (raw === null) return { value: EMPTY_BINDINGS, warnings }

  const bindings: Record<string, string> = {}
  const rawBindings = raw['bindings']
  if (rawBindings !== undefined) {
    if (!isRecord(rawBindings)) {
      warnings.push('bindings 不是对象，已忽略')
    } else {
      const keys = Object.keys(rawBindings).sort()
      if (keys.length > MAX_NAMES) {
        warnings.push(`bindings 超过 ${MAX_NAMES} 项，已只保留前 ${MAX_NAMES} 项`)
        keys.length = MAX_NAMES
      }
      for (const key of keys) {
        const value = rawBindings[key]
        if (typeof value !== 'string' || value === '') {
          warnings.push(`bindings.${key} 不是 pack id，已忽略`)
          continue
        }
        const normalized = normalizeCwd(key)
        if (normalized === null) {
          warnings.push('bindings 里有空路径，已忽略')
          continue
        }
        bindings[normalized] = value
      }
    }
  }

  // 旧版 `extra` 直接忽略：它不影响求值，也不该在面板上常驻一条告警。
  // 下次这份文件被重写时它就自然消失。
  return { value: { bindings }, warnings }
}

/**
 * 解析组定义。
 *
 * 成员搬进 `assignments`（项为主键），查询「这一项属于哪个组」是 O(1)；
 * 反查「这一组有哪些项」扫一遍即可，几百项的量级不值得维护两份索引。
 * 指向未知分组的条目保留不删：组被临时删除再建回来时语义自动恢复。
 */
export function parseGroups(text: string | undefined): ParseResult<GroupRegistry> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  if (raw === null) return { value: EMPTY_GROUPS, warnings }

  const groups: GroupDef[] = []
  const seen = new Set<string>()
  const rawGroups = raw['groups']
  if (rawGroups !== undefined) {
    if (!Array.isArray(rawGroups)) {
      warnings.push('groups 不是数组，已忽略')
    } else {
      if (rawGroups.length > MAX_NAMES) {
        warnings.push(`groups 超过 ${MAX_NAMES} 个，已只保留前 ${MAX_NAMES} 个`)
        rawGroups.length = MAX_NAMES
      }
      for (const entry of rawGroups) {
        if (!isRecord(entry)) {
          warnings.push('groups 里有非对象元素，已忽略')
          continue
        }
        const id = entry['id']
        const name = entry['name']
        if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') {
          warnings.push('groups 里有缺少 id 或 name 的元素，已忽略')
          continue
        }
        if (seen.has(id)) {
          warnings.push(`分组 id 重复（${id}），已忽略后来者`)
          continue
        }
        seen.add(id)
        groups.push({ id, name })
      }
    }
  }

  const assignments: Record<string, string> = {}
  const rawAssignments = raw['assignments']
  if (rawAssignments !== undefined) {
    if (!isRecord(rawAssignments)) {
      warnings.push('assignments 不是对象，已忽略')
    } else {
      const names = Object.keys(rawAssignments).sort()
      if (names.length > MAX_NAMES) {
        warnings.push(`assignments 超过 ${MAX_NAMES} 项，已只保留前 ${MAX_NAMES} 项`)
        names.length = MAX_NAMES
      }
      for (const name of names) {
        const groupId = rawAssignments[name]
        if (typeof groupId !== 'string' || groupId === '') {
          warnings.push(`assignments.${name} 不是分组 id，已忽略`)
          continue
        }
        assignments[name] = groupId
      }
    }
  }

  return { value: { groups, assignments }, warnings }
}

function serializeRecord(entries: Record<string, unknown>): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

/**
 * 序列化 `packs.json`。
 *
 * 键排序 + 两空格 + 结尾换行是硬要求：同一份策略必须序列化成同一串字节，
 * 否则每次保存都产生一次无意义的 git 差异。`ui` 段总是写全，`default` 总是在。
 */
export function serializePacks(packs: Readonly<Record<string, Pack>>, ui: UiState): string {
  const out: Record<string, unknown> = { version: 1, ui: { ...ui } }
  const packEntries: Record<string, unknown> = {}
  for (const id of Object.keys(packs).sort()) {
    const pack = packs[id]
    if (pack === undefined) continue
    const entry: Record<string, unknown> = { name: id === DEFAULT_PACK_ID ? DEFAULT_PACK_NAME : pack.name }
    if (Object.keys(pack.items).length > 0) entry['items'] = sortMap(pack.items)
    if (Object.keys(pack.groups).length > 0) entry['groups'] = sortMap(pack.groups)
    packEntries[id] = entry
  }
  out['packs'] = packEntries
  return serializeRecord(out)
}

/** 序列化 `workspaces.json`：绑定键排序，只写 `bindings`。 */
export function serializeBindings(bindings: Bindings): string {
  const out: Record<string, string> = {}
  for (const key of Object.keys(bindings.bindings).sort()) {
    const packId = bindings.bindings[key]
    if (packId !== undefined) out[key] = packId
  }
  return serializeRecord({ version: 1, bindings: out })
}

export function serializeGroups(registry: GroupRegistry): string {
  const groups = [...registry.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const assignments: Record<string, string> = {}
  for (const name of Object.keys(registry.assignments).sort()) {
    const groupId = registry.assignments[name]
    if (groupId !== undefined) assignments[name] = groupId
  }
  return serializeRecord({ version: 1, groups, assignments })
}

/** 取名册里的 default。解析保证它存在，这里只是给类型收窄一个出口。 */
export function defaultPackOf(book: PackBook): Pack {
  return book.packs[DEFAULT_PACK_ID] ?? EMPTY_PACK
}

/** 一次求值的结论：值、做出决定的 pack，以及落在 pack 的哪一级。 */
export interface Decision {
  readonly value: boolean
  /** 做出决定的 pack id；取内置缺省时是 `default`。 */
  readonly packId: string
  /** `builtin` 表示两层都没有记录，取缺省值 `true`。 */
  readonly via: 'item' | 'group' | 'builtin'
}

/** 求值上下文：工作区绑定的 pack、default pack 与组归属。 */
export interface ResolverInput {
  /** 工作区绑定的 pack；未绑定、绑定悬空或绑定到 `default` 时为 `null`。 */
  readonly pack: Pack | null
  /** `pack` 的 id；`pack` 为 `null` 时忽略。 */
  readonly packId?: string
  /** 求值链的终点：`packs.json` 里的 `default`。 */
  readonly defaultPack: Pack
  /**
   * 组定义与归属。只有仍存在于 `groups` 里的 id 才参与组级求值：指向已删分组的
   * 残留归属若照旧去 `pack.groups` 取值，一个早已不存在的组还能靠遗留开关
   * 决定 skill 可不可见，而面板上它显示为「未分组」。
   */
  readonly groups: GroupRegistry
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
