/**
 * Model Pack（model-pack）：装配入口。
 *
 * 职责只有三件：装监听器、按运行期能力注册面板路由、统一释放。
 * 业务全在纯模块里——`policy` 求值、`tools` 定义档位工具、`prompt` 生成段文本、
 * `routes` 处理请求。编排顺序见 `hooks.ts` 与 spec §6.1。
 */

import { applyCommands, loadState, previewCommands, resolve, type PackState } from './policy.js'
import { installHooks, type PluginContext } from './hooks.js'
import { BUILTIN_PROMPT, resolvePrompt } from './prompt.js'
import type { PromptOverrides, Route } from './pack.js'
import { readFetchFace, registerRoutes } from '@dreanzy/dsh-pack-core'
import { ROUTES, handleApply, handleRead, type Envelope, type RouteDeps } from './routes.js'

/** 插件名，同时是 bundle patch 的 entry id。 */
export const name = 'model-pack'

/**
 * 硬依赖只有 tools。
 *
 * `subagents` / `connection` / `systemPrompt` / `agents` / `llm` 全部走运行期
 * `ctx.get` 探测，缺了按 spec §6.4 降级（照 dsh-plugin-manager 的做法）：
 * 没有子智能体插件时插件仍要能装配，否则一个面板就能拖垮整个会话创建。
 */
export const inject = ['tools']

/** cordis 的可选嵌套注入：服务出现时才跑回调。 */
interface ApplyContext extends PluginContext {
  inject(names: readonly string[], callback: () => void): unknown
}

/** 进程级默认模型服务，只声明本插件用到的两个方法。 */
interface DefaultModelFace {
  currentSelection?: () => Partial<Route> | undefined
  saveSelection?: (selection: Route) => Promise<unknown>
}

/**
 * 把「default pack 的会话路由」同步成进程级默认模型。
 *
 * 为什么需要这一步：新建会话的模型位在**第一条消息之前**读的是
 * `agentDefaultModel`，那时 agent 还没创建，插件的 select 还没机会生效。
 * 不同步的话，空白会话会显示上一次手动切换留下的模型，与 pack 对不上。
 *
 * 只在 default pack**自带 session 路由**时接管：没配就说明用户想把默认交给官方设置页。
 * 值相同则跳过，避免每次保存都去写 profile。
 */
async function syncDefaultModel(context: ApplyContext): Promise<void> {
  try {
    const service = context.get('agentDefaultModel') as DefaultModelFace | undefined
    if (service === undefined || typeof service.saveSelection !== 'function') return

    const resolved = resolve(await loadState(null), null)
    const session = resolved.pack.session
    if (session === undefined) return

    const current = typeof service.currentSelection === 'function' ? service.currentSelection() : undefined
    if (
      current !== undefined &&
      current.provider === session.provider &&
      current.model === session.model &&
      (current.reasoningEffort ?? '') === (session.reasoningEffort ?? '')
    ) {
      return
    }

    await service.saveSelection({
      provider: session.provider,
      model: session.model,
      ...(session.reasoningEffort === undefined ? {} : { reasoningEffort: session.reasoningEffort }),
    })
    context.logger.info(name + ': 已把 default pack 的会话路由同步为默认模型')
  } catch (error) {
    // 同步失败只影响「空白会话显示什么」，不影响任何已生效的会话，所以只 warn。
    context.logger.warn(name + ': 同步默认模型失败：' + String(error))
  }
}

export function apply(ctx: unknown): void {
  const context = ctx as ApplyContext
  const hooks = installHooks(context)

  // 重载后补一次施加：已有会话不会再收到 agent/created，不补的话它们会一直没有
  // subagent_tier 与委派段。失败只降级，不影响插件加载。
  void hooks.bootstrap().catch((error: unknown) => {
    context.logger.warn(name + ': 重载后补施加失败：' + String(error))
  })

  // 统一释放：退订两个事件，并把每个 agent 上的工具、限制、段全部注销。
  context.effect(() => hooks.stopAll)

  context.inject(['connection'], () => {
    const face = readFetchFace(context)
    if (face === null) {
      context.logger.warn(name + ': connection 服务在册但没有 fetch.register，路由未注册（pack 仍生效）')
      return
    }

    // 依赖在这里组装，纯模块那边只认签名：
    // 读写与求值来自 policy，`support` / `lastError` 来自 hooks（探测结果与最近一次失败）。
    const deps: RouteDeps = {
      loadState: (cwd) => loadState(cwd),
      // 每次落盘后同步一次默认模型：改了 default pack 的会话路由就可能改变「新会话该用什么」。
      // 再让空白会话的模型位跟着新路由走：用户刚在面板上点了保存，界面必须立刻对得上。
      applyCommands: async (cwd, commands) => {
        const state = await applyCommands(cwd, commands)
        void syncDefaultModel(context)
        void hooks.refreshBlankSessions().catch((error: unknown) => {
          context.logger.warn(name + ': 切 pack 后重施加失败：' + String(error))
        })
        return state
      },
      // 试算不落盘，也不重新落地：面板每点一次控件都会调它，跟着同步默认模型与重施加
      // 会把「还没保存」的东西施加到已有会话上。
      previewCommands: (cwd, commands) => previewCommands(cwd, commands),
      resolve: (state, cwd) => resolve(state as PackState, cwd),
      resolvePrompt: (overrides) => resolvePrompt(overrides as PromptOverrides | undefined),
      builtinPrompt: () => BUILTIN_PROMPT,
      support: hooks.support,
      lastError: hooks.lastError,
      logger: context.logger,
    }

    const dispose = registerRoutes(
      face,
      ROUTES,
      {
        read: (body) => handleRead(deps, body),
        apply: (body) => handleApply(deps, body),
      },
      (path, error) => context.logger.warn(name + ': 注册路由失败（' + path + '）：' + String(error)),
    )
    context.effect(() => dispose)
  })

  // 启动时补一次：插件装上/重启后，默认模型可能还停留在上一次手动选择的值。
  void syncDefaultModel(context)

  context.logger.info(name + ': applied')
}
