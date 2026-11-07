import { stat } from 'node:fs/promises'
import type { Inventory, SkillSummaryLike } from './inventory.js'
import { createResolver, defaultPackOf, hiddenNames, normalizeCwd } from './policy.js'
import {
  groupsPath,
  packsPath,
  workspacesPath,
  type PolicyState,
} from './store.js'

/**
 * 一份已求值的快照：清单 + pack 策略 + 隐藏集。
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
  /** 读 pack 策略与组定义。真实实现是 `loadState`。 */
  readonly loadPolicy: (cwd: string | null) => Promise<PolicyState>
  /** 读 skill 清单。真实实现绕开旧的模块级缓存，直接 `skills.snapshot()`。 */
  readonly readInventory: (cwd: string | null, scope: unknown) => Promise<Inventory>
  /** 文件指纹。缺省用 size + mtime；测试注入固定值即可控制命中与未命中。 */
  readonly fingerprint?: (cwd: string | null) => Promise<string>
}

export interface ScopeSnapshot {
  /** 异步求值。指纹没变就直接复用，变了才读盘；同键并发只算一次。 */
  refresh(cwd: string | null, scope?: unknown, options?: { readonly force?: boolean }): Promise<SnapshotValue>
  /** 打掉缓存。省略 `cwd` 清全部；传 `null` 只清全局那一格。 */
  invalidate(cwd?: string | null): void
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
 * 三份状态文件的指纹。
 *
 * **只做兜底**：同进程写入用 `invalidate()` 显式打掉，不依赖时间戳。这里覆盖的是
 * 「用户在编辑器里手改了文件」——那种改动没有事件可订阅。
 *
 * 已知盲区：同毫秒内改完且字节数不变时指纹一样。显式失效路径能覆盖同进程写入，
 * 所以这个盲区只在「外部手改 + 恰好同毫秒同字节数」时成立，代价是旧值多活一轮。
 */
export async function fingerprintOf(cwd: string | null): Promise<string> {
  // cwd 已不进指纹（旧工作区层不再读）；参数保留以匹配 `SnapshotDeps.fingerprint` 的形状。
  const paths = [packsPath(), groupsPath(), workspacesPath()]
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

    // 两件事互不依赖：并行读，串行等会白付一次往返。
    const [policy, inventory] = await Promise.all([deps.loadPolicy(cwd), deps.readInventory(cwd, scope)])
    const resolver = createResolver({
      pack: policy.pack,
      packId: policy.packId,
      defaultPack: defaultPackOf(policy.packs),
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
    async refresh(cwd, scope, options = {}) {
      const cwdKey = cwdKeyOf(cwd)
      const key = `${cwdKey}|${scopeKeyOf(scope)}`
      // 单飞：并发刷新同一格时共用一次计算，避免把一次保存放大成 N 次读盘。
      const running = inflight.get(key)
      if (running !== undefined) return await running
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
  }
}
