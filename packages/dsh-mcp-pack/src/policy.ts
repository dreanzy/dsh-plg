import {
  DEFAULT_MODE,
  DEFAULT_PACK_ID,
  EMPTY_BINDINGS,
  EMPTY_GROUPS,
  EMPTY_PACK,
  EMPTY_UI,
  MODES,
  type Bindings,
  type FieldSource,
  type GroupDef,
  type GroupRegistry,
  type McpPack,
  type Mode,
  type PackBook,
  type ParseResult,
  type ResolvedRow,
  type RowPolicy,
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

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * 解析一张「名字 → 布尔」表（组级开关）。
 *
 * 不校验名字形状：表里记录的是用户的决定，组被临时删掉再建回来时决定要还在。
 */
function parseBoolMap(raw: unknown, label: string, warnings: string[]): Record<string, boolean> {
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
 * 这份实现是**唯一一份**：绑定表的键、旧工作区层的读取、快照的缓存键以及任何
 * 按 cwd 找绑定的调用点都调它。复制一份必然分叉，表现是「绑定了却不生效」。
 * 三个 pack 包（skill / plugin / mcp）必须逐字节一致。
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
 * 解析一条行策略。
 *
 * 四个字段各自独立：坏字段只丢自己，不牵连同行的好字段。未知键忽略不报错。
 */
function parseRow(rowKey: string, raw: unknown, warnings: string[]): RowPolicy | null {
  if (!isRecord(raw)) {
    warnings.push(`忽略 ${rowKey}：不是对象`)
    return null
  }
  const policy: { enabled?: boolean; mode?: Mode; tools?: readonly string[]; description?: string } = {}
  if ('enabled' in raw) {
    if (typeof raw['enabled'] === 'boolean') policy.enabled = raw['enabled']
    else warnings.push(`忽略 ${rowKey}.enabled：不是布尔值`)
  }
  if ('mode' in raw) {
    if (isMode(raw['mode'])) policy.mode = raw['mode']
    else warnings.push(`忽略 ${rowKey}.mode：不是合法的模式`)
  }
  if ('tools' in raw) {
    const tools = raw['tools']
    if (Array.isArray(tools) && tools.every((item): item is string => typeof item === 'string')) {
      policy.tools = tools
    } else {
      warnings.push(`忽略 ${rowKey}.tools：不是字符串数组`)
    }
  }
  if ('description' in raw) {
    const description = raw['description']
    if (typeof description === 'string') policy.description = description
    else warnings.push(`忽略 ${rowKey}.description：不是字符串`)
  }
  return policy
}

function parseRows(raw: unknown, label: string, warnings: string[]): Record<string, RowPolicy> {
  const out: Record<string, RowPolicy> = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warnings.push(`${label} 不是对象，已忽略`)
    return out
  }
  const keys = Object.keys(raw).sort()
  if (keys.length > MAX_NAMES) {
    warnings.push(`${label} 超过 ${MAX_NAMES} 行，已只保留前 ${MAX_NAMES} 行`)
    keys.length = MAX_NAMES
  }
  for (const rowKey of keys) {
    const parsed = parseRow(rowKey, raw[rowKey], warnings)
    if (parsed !== null) out[rowKey] = parsed
  }
  return out
}

function parseUi(raw: unknown, warnings: string[]): UiState {
  if (raw === undefined) return { ...EMPTY_UI }
  if (!isRecord(raw)) {
    warnings.push('ui 不是对象，已用缺省值')
    return { ...EMPTY_UI }
  }
  // 未知键（例如已废弃的 `showSidebarEntry`）原样忽略，不报警告。
  return {
    showChip: typeof raw['showChip'] === 'boolean' ? raw['showChip'] : true,
    defaultTab:
      raw['defaultTab'] === 'servers' || raw['defaultTab'] === 'packs' || raw['defaultTab'] === 'workspace'
        ? raw['defaultTab']
        : 'groups',
  }
}

function parsePack(id: string, raw: unknown, warnings: string[]): McpPack {
  if (!isRecord(raw)) {
    warnings.push(`packs.${id} 不是对象，已按空 pack 处理`)
    return { name: id, groups: {}, rows: {} }
  }
  const nameRaw = raw['name']
  const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw : id
  if (name !== nameRaw) warnings.push(`packs.${id}.name 缺失或不是非空字符串，已用 id 代替`)
  return {
    name,
    groups: parseBoolMap(raw['groups'], `packs.${id}.groups`, warnings),
    rows: parseRows(raw['rows'], `packs.${id}.rows`, warnings),
  }
}

/** `packs.json` 的解析结果：pack 名册与 `ui` 段同住一个文件。 */
export interface ParsedPacks {
  readonly book: PackBook
  readonly ui: UiState
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
  const packs: Record<string, McpPack> = {}

  const rawPacks = raw?.['packs']
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
        packs[id] = parsePack(id, rawPacks[id], warnings)
      }
    }
  }

  if (packs[DEFAULT_PACK_ID] === undefined) {
    if (raw !== null) warnings.push('packs 缺少 default，已补一个空 pack')
    packs[DEFAULT_PACK_ID] = EMPTY_PACK
  }
  return { value: { book: { packs }, ui }, warnings }
}

