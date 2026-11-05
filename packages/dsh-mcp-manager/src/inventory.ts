import type { LoaderFace, McpRow, RowScan } from './types.js'

/** 宿主的 MCP 客户端插件名；一个实例连一台 server。 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** 本插件托管的 include 文件名。只有它的行可写。 */
export const OWNED_INCLUDE_FILE = 'mcp-manager.cordis.yml'

/** 把任意值读成普通对象，失败给 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 取路径最后一段，跨 Windows 与 POSIX。 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/u)
  return parts[parts.length - 1] ?? path
}

/** entry 所属树的文件名；写在组合本身里时为 null。 */
function treeFileName(entry: Record<string, unknown>): string | null {
  const parent = asRecord(entry['parent'])
  const tree = asRecord(parent?.['tree'])
  const filename = tree?.['filename']
  return typeof filename === 'string' && filename !== '' ? filename : null
}

function entryId(entry: Record<string, unknown>): string {
  const options = asRecord(entry['options'])
  return readString(options, 'id') ?? '(anonymous)'
}

function entryDisabled(entry: Record<string, unknown>): boolean {
  const options = asRecord(entry['options'])
  if (options?.['disabled'] === true) return true
  return entry['disabled'] === true
}

/**
 * 从一份 mcp-client 配置里抽出展示所需的字段。
 *
 * 配置形态以宿主 `dsh-mcp-client` 的 `Config` 联合为准：stdio 必有 `command`，
 * streamable-http 必有 `url`；两者都必有 `serverName`。形状不认识的条目跳过
 * 并记一条 warning，不猜测。
 */
function describeConfig(config: unknown): { serverName: string; transport: 'stdio' | 'streamable-http'; definition: string } | null {
  const record = asRecord(config)
  if (record === null) return null
  const serverName = readString(record, 'serverName')
  if (serverName === null) return null
  const transport = readString(record, 'transport')
  if (transport === 'stdio') {
    const command = readString(record, 'command')
    if (command === null) return null
    const args = Array.isArray(record['args']) ? record['args'].filter((item): item is string => typeof item === 'string') : []
    return { serverName, transport: 'stdio', definition: [command, ...args.slice(0, 2)].join(' ') }
  }
  if (transport === 'streamable-http') {
    const url = readString(record, 'url')
    if (url === null) return null
    return { serverName, transport: 'streamable-http', definition: url }
  }
  return null
}

/**
 * 扫描宿主 Loader 里的全部 MCP 行。
 *
 * 遍历 `loader.entries()`：`EntryTree.entries()` 自己会递归进 `entry.subtree`，
 * 所以 include 文件里的行也在结果中，不需要额外展开。
 *
 * **不探测 include 树的 `write()`**：宿主 0.2.2-rc.1 的 `cordis-plugin-include`
 * 已移除该方法，按它判定会让全局行集合恒空——这就是社区实现 issue #6 的根因。
 * 这里只读 `options.name` 与 `filename`，两者都是稳定字段。
 */
export function scanRows(loader: unknown): RowScan {
  const face = asRecord(loader)
  const entries = face?.['entries']
  if (typeof entries !== 'function') {
    return { rows: [], complete: false, warnings: ['宿主没有 loader.entries()，无法枚举 MCP 行'] }
  }

  const rows: McpRow[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  for (const raw of entries.call(loader) as Iterable<unknown>) {
    const entry = asRecord(raw)
    if (entry === null) continue
    const options = asRecord(entry['options'])
    if (options === null) continue
    if (readString(options, 'name') !== MCP_CLIENT_MODULE) continue

    const config = options['config']
    const described = describeConfig(config)
    if (described === null) {
      warnings.push(`跳过无法识别的 mcp-client 配置（entry ${entryId(entry)}）`)
      continue
    }

    const path = treeFileName(entry)
    const file = path === null ? null : baseName(path)
    const owned = file !== null && file === OWNED_INCLUDE_FILE
    const source = file ?? 'profile'
    const rowKey = `${owned ? 'own' : 'global'}:${described.serverName}`

    if (seen.has(rowKey)) {
      warnings.push(`重复的 serverName：${described.serverName}（entry ${entryId(entry)}）`)
      continue
    }
    seen.add(rowKey)

    rows.push({
      rowKey,
      serverName: described.serverName,
      transport: described.transport,
      definition: described.definition,
      source,
      sourcePath: path,
      owned,
      declaredDisabled: entryDisabled(entry),
      config,
      entryId: entryId(entry),
    })
  }

  rows.sort((left, right) => left.rowKey.localeCompare(right.rowKey))
  return { rows, complete: true, warnings }
}