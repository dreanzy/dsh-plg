import { DEFAULT_MODE, EMPTY_LAYER, EMPTY_SETTINGS, MODES, type FieldSource, type LayerPolicy, type LayerSettings, type Mode, type ParseResult, type ResolvedRow, type RowPolicy } from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/** 把一条 row 的策略读成已知字段；坏字段丢弃并记 warning。 */
function parseRow(rowKey: string, raw: unknown, warnings: string[]): RowPolicy | null {
  const record = asRecord(raw)
  if (record === null) {
    warnings.push(`忽略 ${rowKey}：不是对象`)
    return null
  }
  const policy: { enabled?: boolean; mode?: Mode; tools?: readonly string[]; description?: string } = {}
  if ('enabled' in record) {
    if (typeof record['enabled'] === 'boolean') policy.enabled = record['enabled']
    else warnings.push(`忽略 ${rowKey}.enabled：不是布尔值`)
  }
  if ('mode' in record) {
    if (isMode(record['mode'])) policy.mode = record['mode']
    else warnings.push(`忽略 ${rowKey}.mode：不是合法的模式`)
  }
  if ('tools' in record) {
    const tools = record['tools']
    if (Array.isArray(tools) && tools.every((item): item is string => typeof item === 'string')) {
      policy.tools = tools
    } else {
      warnings.push(`忽略 ${rowKey}.tools：不是字符串数组`)
    }
  }
  if ('description' in record) {
    const description = record['description']
    if (typeof description === 'string') policy.description = description
    else warnings.push(`忽略 ${rowKey}.description：不是字符串`)
  }
  return policy
}

/**
 * 解析一层策略文件。
 *
 * 坏数据一律降级：不可读、不是对象、版本不认识都返回空策略。理由是它是
 * 用户可编辑的工程文件，一个手误不该让整块面板消失。
 */
export function parseLayer(text: string | undefined): ParseResult<LayerPolicy> {
  if (text === undefined || text.trim() === '') return { value: EMPTY_LAYER, warnings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { value: EMPTY_LAYER, warnings: [`策略文件不是合法 JSON：${String(error)}`] }
  }
  const record = asRecord(parsed)
  if (record === null) return { value: EMPTY_LAYER, warnings: ['策略文件顶层不是对象'] }
  if (record['version'] !== 1) {
    return { value: EMPTY_LAYER, warnings: [`策略文件版本不认识：${String(record['version'])}`] }
  }
  const rawRows = asRecord(record['rows'])
  if (rawRows === null) return { value: EMPTY_LAYER, warnings: ['策略文件缺少 rows 对象'] }

  const warnings: string[] = []
  const rows: Record<string, RowPolicy> = {}
  for (const [rowKey, raw] of Object.entries(rawRows)) {
    const parsedRow = parseRow(rowKey, raw, warnings)
    if (parsedRow !== null) rows[rowKey] = parsedRow
  }
  return { value: { version: 1, rows, settings: parseSettings(record) }, warnings }
}

/**
 * 读全局层的界面开关。
 *
 * 工作区层不写这些，所以缺省即默认；只有全局层序列化时才写出去。
 */
function parseSettings(record: Record<string, unknown>): LayerSettings {
  const raw = asRecord(record['settings'])
  if (raw === null) return EMPTY_SETTINGS
  return { showSidebarEntry: raw['showSidebarEntry'] !== false }
}

/**
 * 序列化一层策略。键排序、字段顺序固定，便于 diff 与人工审阅。
 *
 * `settings` 只写进全局层：工作区层写它就是噪声。
 */
export function serializeLayer(policy: LayerPolicy, options: { readonly settings?: boolean } = {}): string {
  const rows: Record<string, RowPolicy> = {}
  const keys = Object.keys(policy.rows).sort((left, right) => left.localeCompare(right))
  for (const rowKey of keys) {
    const source = policy.rows[rowKey]
    if (source === undefined) continue
    const row: { enabled?: boolean; mode?: Mode; tools?: readonly string[]; description?: string } = {}
    if (source.enabled !== undefined) row.enabled = source.enabled
    if (source.mode !== undefined) row.mode = source.mode
    if (source.tools !== undefined) row.tools = source.tools
    if (source.description !== undefined) row.description = source.description
    rows[rowKey] = row
  }
  const body: Record<string, unknown> = { version: 1, rows }
  if (options.settings === true) body['settings'] = policy.settings
  return JSON.stringify(body, null, 2) + '\n'
}

type FieldKey = 'enabled' | 'mode' | 'tools' | 'description'

function pickField<T>(
  rowKey: string,
  key: FieldKey,
  workspace: LayerPolicy | null,
  global: LayerPolicy,
): { value: T | undefined; source: FieldSource } {
  const fromWorkspace = workspace?.rows[rowKey] as RowPolicy | undefined
  if (fromWorkspace !== undefined && fromWorkspace[key] !== undefined) {
    return { value: fromWorkspace[key] as T, source: 'workspace' }
  }
  const fromGlobal = global.rows[rowKey] as RowPolicy | undefined
  if (fromGlobal !== undefined && fromGlobal[key] !== undefined) {
    return { value: fromGlobal[key] as T, source: 'global' }
  }
  return { value: undefined, source: 'default' }
}

/**
 * 求值一行：四个字段各自独立走「工作区 → 全局 → 默认」。
 *
 * 字段级独立是刻意的：工作区只关了某行、模式仍沿用全局设置，是常见组合。
 * 合并成「整行取最具体层」会让这种组合表达不出来。
 */
export function resolveRow(rowKey: string, workspace: LayerPolicy | null, global: LayerPolicy): ResolvedRow {
  const enabled = pickField<boolean>(rowKey, 'enabled', workspace, global)
  const mode = pickField<Mode>(rowKey, 'mode', workspace, global)
  const tools = pickField<readonly string[]>(rowKey, 'tools', workspace, global)
  const description = pickField<string>(rowKey, 'description', workspace, global)

  const sources = {
    enabled: enabled.source,
    mode: mode.source,
    tools: tools.source,
    description: description.source,
  }
  const all = [enabled.source, mode.source, tools.source, description.source]
  const from: FieldSource = all.includes('workspace') ? 'workspace' : all.includes('global') ? 'global' : 'default'

  return {
    rowKey,
    enabled: enabled.value ?? true,
    mode: mode.value ?? DEFAULT_MODE,
    tools: tools.value ?? [],
    description: description.value ?? '',
    from,
    sources,
  }
}

/** 按 rowKey 集合求值全部行，保持传入顺序。 */
export function resolveAll(rowKeys: readonly string[], workspace: LayerPolicy | null, global: LayerPolicy): readonly ResolvedRow[] {
  return rowKeys.map((rowKey) => resolveRow(rowKey, workspace, global))
}

/** 一行在某层是否有任何键。UI 用它区分「显式覆盖」与「跟随」。 */
export function hasLayerEntry(layer: LayerPolicy | null, rowKey: string): boolean {
  if (layer === null) return false
  return layer.rows[rowKey] !== undefined
}