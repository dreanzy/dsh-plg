import { INVENTORY_SECTION } from './inventory-section.js'
import { denyNamesFor } from './shield.js'
import type { Pool } from './pool.js'
import { createInventoryState, sectionText, type InventoryState } from './state.js'
import { createScopeSnapshot, type ScopeSnapshot } from './snapshot.js'
import { readOwned } from './servers.js'
import { loadState } from './store.js'
import { releaseAgent } from './tools.js'
import type { RowScan } from './types.js'

/** 事件与服务面的最小形状。 */
export interface EventContext {
  get(name: string): unknown
  on(event: string, listener: (payload: unknown) => unknown): () => void
  logger: { warn(message: string): void }
}

/** Agent 里本插件用到的字段。 */
interface AgentLike {
  readonly id: string
  readonly ctx?: { get(name: string): unknown }
  readonly session?: { readonly header?: { readonly cwd?: unknown } }
}

function asAgent(value: unknown): AgentLike | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string') return null
  return record as unknown as AgentLike
}

/** 事件负载里的 Agent。 */
function agentOf(payload: unknown): AgentLike | null {
  const record = payload as { agent?: unknown } | null
  return record === null || record === undefined ? null : asAgent(record.agent)
}

function cwdOf(agent: AgentLike): string | null {
  const cwd = agent.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/** 该 agent 作用域里的 tools 服务。必须用 `agent.ctx` 取，否则 `restrict` 会落到全局层并抛错。 */
function toolsOf(agent: AgentLike): { view?: unknown; restrict?: unknown } | null {
  const get = agent.ctx?.get
  if (typeof get !== 'function') return null
  try {
    const service = get.call(agent.ctx, 'tools')
    return typeof service === 'object' && service !== null ? (service as { view?: unknown; restrict?: unknown }) : null
  } catch {
    return null
  }
}

function promptOf(agent: AgentLike): Record<string, unknown> | null {
  const get = agent.ctx?.get
  if (typeof get !== 'function') return null
  try {
    const service = get.call(agent.ctx, 'systemPrompt')
    return typeof service === 'object' && service !== null ? (service as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 一个 agent 的策略视图：按它自己的 cwd 求值。 */
export interface AgentScope {
  readonly agent: AgentLike
  readonly cwd: string
  readonly inventory: InventoryState
  disposeSection: (() => void) | null
  /** 段注册失败的原因；null 表示没失败。 */
  sectionError: string | null
  /** 罩住全局工具的 disposer；null 表示这次没有需要罩住的。 */
  disposeRestrict: (() => void) | null
}

export interface HookDeps {
  readonly context: EventContext
  readonly pool: Pool
  /**
   * 一个 agent 落地完成后调用，用来刷新自检快照。失败被忽略。
   *
   * 附带名册行数：诊断不必为了一个数字再去扫一遍 Loader。
   */
  readonly onSettled?: (info: { readonly agentId: string }) => void
  /** Loader 扫描，同步。 */
  readonly scan: () => RowScan
  /**
   * 共享快照。缺省按 `scan` 与本包的真实读取自建；`index.ts` 会传自己的那份，
   * 让名册段、`mcp_load` 与闸门读的是同一次求值。
   */
  readonly snapshot?: ScopeSnapshot
  /**
   * 该 agent 在当前工作区里要罩住的 server 名（`dynamic`/`lazy` 行）。
   *
   * 返回空数组表示不罩任何东西（例如全是 `eager`）。抛错时按空处理并只 warn。
   */
  readonly shieldedServers: (agent: unknown, cwd: string) => Promise<readonly string[]>
}

export interface Hooks {
  dispose(): void
  /** 重载后补一次：已有会话不会再收到 agent/created。 */
  bootstrap(): Promise<void>
  /** 策略或托管定义变化后重算所有已落地会话。 */
  reconcileAll(): Promise<void>
  /** 按 agent 对象或 id 查已落地的 scope。 */
  scopeOf(agent: object): AgentScope | null
  /**
   * 自检：已落地的 agent 与各自的名册行数。
   *
   * `hasSection` 是最要紧的一项：它回答「这个会话的名册段到底注册上了没有」，
   * 而 `rows` 是「注册的内容有几行」。
   */
  stats(): {
    readonly agents: readonly {
      readonly id: string
      readonly cwd: string
      readonly rows: number
      readonly hasSection: boolean
      readonly sectionError: string | null
    }[]
  }
}

/**
 * 按 agent 落地工作区策略。
 *
 * 为什么必须 per-agent：`systemPrompt.section` 注册在哪个 ctx，段就属于哪一层。
 * 在 root ctx 注册只能得到一份全局段，工作区差异表达不出来。所以每个 agent 在
 * 自己的 `agent.ctx` 上注册同名段——scoped 段会遮蔽全局段，这正是我们要的效果。
 *
 * 三条纪律：
 * 1. `agent/created` 是 serial 派发，监听器抛错会让**会话创建失败**，所以这一层
 *    所有失败路径都是 warn + 降级。
 * 2. 重算必须幂等：重复事件只重建一次，旧的段与旧的 state 先释放。
 * 3. 不在 `agent/pre-step` 或 `system-prompt/assemble` 上做异步工作。
 */
export function installHooks(deps: HookDeps): Hooks {
  const snapshot =
    deps.snapshot ??
    createScopeSnapshot({
      scan: () => deps.scan(),
      load: async (cwd) => {
        const policy = await loadState(cwd)
        const owned = await readOwned()
        return { policy, owned: owned.value, warnings: owned.warnings }
      },
    })
  const scopes = new WeakMap<object, AgentScope>()
  // WeakMap 不可枚举，但自检需要「现在有哪些 agent 落了地」，所以并行维护一份按 id 的索引。
  const byId = new Map<string, AgentScope>()
  const offs: Array<() => void> = []
  /** 同一 agent 的重算串行化：两轮交错会互相释放对方刚注册的段，段句柄就此丢失。 */
  const queues = new WeakMap<object, Promise<unknown>>()

  function reconcile(agent: AgentLike, cwd: string): Promise<AgentScope | null> {
    const key = agent as object
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.then(
      () => reconcileOnce(agent, cwd),
      () => reconcileOnce(agent, cwd),
    )
    queues.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  async function reconcileOnce(agent: AgentLike, cwd: string): Promise<AgentScope | null> {
    // 求值按 cwd + scope 共享：托管定义、pack 策略、行发现结果只读一次。
    const inventory = createInventoryState(snapshot, cwd, agent)
    await inventory.refresh()

    // 先释放上一轮的段：宿主在同一层内禁止同名段重复注册，顺序反了必然抛
    // 「already registered in this scope」，而且会把旧 disposer 丢掉。
    const previous = scopes.get(agent as object)
    if (previous !== undefined && previous.disposeSection !== null) {
      try {
        previous.disposeSection()
      } catch {
        // 旧段释放失败不影响新段。
      }
    }

    let disposeSection: (() => void) | null = null
    let sectionError: string | null = null
    const prompt = promptOf(agent)
    const section = prompt?.['section']
    if (prompt === null) {
      sectionError = 'agent.ctx.get("systemPrompt") 拿不到服务'
    }
    if (typeof section === 'function') {
      try {
        const disposer = (section as (spec: unknown) => unknown).call(prompt, {
          name: INVENTORY_SECTION,
          order: typeof prompt?.['getSectionOrder'] === 'function'
            ? (prompt['getSectionOrder'] as (key: string) => unknown).call(prompt, 'MCP_SERVERS')
            : 3100,
          interpolate: false,
          text: () => sectionText(inventory),
        })
        if (typeof disposer === 'function') disposeSection = disposer as () => void
      } catch (error) {
        sectionError = String(error)
        deps.context.logger.warn(`dsh-mcp-pack: 为 ${agent.id} 注册名册段失败：${String(error)}`)
      }
    }

    // 罩住全局层的那一份：`mcp-client` 挂的工具对模型隐藏，进程照旧。
    let disposeRestrict: (() => void) | null = null
    try {
      const servers = await deps.shieldedServers(agent, cwd)
      if (servers.length > 0) {
        const tools = toolsOf(agent)
        const view = tools?.view
        if (tools !== null && typeof view === 'function') {
          // scope 传 agent 本体：dsh-scope 按对象身份索引，传 ctx 或替身都查不到 agent 层。
          const resolved = view.call(tools, agent) as { restrictableNames?: Iterable<string> } | undefined
          const deny = denyNamesFor(resolved?.restrictableNames ?? [], servers)
          if (deny.length > 0 && typeof tools.restrict === 'function') {
            const disposer = tools.restrict.call(tools, { deny })
            if (typeof disposer === 'function') disposeRestrict = disposer as () => void
          }
        }
      }
    } catch (error) {
      deps.context.logger.warn(`dsh-mcp-pack: 为 ${agent.id} 罩住 MCP 工具失败：${String(error)}`)
    }

    if (previous !== undefined) {
      try {
        previous.disposeRestrict?.()
      } catch {
        // 同上。
      }
    }
    const scope: AgentScope = { agent, cwd, inventory, disposeSection, sectionError, disposeRestrict }
    scopes.set(agent as object, scope)
    byId.set(agent.id, scope)
    try {
      deps.onSettled?.({ agentId: agent.id })
    } catch {
      // 自检刷新失败不影响落地。
    }
    return scope
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    const agent = agentOf(payload)
    if (agent === null) return
    const cwd = cwdOf(agent)
    if (cwd === null) return
    try {
      await reconcile(agent, cwd)
    } catch (error) {
      // 绝不抛：这个监听器在会话创建路径上。
      deps.context.logger.warn(`dsh-mcp-pack: 为 ${agent.id} 落地工作区策略失败：${String(error)}`)
    }
    /**
     * `mcp-client` 是异步连上之后才注册工具的，而 `agent/created` 那一刻全局工具表
     * 常常还是空的——此时 `restrict({ deny })` 没有名字可罩。所以补一次重算：
     * 只补一次，不订阅 `tools/change`（那会让每次注册都触发一轮重算）。
     */
    const retry = setTimeout(() => {
      if (!scopes.has(agent as object)) return
      void reconcile(agent, cwd).catch((error) => {
        deps.context.logger.warn(`dsh-mcp-pack: 延迟罩住失败（agent=${agent.id}）：${String(error)}`)
      })
    }, 1500)
    if (typeof retry === 'object' && typeof (retry as { unref?: () => void }).unref === 'function') {
      (retry as { unref: () => void }).unref()
    }
  }

  const onDisposed = (payload: unknown): void => {
    const agent = agentOf(payload)
    if (agent === null) return
    const scope = scopes.get(agent as object)
    if (scope !== undefined) {
      try {
        scope.disposeSection?.()
      } catch {
        // 同上。
      }
      try {
        scope.disposeRestrict?.()
      } catch {
        // 同上。
      }
    }
    scopes.delete(agent as object)
    byId.delete(agent.id)
    // 快照缓存按 agent 索引，会话结束后没人再读它，留着只是内存。
    snapshot.invalidate(cwdOf(agent))
    releaseAgent(agent as object, deps.pool)
  }

  /**
   * 会话换目录时重算。
   *
   * 这是 `dsh-skill-manager` 那条「切目录不重算」的已知限制，在 MCP 这边是可行的：
   * 注册都落在 per-agent scope 且 dispose 精确。重算只影响新请求，已注册的工具
   * 由用户下一次 `mcp_load` 自然带过来。
   */
  const onDirectoryChange = async (payload: unknown): Promise<void> => {
    const agent = agentOf(payload) ?? null
    if (agent === null) {
      // 负载可能直接是会话/agent 的另一种形状：拿不到就什么都不做。
      return
    }
    const cwd = cwdOf(agent)
    if (cwd === null) return
    try {
      await reconcile(agent, cwd)
    } catch (error) {
      deps.context.logger.warn(`dsh-mcp-pack: 切目录后重算失败（agent=${agent.id}）：${String(error)}`)
    }
  }

  try {
    offs.push(deps.context.on('agent/created', onCreated as never))
    offs.push(deps.context.on('agent/disposed', onDisposed as never))
    offs.push(deps.context.on('working-directory/change', onDirectoryChange as never))
  } catch (error) {
    deps.context.logger.warn(`dsh-mcp-pack: 订阅宿主事件失败：${String(error)}`)
  }

  return {
    dispose() {
      for (const off of offs) {
        try {
          off()
        } catch {
          // 注销失败只影响这次卸载。
        }
      }
      offs.length = 0
    },
    async bootstrap() {
      const agents = deps.context.get('agents') as { list?: () => readonly unknown[] } | undefined
      const list = agents?.list
      if (typeof list !== 'function') return
      for (const raw of list.call(agents)) {
        const agent = asAgent(raw)
        if (agent === null) continue
        const cwd = cwdOf(agent)
        if (cwd === null) continue
        try {
          await reconcile(agent, cwd)
        } catch (error) {
          deps.context.logger.warn(`dsh-mcp-pack: 补落地失败（agent=${agent.id}）：${String(error)}`)
        }
      }
    },
    async reconcileAll() {
      for (const scope of [...byId.values()]) {
        try {
          await reconcile(scope.agent, scope.cwd)
        } catch (error) {
          deps.context.logger.warn(`dsh-mcp-pack: 重算失败（agent=${scope.agent.id}）：${String(error)}`)
        }
      }
    },
    scopeOf(agent) {
      const direct = scopes.get(agent)
      if (direct !== undefined) return direct
      // 对象身份优先；取不到时按 id 兜底——工具执行时拿到的 agent 包装
      // 与 agent/created 里那个未必是同一个对象。
      const id = (agent as { id?: unknown }).id
      return typeof id === 'string' ? byId.get(id) ?? null : null
    },
    stats() {
      return {
        agents: [...byId.values()].map((scope) => ({
          id: scope.agent.id,
          cwd: scope.cwd,
          rows: scope.inventory.snapshot().length,
          hasSection: scope.disposeSection !== null,
          sectionError: scope.sectionError,
        })),
      }
    },
  }
}