/** 解析 `workspaces.json`。绑定键与 `extra` 都在读取时归一，缺失即空表。 */
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

  const extra: string[] = []
  const rawExtra = raw['extra']
  if (rawExtra !== undefined) {
    if (!Array.isArray(rawExtra)) {
      warnings.push('extra 不是数组，已忽略')
    } else {
      for (const entry of rawExtra) {
        if (typeof entry !== 'string') {
          warnings.push('extra 里有非字符串元素，已忽略')
          continue
        }
        const normalized = normalizeCwd(entry)
        if (normalized === null) continue
        if (!extra.includes(normalized)) extra.push(normalized)
      }
    }
  }

  return { value: { bindings, extra }, warnings }
}

/**
 * 解析组定义。
 *
 * 成员搬进 `assignments`（行键为主键），查询「这一行属于哪个组」是 O(1)；
 * 反查「这一组有哪些行」扫一遍即可，几百行的量级不值得维护两份索引。
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
      for (const [rowKey, groupId] of Object.entries(rawAssignments)) {
        if (typeof groupId !== 'string' || groupId === '') {
          warnings.push(`assignments.${rowKey} 不是分组 id，已忽略`)
          continue
        }
        assignments[rowKey] = groupId
      }
    }
  }

  return { value: { groups, assignments }, warnings }
}

function serializeRecord(entries: Record<string, unknown>): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

function serializeRow(source: RowPolicy): RowPolicy {
  const row: { enabled?: boolean; mode?: Mode; tools?: readonly string[]; description?: string } = {}
  if (source.enabled !== undefined) row.enabled = source.enabled
  if (source.mode !== undefined) row.mode = source.mode
  if (source.tools !== undefined) row.tools = source.tools
  if (source.description !== undefined) row.description = source.description
  return row
}

/**
 * 序列化 `packs.json`。
 *
 * 键排序 + 两空格 + 结尾换行是硬要求：同一份策略必须序列化成同一串字节，
 * 否则每次保存都产生一次无意义的 git 差异。`ui` 段总是写全，`default` 总是在。
 */
export function serializePacks(packs: Readonly<Record<string, McpPack>>, ui: UiState): string {
  const out: Record<string, unknown> = { version: 1, ui: { ...ui } }
  const packEntries: Record<string, unknown> = {}
  for (const id of Object.keys(packs).sort()) {
    const pack = packs[id]
    if (pack === undefined) continue
    const entry: Record<string, unknown> = { name: pack.name }
    if (Object.keys(pack.rows).length > 0) {
      const rows: Record<string, RowPolicy> = {}
      for (const rowKey of Object.keys(pack.rows).sort()) {
        const row = pack.rows[rowKey]
        if (row === undefined) continue
        rows[rowKey] = serializeRow(row)
      }
      entry['rows'] = rows
    }
    if (Object.keys(pack.groups).length > 0) entry['groups'] = sortMap(pack.groups)
    packEntries[id] = entry
  }
  out['packs'] = packEntries
  return serializeRecord(out)
}

/** 序列化 `workspaces.json`：绑定键排序，`extra` 保持用户添加顺序。 */
export function serializeBindings(bindings: Bindings): string {
  const out: Record<string, string> = {}
  for (const key of Object.keys(bindings.bindings).sort()) {
    const packId = bindings.bindings[key]
    if (packId !== undefined) out[key] = packId
  }
  return serializeRecord({ version: 1, bindings: out, extra: [...bindings.extra] })
}

