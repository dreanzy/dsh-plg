import { loadAdapters, loadMcpClientModule, probeAdapters, type AdapterProbe } from './adapter.js'
import { createGate, suppressedServers } from './gate.js'
import { mountMcpServer, type MountHandle } from './mount.js'
import { installHooks } from './hooks.js'
import { scanRows } from './inventory.js'
import { INVENTORY_SECTION } from './inventory-section.js'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createPool } from './pool.js'
import { readOwned, type OwnedServers } from './servers.js'
import { handleApply, handleGlobal, handleServers, handleWorkspace, lastAppliedCommands, type Envelope, type RouteContext } from './routes.js'
import { resolveRow } from './policy.js'
import { createInventoryState, sectionText, type InventoryState } from './state.js'
import { diagPath, loadLayers } from './store.js'
import { createOnDemandTools } from './tools.js'
import type { LoaderFace } from './types.js'

/** 插件名，同时是 bundle patch 的 entry id。 */
export const name = 'dsh-mcp-manager'

/**
 * 硬依赖只有 `loader`：MCP 行是组合里的 entry，只有 Loader 能枚举它们。
 *
 * `tools` 与 `systemPrompt` 是可选的：`eager` 模式下本插件不注册任何东西，
 * 缺这些服务的 profile 也要能装配。
 */
export const inject = ['loader'] as const

/** 宿主按完整 pathname 匹配，`/api` 前缀不能省。 */
const ROUTES = {
  rows: '/api/mcp-manager/rows',
  global: '/api/mcp-manager/global',
  workspace: '/api/mcp-manager/workspace',
  apply: '/api/mcp-manager/apply',
  diag: '/api/mcp-manager/diag',
  servers: '/api/mcp-manager/servers',
} as const

interface FetchRouteSpec {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response>
}

interface FetchFace {
  register(spec: FetchRouteSpec): () => unknown
}

interface PluginContext {
  get(name: string): unknown
  plugin(plugin: unknown, config?: unknown): unknown
  inject(names: readonly string[], callback: () => void): unknown
  effect(callback: () => () => void): unknown
  on(event: string, listener: (payload: unknown) => unknown): () => void
  baseUrl?: unknown
  logger: { info(message: string): void; warn(message: string): void }
}

/** 运行期自检状态。面板与 `/diag` 都读它。 */
interface Diagnostics {
  adapters: AdapterProbe
  toolsRegistered: boolean
  toolsError: string | null
  sectionRegistered: boolean
  hooksInstalled: boolean
  rowsSeen: number
  /** 被闸门摘掉、当前没有挂载的 server。 */
  suppressed: string[]
  /** 托管定义里的 server 名。 */
  owned: string[]
  /** 当前真的挂上去的托管 server。 */
  mounted: string[]
}

