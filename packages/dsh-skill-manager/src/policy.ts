import {
  EMPTY_GLOBAL,
  EMPTY_GROUPS,
  EMPTY_LAYER,
  type GlobalPolicy,
  type GroupDef,
  type GroupRegistry,
  type LayerPolicy,
  type ParseResult,
} from './types.js'

/** 单个域的名字上限，只为防止文件被写成无界清单。 */
const MAX_NAMES = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortMap(map: Record<string, boolean>): Record<string, boolean> {
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

export function parseLayer(text: string | undefined): ParseResult<LayerPolicy> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  if (raw === null) return { value: EMPTY_LAYER, warnings }
  return {
    value: {
      items: parseMap(raw['items'], 'items', warnings),
      groups: parseMap(raw['groups'], 'groups', warnings),
    },
    warnings,
  }
}

export function parseGlobal(text: string | undefined): ParseResult<GlobalPolicy> {
  const warnings: string[] = []
  const raw = readJson(text, warnings)
  if (raw === null) return { value: EMPTY_GLOBAL, warnings }
  const ui = raw['ui']
  const showOfficialSkills =
    isRecord(ui) && typeof ui['showOfficialSkills'] === 'boolean' ? ui['showOfficialSkills'] : false
  // 侧栏入口缺省开着：文件里没写这个键时，用户期待入口在。
  const showSidebarEntry = isRecord(ui) && typeof ui['showSidebarEntry'] === 'boolean' ? ui['showSidebarEntry'] : true
  return {
    value: {
      items: parseMap(raw['items'], 'items', warnings),
      groups: parseMap(raw['groups'], 'groups', warnings),
      showOfficialSkills,
      showSidebarEntry,
    },
    warnings,
  }
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
 * 序列化一层策略。
 *
 * 键排序 + 两空格 + 结尾换行是硬要求：同一份策略必须序列化成同一串字节，
 * 否则每次保存都产生一次无意义的 git 差异。
 */
export function serializeLayer(layer: LayerPolicy): string {
  const out: Record<string, unknown> = { version: 1 }
  if (Object.keys(layer.items).length > 0) out['items'] = sortMap(layer.items)
  if (Object.keys(layer.groups).length > 0) out['groups'] = sortMap(layer.groups)
  return serializeRecord(out)
}

export function serializeGlobal(policy: GlobalPolicy): string {
  const out: Record<string, unknown> = { version: 1 }
  if (Object.keys(policy.items).length > 0) out['items'] = sortMap(policy.items)
  if (Object.keys(policy.groups).length > 0) out['groups'] = sortMap(policy.groups)
  out['ui'] = { showOfficialSkills: policy.showOfficialSkills, showSidebarEntry: policy.showSidebarEntry }
  return serializeRecord(out)
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

/** 求值上下文：两层策略与组归属。 */
export interface ResolverInput {
  readonly workspace: LayerPolicy | null
  readonly global: GlobalPolicy
  readonly assignments: Readonly<Record<string, string>>
}

export interface Resolver {
  /** 某一项此刻是否开着。 */
  isOpen(name: string): boolean
  /** 某一项的分组 id，未分组时 `undefined`。 */
  groupOf(name: string): string | undefined
}

/**
 * 建一个求值器，链序是 `工作区项级 ?? 工作区组级 ?? 全局项级 ?? 全局组级 ?? 开`。
 *
 * 层优先：工作区的任何决定（项级或组级）都压过全局的任何决定。若让全局项级
 * 压过工作区组级，就会出现「在工作区点了开、界面显示开、模型看不见」的状态。
 *
 * 用 `!== undefined` 而不是 `||`：`false` 是「明令关」，必须原样保留。
 */
export function createResolver(input: ResolverInput): Resolver {
  const { workspace, global, assignments } = input
  const groupOf = (name: string): string | undefined => {
    const groupId = assignments[name]
    return groupId === undefined || groupId === '' ? undefined : groupId
  }
  const isOpen = (name: string): boolean => {
    const groupId = groupOf(name)
    if (workspace !== null) {
      const own = workspace.items[name]
      if (own !== undefined) return own
      if (groupId !== undefined) {
        const byGroup = workspace.groups[groupId]
        if (byGroup !== undefined) return byGroup
      }
    }
    const top = global.items[name]
    if (top !== undefined) return top
    if (groupId !== undefined) {
      const byGroup = global.groups[groupId]
      if (byGroup !== undefined) return byGroup
    }
    return true
  }
  return { isOpen, groupOf }
}

/** 从清单里挑出被关掉的名字，排序后返回（用于比较是否变化）。 */
export function hiddenNames(names: readonly string[], resolver: Resolver): string[] {
  const hidden: string[] = []
  for (const name of names) {
    if (!resolver.isOpen(name)) hidden.push(name)
  }
  return hidden.sort()
}
