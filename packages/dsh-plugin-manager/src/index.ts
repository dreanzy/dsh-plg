import { loadCatalog } from './catalog.js'
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
export const name = 'dsh-plugin-manager'

/**
 * 硬依赖只有 tools：工具掩码与体积实测都取不到替代。
 *
 * 刻意不注入 systemPrompt（段过滤走事件订阅，装不上就降级为「只关工具」）、
 * 不注入 agents（hooks 自己维护会话表就够了）、不注入 connection
 * （无连接服务的 profile 也必须能装配；路由阶段再可选嵌套注入）。
 */
export const inject = ['tools'] as const

/** 路由路径。宿主按完整 pathname 匹配，/api 前缀不能省。 */
const ROUTES = {
  global: '/api/plugin-manager/global',
  workspace: '/api/plugin-manager/workspace',
  apply: '/api/plugin-manager/apply',
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
  // HTTP 状态恒为 200：前端只认信封里的 code，非 2xx 会让它丢掉 body。
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

function wrap(handler: (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>) {
  return async (request: Request): Promise<Response> => {
    let body: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await request.json()
      body =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
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
        error: { code: 'internal', message: '路由处理失败：' + String(error) },
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

  // 重载后补一次施加：已有会话不会再收到 agent/created，不补的话它们会一直
  // 没有限制，直到用户重开会话。失败只降级，不影响插件加载。
  void hooks.bootstrap().catch((error: unknown) => {
    context.logger.warn(name + ': 重载后补施加失败：' + String(error))
  })

  // 预热插件目录：面板第一次打开时缓存已经在盘上，不用先空一轮「识别中」。
  // 它只影响速度与归属展示，失败绝不能影响插件装配。
  void loadCatalog().catch((error: unknown) => {
    context.logger.warn(name + ': 预热插件目录失败：' + String(error))
  })

  context.inject(['connection'], () => {
    const face = readFetchFace(context)
    if (face === null) {
      context.logger.warn(name + ': connection 服务在册但没有 fetch.register，路由未注册（策略仍生效）')
      return
    }
    const routeCtx: RouteContext = { get: (key) => context.get(key), logger: context.logger }
    // 三条路由共用同一份 deps：reapply 让保存立即可见，stuck 与 support 供面板标红。
    const deps: RouteDeps = { reapply: hooks.reapply, stuck: hooks.stuck, support: hooks.support }
    const disposers: Array<() => unknown> = []

    const register = (
      path: string,
      handler: (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>,
    ): void => {
      try {
        disposers.push(face.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: wrap(handler) }))
      } catch (error) {
        context.logger.warn(name + ': 注册路由失败（' + path + '）：' + String(error))
      }
    }

    register(ROUTES.global, (body) => handleGlobal(routeCtx, deps).then((result) => result as Envelope<unknown>))
    register(ROUTES.workspace, (body) =>
      handleWorkspace(routeCtx, body, deps).then((result) => result as Envelope<unknown>),
    )
    register(ROUTES.apply, (body) => handleApply(routeCtx, body, deps).then((result) => result as Envelope<unknown>))

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

  context.logger.info(name + ': applied')
}
