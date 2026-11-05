import { INVENTORY_SECTION } from './inventory-section.js'
import { denyNamesFor } from './shield.js'
import type { Pool } from './pool.js'
import { createInventoryState, sectionText, type InventoryState } from './state.js'
import { loadLayers } from './store.js'
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
  /** 罩住全局工具的 disposer；null 表示这次没有需要罩住的。 */
  disposeRestrict: (() => void) | null
}

export interface HookDeps {
  readonly context: EventContext
  readonly pool: Pool
  /** Loader 扫描，同步。 */
  readonly scan: () => RowScan
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
  /** 面板按会话查询用。 */
  scopeOf(agent: object): AgentScope | null
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
  const scopes = new WeakMap<object, AgentScope>()
  const offs: Array<() => void> = []
  let applying = 0

  async function reconcile(agent: AgentLike, cwd: string): Promise<AgentScope | null> {
    const inventory = createInventoryState({
      scan: () => deps.scan(),
      load: async () => {
        const layers = await loadLayers({ cwd })
        return { global: layers.global, workspace: layers.workspace }
      },
    })
    await inventory.refresh()

    let disposeSection: (() => void) | null = null
    const prompt = promptOf(agent)
    const section = prompt?.['section']
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
        deps.context.logger.warn(`dsh-mcp-manager: 为 ${agent.id} 注册名册段失败：${String(error)}`)
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
      deps.context.logger.warn(`dsh-mcp-manager: 为 ${agent.id} 罩住 MCP 工具失败：${String(error)}`)
    }

    const previous = scopes.get(agent as object)
    if (previous !== undefined) {
      try {
        previous.disposeSection?.()
      } catch {
        // 旧段释放失败不影响新段。
      }
      try {
        previous.disposeRestrict?.()
      } catch {
        // 同上。
      }
    }
    const scope: AgentScope = { agent, cwd, inventory, disposeSection, disposeRestrict }
    scopes.set(agent as object, scope)
    return scope
  }

  const onCreated = async (payload: unknown): Promise<void> => {
    const agent = agentOf(payload)
    if (agent === null) return
    const cwd = cwdOf(agent)
    if (cwd === null) return
    applying += 1
    try {
      await reconcile(agent, cwd)
    } catch (error) {
      // 绝不抛：这个监听器在会话创建路径上。
      deps.context.logger.warn(`dsh-mcp-manager: 为 ${agent.id} 落地工作区策略失败：${String(error)}`)
    } finally {
      applying -= 1
    }
    /**
     * `mcp-client` 是异步连上之后才注册工具的，而 `agent/created` 那一刻全局工具表
     * 常常还是空的——此时 `restrict({ deny })` 没有名字可罩。所以补一次重算：
     * 只补一次，不订阅 `tools/change`（那会让每次注册都触发一轮重算）。
     */
    const retry = setTimeout(() => {
      if (!scopes.has(agent as object)) return
      void reconcile(agent, cwd).catch((error) => {
        deps.context.logger.warn(`dsh-mcp-manager: 延迟罩住失败（agent=${agent.id}）：${String(error)}`)
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
      deps.context.logger.warn(`dsh-mcp-manager: 切目录后重算失败（agent=${agent.id}）：${String(error)}`)
    }
  }

  try {
    offs.push(deps.context.on('agent/created', onCreated as never))
    offs.push(deps.context.on('agent/disposed', onDisposed as never))
    offs.push(deps.context.on('working-directory/change', onDirectoryChange as never))
  } catch (error) {
    deps.context.logger.warn(`dsh-mcp-manager: 订阅宿主事件失败：${String(error)}`)
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
          deps.context.logger.warn(`dsh-mcp-manager: 补落地失败（agent=${agent.id}）：${String(error)}`)
        }
      }
    },
    scopeOf(agent) {
      return scopes.get(agent) ?? null
    },
  }
}