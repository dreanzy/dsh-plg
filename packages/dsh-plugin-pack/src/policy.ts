/**
 * 求值链、cwd 归一、名册框架与落盘规则同其余包，定义在 `@dreanzy/dsh-pack-core`
 * （见 ADR-0007 与 ADR-0016）。
 */
export { createResolver, normalizeCwd, type Decision, type Resolver, type ResolverInput } from '@dreanzy/dsh-pack-core'
import { createResolver, normalizeCwd, parseRoster, readJson, type RosterConfig } from '@dreanzy/dsh-pack-core'
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

/** 单个域的名字上限，只为防止文件被写成无界清单。写侧也按它拒绝，见 ops.ts。 */
export const MAX_NAMES = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortMap(map: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const key of Object.keys(map).sort()) {
    const value = map[key]
    // defineProperty：`out['__proto__'] = value` 改的是原型，键在序列化时消失。
    if (value !== undefined) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    }
  }
  return out
}

/**
 * 解析一张「名字 → 布尔」表。
 *
 * **不校验名字形状**：表里记录的是用户的决定，不是当前清单的投影；
 * 名字暂时不存在（插件没装、已被移除）时仍要保留，否则卸载再装回来决定就没了。
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
    // defineProperty 而不是赋值：`out['__proto__'] = value` 改的是原型，
    // 键被静默丢弃且没有 warning。
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
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
  // chip 缺省开着：文件里没写这个键时，用户期待入口在。官方插件缺省不列。
  // 未知键（例如已废弃的 `showSidebarEntry`）原样忽略，不报警告。
  return {
    showOfficialPlugins: typeof raw['showOfficialPlugins'] === 'boolean' ? raw['showOfficialPlugins'] : false,
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
/** 名册框架的参数：求值链终点与上限仍是本包的口径（见 ADR-0016）。 */
const ROSTER: RosterConfig<Pack> = {
  defaultPackId: DEFAULT_PACK_ID,
  defaultPackName: DEFAULT_PACK_NAME,
  emptyPack: EMPTY_PACK,
  maxNames: MAX_NAMES,
}

/** 读 `packs.json`：框架在 core，条目与 `ui` 段是本包的形状。 */
export function parsePacks(text: string | undefined): ParseResult<ParsedPacks> {
  return parseRoster(text, { parsePack, parseUi }, ROSTER)
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
      for (const key of Object.keys(rawBindings).sort()) {
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
      for (const [name, groupId] of Object.entries(rawAssignments)) {
        if (typeof groupId !== 'string' || groupId === '') {
          warnings.push(`assignments.${name} 不是分组 id，已忽略`)
          continue
        }
        Object.defineProperty(assignments, name, { value: groupId, enumerable: true, writable: true, configurable: true })
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
    if (packId !== undefined) {
      Object.defineProperty(out, key, { value: packId, enumerable: true, writable: true, configurable: true })
    }
  }
  return serializeRecord({ version: 1, bindings: out })
}

export function serializeGroups(registry: GroupRegistry): string {
  const groups = [...registry.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const assignments: Record<string, string> = {}
  for (const name of Object.keys(registry.assignments).sort()) {
    const groupId = registry.assignments[name]
    if (groupId !== undefined) {
      Object.defineProperty(assignments, name, { value: groupId, enumerable: true, writable: true, configurable: true })
    }
  }
  return serializeRecord({ version: 1, groups, assignments })
}

/** 取名册里的 default。解析保证它存在，这里只是给类型收窄一个出口。 */
export function defaultPackOf(book: PackBook): Pack {
  return book.packs[DEFAULT_PACK_ID] ?? EMPTY_PACK
}

