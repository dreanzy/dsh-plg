import { stat } from 'node:fs/promises'
import { parseToolFilter } from './filter.js'
import { renderInventory, type InventoryRow } from './inventory-section.js'
import type { ConnectionSpec } from './mcp-connection.js'
import { defaultPackOf, normalizeCwd, resolveRow } from './policy.js'
import { serversPath, type OwnedServers, type ServerDef } from './servers.js'
import { groupsPath, packsPath, workspacesPath, type PolicyState } from './store.js'
import type { ToolTarget } from './tools.js'
import type { McpRow, Mode, ResolvedRow, RowScan } from './types.js'

/** 一份已求值的快照：行、求值结果与两张派生表。 */
export interface SnapshotValue {
  /** 合并托管定义之后的行。 */
  readonly rows: readonly McpRow[]
  /** rowKey → 四字段求值结果。 */
  readonly resolved: ReadonlyMap<string, ResolvedRow>
  /** 名册行：允许且不是 eager 的那些。 */
  readonly inventory: readonly InventoryRow[]
  /** rowKey → 可加载目标（含连接参数与工具规则）。 */
  readonly targets: ReadonlyMap<string, ToolTarget>
  /** serverName → 启用状态与模式。 */
  readonly policies: ReadonlyMap<string, { readonly enabled: boolean; readonly mode: Mode }>
  /**
   * 这一轮的策略原样保留：面板要显示 pack 名册、组定义、绑定表，
   * 也要显示「这条行在绑定 pack / default 里有没有显式条目」。
   */
  readonly policy: PolicyState
  readonly owned: OwnedServers
  /** 行发现是否完整。false 时面板不得据此隐藏任何东西。 */
  readonly complete: boolean
  readonly warnings: readonly string[]
}

/** 快照依赖。全部可注入，测试不必碰 Loader 与文件系统。 */
export interface SnapshotDeps {
  /** 行发现，同步：Loader 本来就在内存里。 */
  readonly scan: () => RowScan
  /** 策略 + 托管定义。`warnings` 是策略之外那一部分的（例如托管定义解析）。 */
  readonly load: (cwd: string | null) => Promise<{
    readonly policy: PolicyState
    readonly owned: OwnedServers
    readonly warnings: readonly string[]
  }>
  /** 文件指纹。缺省用 size + mtime；测试注入固定值即可控制命中。 */
  readonly fingerprint?: (cwd: string | null) => Promise<string>
}

export interface SnapshotStats {
  readonly hits: number
  readonly misses: number
  readonly reads: number
  readonly refreshes: number
  readonly size: number
}

export interface ScopeSnapshot {
  /** 同步读缓存，**零 IO**。名册段的 `text` 是同步求值的。 */
  read(cwd: string | null, scope?: unknown): SnapshotValue | null
  /** 异步求值。指纹没变就复用；同键并发只算一次。 */
  refresh(cwd: string | null, scope?: unknown, options?: { readonly force?: boolean }): Promise<SnapshotValue>
  /** 打掉缓存。省略清全部；传 `null` 只清全局那一格。 */
  invalidate(cwd?: string | null): void
  stats(): SnapshotStats
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
    config: mountConfigOf(name, def),
  }
}

/** 与 `mount.ts` 的 `mountConfig` 同形，但只依赖定义，不依赖挂载。 */
function mountConfigOf(serverName: string, def: ServerDef): Record<string, unknown> {
  if (def.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName,
      command: def.command,
      args: [...def.args],
      env: { ...def.env },
      cwd: def.cwd,
    }
  }
  return { transport: 'streamable-http', serverName, url: def.url, headers: { ...def.headers } }
}

/**
 * 把托管定义并进 Loader 扫出来的行。
 *
 * 冲突判据是 `serverName`：宿主在同一个 scope 内按这个名字互斥，两处声明同名的
 * 实例会直接互相拒绝。保留用户配置里的那一条，跳过托管的并给出 warning。
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

function cwdKeyOf(cwd: string | null): string {
  return normalizeCwd(cwd) ?? '(global)'
}

const scopeIds = new WeakMap<object, number>()
let nextScopeId = 1

function scopeKeyOf(scope: unknown): string {
  if (scope === undefined || scope === null) return '-'
  if (typeof scope === 'object' || typeof scope === 'function') {
    const existing = scopeIds.get(scope as object)
    if (existing !== undefined) return `s${String(existing)}`
    const assigned = nextScopeId
    nextScopeId += 1
    scopeIds.set(scope as object, assigned)
    return `s${String(assigned)}`
  }
  return `v:${String(scope)}`
}

async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path)
    return `${String(info.size)}:${String(Math.round(info.mtimeMs))}`
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 'absent'
    return 'error'
  }
}

/**
 * 状态文件的指纹：三个策略文件 + 托管定义。
 *
 * 只兜「用户手改了文件」——同进程写入由 `invalidate()` 显式打掉，不靠时间戳。
 */