function toResponse(envelope: Envelope<unknown>): Response {
  // HTTP 状态恒为 200：前端只认信封里的 code，非 2xx 会让它丢掉 body。
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

type Handler = (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>

function wrap(handler: Handler) {
  return async (request: Request): Promise<Response> => {
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await request.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // 空体合法：全局读取不需要任何入参。
    }
    try {
      return toResponse(await handler(body))
    } catch (error) {
      return toResponse({ ok: false, error: { code: 'internal', message: `路由处理失败：${String(error)}` } })
    }
  }
}

function readFetchFace(ctx: PluginContext): FetchFace | null {
  const connection = ctx.get('connection') as Record<string, unknown> | undefined
  if (typeof connection !== 'object' || connection === null) return null
  const fetchFace = connection['fetch'] as Record<string, unknown> | undefined
  if (typeof fetchFace !== 'object' || fetchFace === null) return null
  const register = fetchFace['register']
  if (typeof register !== 'function') return null
  return { register: (spec) => (register as (spec: FetchRouteSpec) => () => unknown).call(fetchFace, spec) }
}

function scanOf(context: PluginContext) {
  const loader = context.get('loader') as LoaderFace | undefined
  if (loader === undefined) return { rows: [], complete: false, warnings: ['宿主没有 loader 服务'] }
  return scanRows(loader)
}

/** 建名册缓存：扫描走 Loader，读盘只读全局层（工作区差异留给按 agent 注册）。 */
function createState(context: PluginContext): InventoryState {
  return createInventoryState({
    scan: () => scanOf(context),
    load: async () => {
      const layers = await loadLayers({ cwd: null })
      const owned = await readOwned()
      return { global: layers.global, workspace: layers.workspace, owned: owned.value }
    },
  })
}

function registerInventorySection(context: PluginContext, state: InventoryState): boolean {
  const prompt = context.get('systemPrompt') as Record<string, unknown> | undefined
  const section = prompt?.['section']
  const getSectionOrder = prompt?.['getSectionOrder']
  if (typeof section !== 'function' || typeof getSectionOrder !== 'function') {
    context.logger.warn(`${name}: systemPrompt 在册但缺 section/getSectionOrder，名册段未注册`)
    return false
  }
  const order = (getSectionOrder as (key: string) => unknown).call(prompt, 'MCP_SERVERS')
  if (typeof order !== 'number') {
    context.logger.warn(`${name}: 取不到 MCP_SERVERS 的序位，名册段未注册`)
    return false
  }
  try {
    ;(section as (spec: unknown) => unknown).call(prompt, {
      name: INVENTORY_SECTION,
      order,
      // 描述是用户文本，{{...}} 必须原样保留。
      interpolate: false,
      text: () => sectionText(state),
    })
    return true
  } catch (error) {
    context.logger.warn(`${name}: 注册名册段失败：${String(error)}`)
    return false
  }
}

export function apply(ctx: unknown): void {
  const context = ctx as PluginContext
  const state = createState(context)
  const pool = createPool()
  const baseUrl = typeof context.baseUrl === 'string' ? context.baseUrl : undefined
  const diag: Diagnostics = {
    adapters: { ok: false, defineTool: false, createMcpToolDefinition: false, error: '尚未探测' },
    toolsRegistered: false,
    toolsError: null,
    sectionRegistered: false,
    hooksInstalled: false,
    rowsSeen: 0,
    suppressed: [],
    owned: [],
    mounted: [],
  }

  /**
   * 把自检快照落到 `$DSH_HOME/dsh-mcp-manager/diag.json`。
   *
   * 为什么需要它：桌面版的 HTTP 走 `dsh-app://` 协议，命令行拿不到那些接口；
   * 排查只能靠浏览器控制台。落盘之后，出问题时有据可查，不必每次都要求用户
   * 复制一段 JSON 出来。
   */
  const flushDiag = () => {
    void (async () => {
      try {
        await writeFileAtomic(
        diagPath(),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            ...diag,
            poolSize: pool.size(),
            lastApplied: lastAppliedCommands(),
            // 名册原文：确认「server 有没有出现在系统提示里」最直接的证据。
            inventory: sectionText(state),
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, dirMode: 0o700 },
      )
      } catch {
        // 写不了就算了，不影响主路径。
      }
    })()
  }

  /**
   * 预加载闸门：`dynamic`/`lazy` 的行根本不挂载。
   *
   * 与 `shield.ts` 的分工：闸门让进程压根不起（模型与 `mcp-resources` 都看不到），
   * 屏蔽只是兜住「已经挂载的全局工具」。两者叠加才是完整的按需语义。
   */
  const gate = createGate({
    context: { get: (key) => context.get(key), on: (event, listener) => context.on(event, listener), logger: context.logger },
    // 策略未就绪时返回 null：闸门什么都不做，等下一轮。
    modeOf: (serverName) => state.policyOf(serverName)?.mode ?? null,
  })

  /**
   * 托管 server 的挂载同步。
   *
   * 规则只有一条：**只有 `eager` 才真正挂上去**。`dynamic`/`lazy` 走池，与用户配置的
   * 行完全同一套路径。挂载用 `ctx.plugin`，不写任何文件。
   */
  const mounts = new Map<string, MountHandle>()
  let mcpModule: unknown = null

  const syncMounts = async (): Promise<void> => {
    const owned: OwnedServers = (await readOwned()).value
    diag.owned = Object.keys(owned.servers).sort((left, right) => left.localeCompare(right))
    if (mcpModule === null) {
      mcpModule = await loadMcpClientModule(context.get('loader'), baseUrl)
    }
    for (const [serverName, def] of Object.entries(owned.servers)) {
      const mode = state.policyOf(serverName)?.mode ?? 'dynamic'
      const existing = mounts.get(serverName)
      try {
        if (mode === 'eager' && existing === undefined) {
          mounts.set(serverName, mountMcpServer(context, mcpModule, serverName, def))
        } else if (mode !== 'eager' && existing !== undefined) {
          existing.dispose()
          mounts.delete(serverName)
        }
      } catch (error) {
        context.logger.warn(`${name}: 挂载托管 server 失败（${serverName}）：${String(error)}`)
      }
    }
    for (const [serverName, handle] of mounts) {
      if (owned.servers[serverName] === undefined) {
        handle.dispose()
        mounts.delete(serverName)
      }
    }
    diag.mounted = [...mounts.keys()].sort((left, right) => left.localeCompare(right))
  }

  const noteRows = () => {
    try {
      // 含托管行：托管定义不在 Loader 的 entry 树里，只扫 Loader 会漏掉它们。
      diag.rowsSeen = scanOf(context).rows.length + diag.owned.length
    } catch {
      // 诊断失败不影响主路径。
    }
    diag.suppressed = [...suppressedServers(context.get('loader'))]
    flushDiag()
  }

  // 首次重算 → 闸门 → 快照：顺序不能反。
  // 闸门依赖策略缓存；快照要在闸门之后写，否则落盘的是「还没摘」的状态。
  void state.refresh()
    .then(() => gate.reconcile())
    .then(() => syncMounts())
    .then(() => {
      noteRows()
    })
    .catch((error) => {
      context.logger.warn(`${name}: 首次重算或闸门失败：${String(error)}`)
    })
  gate.attach()

  // root 段是兜底：per-agent 段同名注册在 agent.ctx 上，会遮蔽它。
  context.inject(['systemPrompt'], () => {
    diag.sectionRegistered = registerInventorySection(context, state)
  })

  // 按 agent 落地工作区策略。
  const hooks = installHooks({
    context: { get: (key) => context.get(key), on: (event, listener) => context.on(event, listener), logger: context.logger },
    pool,
    scan: () => scanOf(context),
    // 按该 agent 的 cwd 求值，返回需要罩住的 server 名（dynamic/lazy 行）。
    shieldedServers: async (_agent, cwd) => {
      const layers = await loadLayers({ cwd })
      const scan = scanOf(context)
      const servers: string[] = []
      for (const row of scan.rows) {
        const resolved = resolveRow(row.rowKey, layers.workspace, layers.global)
        if (!resolved.enabled || resolved.mode === 'eager') continue
        servers.push(row.serverName)
      }
      return servers
    },
  })
  diag.hooksInstalled = true
  void hooks.bootstrap().catch((error) => {
    context.logger.warn(`${name}: 补落地失败：${String(error)}`)
  })

  // 按需工具：取宿主导出后注册到全局工具表。
  void probeAdapters(context.get('loader'), baseUrl).then(async (probe) => {
    diag.adapters = probe
    if (!probe.ok) {
      context.logger.warn(`${name}: 宿主适配器不可用：${String(probe.error)}`)
      return
    }
    try {
      const adapters = await loadAdapters(context.get('loader'), baseUrl)
      const { load, unload, call } = createOnDemandTools({
        defineTool: adapters.defineTool,
        pool,
        resolveTarget: (targetName) => state.target(targetName),
        resolveFactory: async () => adapters.createMcpToolDefinition,
        logger: context.logger,
      })
      const tools = context.get('tools') as { register?(definition: unknown): () => unknown } | undefined
      if (tools === undefined || typeof tools.register !== 'function') {
        diag.toolsError = 'tools 服务不可用'
        context.logger.warn(`${name}: tools 服务不可用，mcp_load 未注册`)
        return
      }
      tools.register(load)
      tools.register(unload)
      tools.register(call)
      diag.toolsRegistered = true
    } catch (error) {
      diag.toolsError = String(error)
      context.logger.warn(`${name}: 注册按需工具失败：${String(error)}`)
    }
  }).catch((error) => {
    diag.adapters = { ok: false, defineTool: false, createMcpToolDefinition: false, error: String(error) }
    context.logger.warn(`${name}: 探测宿主适配器失败：${String(error)}`)
  })

  context.effect(() => () => {
    for (const handle of mounts.values()) handle.dispose()
    mounts.clear()
    gate.dispose()
    hooks.dispose()
    void pool.closeAll().catch(() => undefined)
  })

  context.inject(['connection'], () => {
    const face = readFetchFace(context)
    if (face === null) {
      context.logger.warn(`${name}: connection 服务在册但没有 fetch.register，路由未注册`)
      return
    }
    const routeCtx: RouteContext = { get: (key) => context.get(key), logger: context.logger }
    const disposers: Array<() => unknown> = []

    const register = (path: string, handler: Handler): void => {
      try {
        disposers.push(face.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: wrap(handler) }))
      } catch (error) {
        context.logger.warn(`${name}: 注册路由失败（${path}）：${String(error)}`)
      }
    }

register(ROUTES.diag, async () => {
      // 实时重算：`noteRows` 只在启动与写入后跑，拿不到「现在」的闸门状态。
      try {
        diag.rowsSeen = scanOf(context).rows.length + diag.owned.length
        diag.suppressed = [...suppressedServers(context.get('loader'))]
      } catch {
        // 诊断失败不影响响应。
      }
      flushDiag()
      return {
        ok: true,
        value: {
          ...diag,
          gate: gate.stats(),
          lastApplied: lastAppliedCommands(),
          poolSize: pool.size(),
          poolKeys: [...pool.keys()],
          baseUrl: baseUrl ?? null,
        },
      }
    })
    register(ROUTES.rows, () => handleGlobal(routeCtx))
    register(ROUTES.global, () => handleGlobal(routeCtx))
    register(ROUTES.servers, (body) =>
      handleServers(routeCtx, body, {
        afterWrite: async () => {
          await state.refresh()
          await syncMounts()
          noteRows()
        },
      }),
    )
    register(ROUTES.workspace, (body) => handleWorkspace(routeCtx, body))
    register(ROUTES.apply, (body) =>
      handleApply(routeCtx, body, {
        afterWrite: async () => {
          await state.refresh()
          await gate.reconcile()
          await syncMounts()
          noteRows()
        },
      }),
    )

    context.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 释放失败只影响这次卸载，没有可回滚的状态。
        }
      }
    })
  })

  context.logger.info(`${name}: applied（行发现 + 策略 + 名册段 + 按需加载）`)
}