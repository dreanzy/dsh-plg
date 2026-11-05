import { stat } from 'node:fs/promises'
import type { Inventory, SkillSummaryLike } from './inventory.js'
import { createResolver, hiddenNames } from './policy.js'
import { globalPath, groupsPath, workspacePath, type PolicyState } from './store.js'

/**
 * 一份已求值的快照：清单 + 两层策略 + 隐藏集。
 *
 * 这是三个 manager 共有的形状：**求值一次，落地多次**。落地（注册遮蔽副本、
 * 施加工具限制、注册名册段）必须 per-agent，因为它依赖各自的 ctx；但求值只
 * 依赖 cwd 与 scope，与 agent 数量无关。
 */
export interface SnapshotValue {
  /** 全量清单，含官方技能：求值始终用它，面板展示与否是另一回事。 */
  readonly rows: readonly SkillSummaryLike[]
  /** 清单是否完整。不完整时 `hidden` 恒为空——宁可这一轮不动，也不要误放行。 */
  readonly complete: boolean
  /** 已被关闭、落地时要遮蔽的名字，已排序。 */
  readonly hidden: readonly string[]
  readonly policy: PolicyState
  readonly warnings: readonly string[]
}

/** 快照的依赖。全部可注入，测试不必碰真实文件系统。 */
export interface SnapshotDeps {
  /** 读两层策略与组定义。真实实现是 `loadState`。 */
  readonly loadPolicy: (cwd: string | null) => Promise<PolicyState>
  /** 读 skill 清单。真实实现绕开旧的模块级缓存，直接 `skills.snapshot()`。 */
  readonly readInventory: (cwd: string | null, scope: unknown) => Promise<Inventory>
  /** 文件指纹。缺省用 size + mtime；测试注入固定值即可控制命中与未命中。 */
  readonly fingerprint?: (cwd: string | null) => Promise<string>
}

/** 自检计数。`reads` 是唯一能证明「没有再读盘」的数字。 */
export interface SnapshotStats {
  /** `read()` 命中次数。 */
  readonly hits: number
  /** `read()` 未命中次数（还没算过，或刚被失效）。 */
  readonly misses: number
  /** 真正执行过一次读盘的次数。 */
  readonly reads: number
  /** `refresh()` 被调用次数，含被指纹短路的那部分。 */
  readonly refreshes: number
  /** 当前缓存条目数。 */
  readonly size: number
}

export interface ScopeSnapshot {
  /**
   * 同步读缓存。**零 IO**：系统提示的 `section.text` 是同步求值的，这里不能等。
   * 返回 `null` 表示这一格还没算过，调用方应先 `refresh()`。
   */
  read(cwd: string | null, scope?: unknown): SnapshotValue | null
  /** 异步求值。指纹没变就直接复用，变了才读盘；同键并发只算一次。 */
  refresh(cwd: string | null, scope?: unknown, options?: { readonly force?: boolean }): Promise<SnapshotValue>
  /** 打掉缓存。省略 `cwd` 清全部；传 `null` 只清全局那一格。 */
  invalidate(cwd?: string | null): void
  stats(): SnapshotStats
}

/**
 * 路径归一：同一目录的不同写法必须落到同一个键。
 *
 * Windows 上大小写不敏感、分隔符两种都能写；面板与宿主给的 cwd 未必同写法。
 * 不归一的话同一个目录会各存一份，缓存收益直接减半，而且失效时漏掉一半。
 */
function normalizeCwd(cwd: string | null): string | null {
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

function cwdKeyOf(cwd: string | null): string {
  return normalizeCwd(cwd) ?? '(global)'
}

/**
 * scope 身份：对象用 WeakMap 发号，不做结构比较。
 *
 * 宿主按**对象身份**索引作用域链，两个 preset 的 agent 可能是形状相同但身份不同的
 * 两个对象。按形状比较会把它们当成同一个，代价是清单串台。
 */
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

/** 单个文件的指纹。不存在记 `absent`，读不到记 `error`——两者都不该被当成「没变」。 */
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
 * 三份策略文件的指纹。
 *
 * **只做兜底**：同进程写入用 `invalidate()` 显式打掉，不依赖时间戳。这里覆盖的是
 * 「用户在编辑器里手改了文件」——那种改动没有事件可订阅。
 *
 * 已知盲区：同毫秒内改完且字节数不变时指纹一样。显式失效路径能覆盖同进程写入，
 * 所以这个盲区只在「外部手改 + 恰好同毫秒同字节数」时成立，代价是旧值多活一轮。
 */
export async function fingerprintOf(cwd: string | null): Promise<string> {
  const paths = [globalPath(), groupsPath()]
  if (cwd !== null && cwd.trim() !== '') paths.push(workspacePath(cwd))
  const stamps = await Promise.all(paths.map((path) => fileStamp(path)))
  return stamps.join('|')
}

interface Entry {
  readonly value: SnapshotValue
  readonly fingerprint: string
}

/**
 * 建一个按 cwd + scope 索引的求值缓存。
 *
 * 三条性质：
 * 1. **`read()` 零 IO**：只用内存，供同步装配路径使用。
 * 2. **`refresh()` 单飞**：同键并发请求共用一次计算，不会 N 份重复读盘。
 * 3. **失效分两种**：显式 `invalidate()` 不依赖时间戳；指纹只兜外部手改。
 */
export function createScopeSnapshot(deps: SnapshotDeps): ScopeSnapshot {
  const fingerprint = deps.fingerprint ?? fingerprintOf
  const entries = new Map<string, Entry>()
  /** cwd 键 → 该目录下所有 scope 的键。用于按目录失效。 */
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
    scope: unknown,
    key: string,
    force: boolean,
  ): Promise<SnapshotValue> => {
    const cached = entries.get(key)
    const stamp = await fingerprint(cwd)
    if (!force && cached !== undefined && cached.fingerprint === stamp) return cached.value

    reads += 1
    // 两件事互不依赖：并行读，串行等会白付一次往返。
    const [policy, inventory] = await Promise.all([deps.loadPolicy(cwd), deps.readInventory(cwd, scope)])
    const resolver = createResolver({
      workspace: policy.workspace,
      global: policy.global,
      assignments: policy.groups.assignments,
    })
    const hidden = inventory.complete
      ? hiddenNames(
          inventory.rows.map((row) => row.name),
          resolver,
        )
      : []
    const value: SnapshotValue = {
      rows: inventory.rows,
      complete: inventory.complete,
      hidden,
      policy,
      warnings: policy.warnings,
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
      // 单飞：并发刷新同一格时共用一次计算，避免把一次保存放大成 N 次读盘。
      const running = inflight.get(key)
      if (running !== undefined) return await running
      refreshes += 1
      const task = compute(cwd, cwdKey, scope, key, options.force === true)
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
