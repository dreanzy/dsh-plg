import { defaultCatalogFeed, setProfileDirHint } from './catalog.js'
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
export const name = 'dsh-plugin-pack'

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
  global: '/api/plugin-pack/global',
  workspace: '/api/plugin-pack/workspace',
  apply: '/api/plugin-pack/apply',
} as const

export function apply(ctx: unknown): void {
  const context = ctx as PluginContext & { inject(names: readonly string[], callback: () => void): unknown }
  const hooks = installHooks(context)

  // 当前 profile 的目录：目录扫描只认它，否则会扫到别的 profile 装过的包。
  // 不放进 inject——`profileContext` 只在由 dsh 启动的 profile 里存在，声明成硬依赖
  // 会让测试与非 profile 启动直接起不来。取不到就退回全扫，目录会标记残缺。
  try {
    const profile = context.get('profileContext') as { dir?: unknown } | undefined
    const dir = typeof profile?.dir === 'string' ? profile.dir : null
    setProfileDirHint(dir)
    if (dir === null) {
      context.logger.warn(name + ': 宿主没有 profileContext，插件目录将退回扫描全部 profile')
    }
  } catch (error) {
    setProfileDirHint(null)
    context.logger.warn(name + ': 读取 profileContext 失败，插件目录将退回扫描全部 profile：' + String(error))
  }

  // 预热插件目录：面板第一次打开时缓存已经在盘上，不用先空一轮「识别中」。
  // 它只影响速度与归属展示，失败绝不能影响插件装配。
  //
  // **bootstrap 必须排在预热之后**：`applyOne` 在 `feed.read()` 返回 null 时直接
  // 返回，而冷启动那一刻缓存还没写出来。两者并行时 bootstrap 必然空跑，且预热完成后
  // 没有任何东西再触发它——已有会话会一直按「全开」运行，直到用户改策略或新开会话。
  void defaultCatalogFeed
    .load({ warn: (message) => context.logger.warn(message) })
    .catch((error: unknown) => {
      context.logger.warn(name + ': 预热插件目录失败：' + String(error))
    })
    .then(() =>
      // 重载后补一次施加：已有会话不会再收到 agent/created，不补的话它们会一直
      // 没有限制，直到用户重开会话。失败只降级，不影响插件加载。
      hooks.bootstrap(),
    )
    .catch((error: unknown) => {
      context.logger.warn(name + ': 重载后补施加失败：' + String(error))
    })

  context.inject(['connection'], () => {
    const face = readFetchFace(context)
    if (face === null) {
      context.logger.warn(name + ': connection 服务在册但没有 fetch.register，路由未注册（策略仍生效）')
      return
    }
    const routeCtx: RouteContext = { get: (key) => context.get(key), logger: context.logger, label: name }
    // 三条路由共用同一份 deps：reapply 让保存立即可见，stuck 与 support 供面板标红。
    const deps: RouteDeps = { reapply: hooks.reapply, stuck: hooks.stuck, support: hooks.support }
    const dispose = registerRoutes(
      face,
      ROUTES,
      {
        global: (body) => handleGlobal(routeCtx, body, deps).then((result) => result as Envelope<unknown>),
        workspace: (body) => handleWorkspace(routeCtx, body, deps).then((result) => result as Envelope<unknown>),
        apply: (body) => handleApply(routeCtx, body, deps).then((result) => result as Envelope<unknown>),
      },
      (path, error) => context.logger.warn(name + ': 注册路由失败（' + path + '）：' + String(error)),
    )
    context.effect(() => dispose)
  })

  context.logger.info(name + ': applied')
}
