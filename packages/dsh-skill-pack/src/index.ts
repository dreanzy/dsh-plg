import { installHooks, type PluginContext } from './hooks.js'
import {
  handleApply,
  handleGlobal,
  handleWorkspace,
  type Envelope,
  type RouteContext,
  type RouteDeps,
} from './routes.js'

/** 插件名，同时是 bundle patch 的 entry id。 */
export const name = 'dsh-skill-pack'

/**
 * 硬依赖是 `skills` 与 `agents`。
 *
 * - `skills`：清单读取与遮蔽注册都取不到替代。
 * - `agents`：`agent/created` 只覆盖新会话；插件重载后**已经存在**的会话不会再发
 *   这个事件，只能靠 `bootstrap()` 主动枚举 live Agent 补落地。未声明时 `ctx.get('agents')`
 *   返回 `undefined`，枚举静默变成空数组——表现就是「重载插件后遮蔽再也不生效」。
 *
 * 刻意不注入 `tools`（不管 MCP）、不注入 `connection`（无连接服务的 profile 也必须能
 * 装配；路由阶段再可选嵌套注入）。
 */
export const inject = ['skills', 'agents'] as const

/** 路由路径。宿主按完整 pathname 匹配，`/api` 前缀不能省。 */
const ROUTES = {
  global: '/api/skill-pack/global',
  workspace: '/api/skill-pack/workspace',
  apply: '/api/skill-pack/apply',
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

function toResponse(envelope: Envelope<unknown>): Response {
  // HTTP 状态恒为 200：前端只认信封里的 `code`，非 2xx 会让它丢掉 body。
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

function wrap(handler: (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>) {
  return async (request: Request): Promise<Response> => {
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await request.json()
      body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      // 空体合法：全局读取不需要任何入参。
    }
    try {
      return toResponse(await handler(body))
    } catch (error) {
      return toResponse({
        ok: false,
        error: { code: 'internal', message: `路由处理失败：${String(error)}` },
      })
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

export function apply(ctx: unknown): void {
  const context = ctx as PluginContext & { inject(names: readonly string[], callback: () => void): unknown }
  const hooks = installHooks(context)
  // 重载后补一次落地：已有会话不会再收到 agent/created，不补的话它们会一直
  // 保持「没有遮蔽」，直到用户重开会话。失败只降级，不影响插件加载。
  void hooks.bootstrap().catch((error) => {
    context.logger.warn(`${name}: 重载后补落地失败：${String(error)}`)
  })

  context.inject(['connection'], () => {
    const face = readFetchFace(context)
    if (face === null) {
      context.logger.warn(`${name}: connection 服务在册但没有 fetch.register，路由未注册（策略仍生效）`)
      return
    }
    const routeCtx: RouteContext = { get: (key) => context.get(key), logger: context.logger }
    // 与 hooks 共用同一份快照：面板上的隐藏集必须就是会话里生效的那一份。
    const deps: RouteDeps = { snapshot: hooks.snapshot, reapply: hooks.reapply, stuck: hooks.stuck }
    const disposers: Array<() => unknown> = []

    const register = (path: string, handler: (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>): void => {
      try {
        disposers.push(face.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: wrap(handler) }))
      } catch (error) {
        context.logger.warn(`${name}: 注册路由失败（${path}）：${String(error)}`)
      }
    }

    register(ROUTES.global, (body) => {
      // 面板会带当前会话：全局面板的行集合因此与会话一致，而不是「恰好排第一的那个」。
      const sessionId =
        body !== null && typeof body['sessionId'] === 'string' && body['sessionId'] !== ''
          ? body['sessionId']
          : undefined
      return handleGlobal(routeCtx, deps, sessionId)
    })
    register(ROUTES.workspace, (body) => handleWorkspace(routeCtx, body, deps))
    register(ROUTES.apply, (body) => handleApply(routeCtx, body, deps))

    context.effect(() => () => {
      for (const dispose of disposers) {
        try {
          const result = dispose()
          if (result !== null && typeof result === 'object' && 'catch' in result) {
            void (result as Promise<unknown>).catch(() => {
              // 释放失败只影响这次卸载，没有可回滚的状态。
            })
          }
        } catch {
          // 同上。
        }
      }
    })
  })

  context.logger.info(`${name}: applied`)
}
