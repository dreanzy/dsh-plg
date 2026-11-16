import { readFetchFace, registerRoutes } from '@dreanzy/dsh-pack-core'
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
    const routeCtx: RouteContext = { get: (key) => context.get(key), logger: context.logger, label: name }
    // 与 hooks 共用同一份快照：面板上的隐藏集必须就是会话里生效的那一份。
    const deps: RouteDeps = { snapshot: hooks.snapshot, reapply: hooks.reapply, stuck: hooks.stuck }
    const dispose = registerRoutes(
      face,
      ROUTES,
      {
        global: (body) => {
          // 面板会带当前会话：全局面板的行集合因此与会话一致，而不是「恰好排第一的那个」。
          const sessionId =
            body !== null && typeof body['sessionId'] === 'string' && body['sessionId'] !== ''
              ? body['sessionId']
              : undefined
          return handleGlobal(routeCtx, deps, sessionId)
        },
        workspace: (body) => handleWorkspace(routeCtx, body, deps),
        apply: (body) => handleApply(routeCtx, body, deps),
      },
      (path, error) => context.logger.warn(`${name}: 注册路由失败（${path}）：${String(error)}`),
    )
    context.effect(() => dispose)
  })

  context.logger.info(`${name}: applied`)
}
