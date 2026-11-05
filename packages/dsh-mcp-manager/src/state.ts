import { parseToolFilter } from './filter.js'
import { renderInventory, type InventoryRow } from './inventory-section.js'
import type { ConnectionSpec } from './mcp-connection.js'
import { resolveRow } from './policy.js'
import type { ToolTarget } from './tools.js'
import { mountConfig } from './mount.js'
import { EMPTY_OWNED, serversPath, type OwnedServers, type ServerDef } from './servers.js'
import type { LayerPolicy, McpRow, Mode } from './types.js'

/** 状态层依赖：扫描是同步的（Loader 本来就在内存里），读盘是异步的。 */
export interface StateDeps {
  readonly scan: () => { rows: readonly McpRow[]; warnings: readonly string[] }
  readonly load: () => Promise<{
    global: LayerPolicy
    workspace: LayerPolicy | null
    /** 本插件托管的 server 定义。 */
    owned?: OwnedServers
  }>
}

export interface InventoryState {
  /** 同步快照。系统提示装配是同步的，只能读缓存。 */
  snapshot(): readonly InventoryRow[]
  /** 按名字找一台可加载的 server。同步，读缓存。 */
  target(name: string): ToolTarget | null
  /** 某个 server 的启用状态与模式；策略未就绪或没有这行时返回 null。 */
  policyOf(name: string): { readonly enabled: boolean; readonly mode: Mode } | null
  /** 重算缓存。失败保留上一版并返回错误。 */
  refresh(): Promise<void>
  warnings(): readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value)
  if (record === null) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** 从原始配置构造连接参数；形状不认识时返回 null，调用方当作不可加载。 */
export function connectionSpecOf(row: McpRow): ConnectionSpec | null {
  const config = asRecord(row.config)
  if (config === null) return null
  if (config['transport'] === 'stdio') {
    const command = typeof config['command'] === 'string' ? config['command'] : null
    if (command === null) return null
    return {
      transport: 'stdio',
      serverName: row.serverName,
      command,
      args: stringList(config['args']),
      env: stringRecord(config['env']),
      cwd: typeof config['cwd'] === 'string' ? config['cwd'] : '',
    }
  }
  if (config['transport'] === 'streamable-http') {
    const url = typeof config['url'] === 'string' ? config['url'] : null
    if (url === null) return null
    return {
      transport: 'streamable-http',
      serverName: row.serverName,
      url,
      headers: stringRecord(config['headers']),
    }
  }
  return null
}

/** 把一条托管定义翻成行视图。来源固定为 `managed`，与用户配置的行区分开。 */
function rowOfOwned(name: string, def: ServerDef): McpRow {
  return {
    rowKey: `own:${name}`,
    serverName: name,
    transport: def.transport,
    definition: def.transport === 'stdio' ? [def.command, ...def.args].join(' ') : def.url,
    source: 'managed',
    sourcePath: serversPath(),
    owned: true,
    declaredDisabled: false,
    entryId: `managed:${name}`,
    config: mountConfig(name, def),
  }
}

/**
 * 把托管定义并进 Loader 扫出来的行。
 *
 * 冲突判据是 `serverName`：宿主在同一个 scope 内按这个名字互斥，两处声明同名的
 * 实例会直接互相拒绝。这里选择保留用户配置里的那一条、跳过托管的，并给出可读
 * 的 warning——静默丢弃会让用户以为插件坏了。
 */
export function mergeOwnedRows(
  base: readonly McpRow[],
  owned: OwnedServers,
  warnings: readonly string[],
): { rows: readonly McpRow[]; warnings: readonly string[] } {
  const rows = [...base]
  const out = [...warnings]
  const taken = new Set(base.map((row) => row.serverName))
  for (const [name, def] of Object.entries(owned.servers)) {
    if (taken.has(name)) {
      out.push(`托管定义 "${name}" 与已有行重名，已忽略；改个 serverName 才能启用`)
      continue
    }
    rows.push(rowOfOwned(name, def))
    taken.add(name)
  }
  return { rows, warnings: out }
}

/**
 * 名册与加载目标的缓存。
 *
 * 为什么要有这一层：`systemPrompt.section` 的 `text` 在装配时**同步**求值，
 * 而策略文件是异步读的。所以把「异步读盘」放在 `refresh()`，把「同步渲染与查表」
 * 留在内存里。刷新点：`apply` 启动时、每次 `/apply` 写入后。
 *
 * 名册只列「允许且不是 eager」的行：eager 的工具已经在请求里，再列一遍是噪声。
 * 但 `target()` 对所有允许的行都可查——面板要能看到 eager 行。
 */
export function createInventoryState(deps: StateDeps): InventoryState {
  let inventory: readonly InventoryRow[] = []
  let targets: ReadonlyMap<string, ToolTarget> = new Map()
  let policies: ReadonlyMap<string, { enabled: boolean; mode: Mode }> = new Map()
  let lastWarnings: readonly string[] = []

  return {
    snapshot() {
      return inventory
    },
    target(name) {
      const trimmed = name.trim()
      if (trimmed === '') return null
      const direct = targets.get(trimmed)
      if (direct !== undefined) return direct
      for (const candidate of targets.values()) {
        if (candidate.serverName === trimmed) return candidate
      }
      // 模型会把名字写成小写（`unitymcp8082`），而 serverName 是大小写敏感的。
      // 这里做一次不区分大小写的兜底：唯一命中才认，多个命中就放弃，避免串台。
      const lower = trimmed.toLowerCase()
      const loose = [...targets.values()].filter((candidate) => candidate.serverName.toLowerCase() === lower)
      return loose.length === 1 ? loose[0] ?? null : null
    },
    policyOf(name) {
      const found = policies.get(name.trim())
      return found ?? null
    },
    warnings() {
      return lastWarnings
    },
    async refresh() {
      const layers = await deps.load()
      const scan = deps.scan()

      // 托管定义不在 Loader 的 entry 树里，只能在这里接上。
      const merged = mergeOwnedRows(scan.rows, layers.owned ?? EMPTY_OWNED, scan.warnings)
      const rows = merged.rows
      const warnings = merged.warnings

      const nextInventory: InventoryRow[] = []
      const nextTargets = new Map<string, ToolTarget>()
      const nextPolicies = new Map<string, { enabled: boolean; mode: Mode }>()
      for (const row of rows) {
        const resolved = resolveRow(row.rowKey, layers.workspace, layers.global)
        nextPolicies.set(row.serverName, { enabled: resolved.enabled, mode: resolved.mode })
        if (!resolved.enabled) continue
        const spec = connectionSpecOf(row)
        if (spec === null) continue
        nextTargets.set(row.rowKey, {
          rowKey: row.rowKey,
          serverName: row.serverName,
          spec,
          filter: parseToolFilter(resolved.tools),
          mode: resolved.mode,
        })
        if (resolved.mode === 'eager') continue
        nextInventory.push({ serverName: row.serverName, description: resolved.description })
      }

      inventory = nextInventory
      targets = nextTargets
      policies = nextPolicies
      lastWarnings = warnings
    },
  }
}

/** 段文本，给 `systemPrompt.section` 的 `text` 用。 */
export function sectionText(state: InventoryState): string {
  return renderInventory(state.snapshot())
}