export async function fingerprintOf(cwd: string | null): Promise<string> {
  const paths = [packsPath(), groupsPath(), workspacesPath(), serversPath()]
  const stamps = await Promise.all(paths.map((path) => fileStamp(path)))
  return stamps.join('|')
}

interface Entry {
  readonly value: SnapshotValue
  readonly fingerprint: string
}

/**
 * 按 cwd + scope 索引的求值缓存。
 *
 * 与 `dsh-skill-manager` 的同形模块各自实现、不共享代码：两个包按 ADR-0002 独立
 * 发版，跨包 import 会让源码安装解析不到。形状一致，是为了两边读起来是同一套语义。
 */
export function createScopeSnapshot(deps: SnapshotDeps): ScopeSnapshot {
  const fingerprint = deps.fingerprint ?? fingerprintOf
  const entries = new Map<string, Entry>()
  const keysByCwd = new Map<string, Set<string>>()
  const inflight = new Map<string, Promise<SnapshotValue>>()
  let hits = 0
  let misses = 0
  let reads = 0
  let refreshes = 0

  const remember = (cwdKey: string, key: string): void => {
    let keys = keysByCwd.get(cwdKey)
    if (keys === undefined) {
      keys = new Set()
      keysByCwd.set(cwdKey, keys)
    }
    keys.add(key)
  }

  const compute = async (
    cwd: string | null,
    cwdKey: string,
    key: string,
    force: boolean,
  ): Promise<SnapshotValue> => {
    const cached = entries.get(key)
    const stamp = await fingerprint(cwd)
    if (!force && cached !== undefined && cached.fingerprint === stamp) return cached.value

    reads += 1
    const loaded = await deps.load(cwd)
    const scan = deps.scan()
    const merged = mergeOwnedRows(scan.rows, loaded.owned, [
      ...loaded.policy.warnings,
      ...loaded.warnings,
      ...scan.warnings,
    ])
    const defaultPack = defaultPackOf(loaded.policy.packs)
    const assignments = loaded.policy.groups.assignments

    const resolved = new Map<string, ResolvedRow>()
    const targets = new Map<string, ToolTarget>()
    const policies = new Map<string, { enabled: boolean; mode: Mode }>()
    const inventory: InventoryRow[] = []
    for (const row of merged.rows) {
      const result = resolveRow(row.rowKey, loaded.policy.pack, defaultPack, assignments)
      resolved.set(row.rowKey, result)
      policies.set(row.serverName, { enabled: result.enabled, mode: result.mode })
      if (!result.enabled) continue
      const spec = connectionSpecOf(row)
      if (spec === null) continue
      targets.set(row.rowKey, {
        rowKey: row.rowKey,
        serverName: row.serverName,
        spec,
        filter: parseToolFilter(result.tools),
        mode: result.mode,
      })
      if (result.mode === 'eager') continue
      inventory.push({ serverName: row.serverName, description: result.description })
    }

    const value: SnapshotValue = {
      rows: merged.rows,
      resolved,
      inventory,
      targets,
      policies,
      policy: loaded.policy,
      owned: loaded.owned,
      complete: scan.complete,
      warnings: merged.warnings,
    }
    entries.set(key, { value, fingerprint: stamp })
    remember(cwdKey, key)
    return value
  }

  return {
    read(cwd, scope) {
      const key = `${cwdKeyOf(cwd)}|${scopeKeyOf(scope)}`
      const entry = entries.get(key)
      if (entry === undefined) {
        misses += 1
        return null
      }
      hits += 1
      return entry.value
    },
    async refresh(cwd, scope, options = {}) {
      const cwdKey = cwdKeyOf(cwd)
      const key = `${cwdKey}|${scopeKeyOf(scope)}`
      const running = inflight.get(key)
      if (running !== undefined) return await running
      refreshes += 1
      const task = compute(cwd, cwdKey, key, options.force === true)
      inflight.set(key, task)
      try {
        return await task
      } finally {
        inflight.delete(key)
      }
    },
    invalidate(cwd) {
      if (cwd === undefined) {
        entries.clear()
        keysByCwd.clear()
        return
      }
      const cwdKey = cwdKeyOf(cwd)
      const keys = keysByCwd.get(cwdKey)
      if (keys === undefined) return
      for (const key of keys) entries.delete(key)
      keysByCwd.delete(cwdKey)
    },
    stats() {
      return { hits, misses, reads, refreshes, size: entries.size }
    },
  }
}

/** 名册段文本。同步路径，只读缓存。 */
export function inventoryText(snapshot: ScopeSnapshot, cwd: string | null, scope?: unknown): string {
  const value = snapshot.read(cwd, scope)
  return value === null ? '' : renderInventory(value.inventory)
}