export function serializeGroups(registry: GroupRegistry): string {
  const groups = [...registry.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const assignments: Record<string, string> = {}
  for (const rowKey of Object.keys(registry.assignments).sort()) {
    const groupId = registry.assignments[rowKey]
    if (groupId !== undefined) assignments[rowKey] = groupId
  }
  return serializeRecord({ version: 1, groups, assignments })
}

/** 取名册里的 default。解析保证它存在，这里只是给类型收窄一个出口。 */
export function defaultPackOf(book: PackBook): McpPack {
  return book.packs[DEFAULT_PACK_ID] ?? EMPTY_PACK
}

/** 一行在某 pack 里的原始条目；没有条目即跟随。 */
export function rowEntryOf(pack: McpPack | null, rowKey: string): RowPolicy | null {
  if (pack === null) return null
  return pack.rows[rowKey] ?? null
}

/** 某个行键的分组 id；未分组为 `undefined`。 */
export function groupOf(assignments: Readonly<Record<string, string>>, rowKey: string): string | undefined {
  const groupId = assignments[rowKey]
  return groupId === undefined || groupId === '' ? undefined : groupId
}

/** 一个字段的决定：值、做出决定的那一层。 */
interface FieldPick<T> {
  readonly value: T | undefined
  readonly source: FieldSource
}

/**
 * `enabled` 的求值：行级 → 组级 → 上一层的行级 → 上一层的组级 → 开。
 *
 * 组级只出现在 `enabled` 这一条链上：它没有 mode/tools/description 可给。
 * 用 `!== undefined` 而不是 `||`：`false` 是「明令关」，必须原样保留。
 */
function pickEnabled(
  rowKey: string,
  pack: McpPack | null,
  defaultPack: McpPack,
  groupId: string | undefined,
): FieldPick<boolean> {
  if (pack !== null) {
    const own = pack.rows[rowKey]?.enabled
    if (own !== undefined) return { value: own, source: 'pack' }
    if (groupId !== undefined) {
      const byGroup = pack.groups[groupId]
      if (byGroup !== undefined) return { value: byGroup, source: 'pack' }
    }
  }
  const top = defaultPack.rows[rowKey]?.enabled
  if (top !== undefined) return { value: top, source: 'default' }
  if (groupId !== undefined) {
    const byGroup = defaultPack.groups[groupId]
    if (byGroup !== undefined) return { value: byGroup, source: 'default' }
  }
  return { value: undefined, source: 'builtin' }
}

/**
 * `mode` / `tools` / `description` 的求值：**只读 `default` pack**。
 *
 * 这三项描述的是「这台服务器本身怎么加载、说什么」，天然是全局的；按工作区
 * 换加载方式没有意义，反而会让同一个服务在不同目录表现不同，排查成本极高。
 * 只有 `enabled`（列不列给模型）才按 pack 覆盖。
 *
 * 非 default pack 里若残留这三个字段（旧工作区层迁移而来），一律不参与求值。
 */
function pickField<T>(
  rowKey: string,
  defaultPack: McpPack,
  key: 'mode' | 'tools' | 'description',
): FieldPick<T> {
  const top = defaultPack.rows[rowKey]?.[key]
  if (top !== undefined) return { value: top as T, source: 'default' }
  return { value: undefined, source: 'builtin' }
}

/**
 * 求值一行：四个字段各自独立走「绑定 pack → default → 内置缺省」。
 *
 * 字段级独立是刻意的：某个 pack 只关了某行、模式仍沿用 default，是常见组合。
 * 合并成「整行取最具体的那个 pack」会让这种组合表达不出来。
 *
 * `assignments` 默认空表：没有分组信息时组级两环自然跳过，逐字段链不受影响。
 */
export function resolveRow(
  rowKey: string,
  pack: McpPack | null,
  defaultPack: McpPack,
  assignments: Readonly<Record<string, string>> = {},
): ResolvedRow {
  const groupId = groupOf(assignments, rowKey) ?? null
  const enabled = pickEnabled(rowKey, pack, defaultPack, groupId ?? undefined)
  const mode = pickField<Mode>(rowKey, defaultPack, 'mode')
  const tools = pickField<readonly string[]>(rowKey, defaultPack, 'tools')
  const description = pickField<string>(rowKey, defaultPack, 'description')

  const sources = {
    enabled: enabled.source,
    mode: mode.source,
    tools: tools.source,
    description: description.source,
  }
  const all = [sources.enabled, sources.mode, sources.tools, sources.description]
  const from: FieldSource = all.includes('pack') ? 'pack' : all.includes('default') ? 'default' : 'builtin'

  return {
    rowKey,
    enabled: enabled.value ?? true,
    mode: mode.value ?? DEFAULT_MODE,
    tools: tools.value ?? [],
    description: description.value ?? '',
    groupId,
    from,
    sources,
  }
}

/** 按 rowKey 集合求值全部行，保持传入顺序。 */
export function resolveAll(
  rowKeys: readonly string[],
  pack: McpPack | null,
  defaultPack: McpPack,
  assignments: Readonly<Record<string, string>> = {},
): readonly ResolvedRow[] {
  return rowKeys.map((rowKey) => resolveRow(rowKey, pack, defaultPack, assignments))
}
