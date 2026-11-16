import { asRecord } from './unknown.js'
import { cwdFromAgent, cwdFromObserved } from './cwd.js'

/**
 * 路由层需要的最小 ctx 面。
 *
 * `label` 是包名，只用于日志前缀：core 不知道自己在为哪个插件服务，而「哪个插件在
 * 泄漏」是诊断时第一个要回答的问题。它由各包的 `index.ts` 从 `export const name`
 * 传入，不在调用点重复写——第五个包忘了传会编译报错，而不是静默记错前缀。
 */
export interface RouteContext {
  get(name: string): unknown
  logger: { warn(message: string): void }
  readonly label: string
}

/**
 * 一次会话解析的结论。
 *
 * 可辨识联合：`live: true` 时 `agent` 一定在，`live: false` 时一定不在。
 * 调用方不需要再记「非 live 时 agent 是 undefined」这条隐式约定——类型系统挡住误用。
 */
export type SessionResolution =
  | { readonly live: true; readonly cwd: string; readonly agent: unknown }
  | { readonly live: false; readonly cwd: string }

/**
 * 把 `sessionId` 解析成工作目录与它的 live Agent。
 *
 * `agent` 必须是 `agents.get()` 返回的**对象本体**：`dsh-scope` 按对象身份查
 * 作用域链，形状相同的替身查不到 agent 层，清单会静默退化成 global 层。
 *
 * 先问 live Agent，再退回 `sessionQuery` 的只读观察（后者没有 scope，只能给出 cwd）。
 * 两条路径都失败时返回 `null`，由调用方决定报错还是降级。
 */
export async function resolveSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<SessionResolution | null> {
  const agents = asRecord(ctx.get('agents'))
  const get = agents?.['get']
  if (typeof get === 'function') {
    try {
      const agent = (get as (id: string) => unknown).call(agents, sessionId)
      const cwd = cwdFromAgent(agent)
      if (cwd !== null) return { live: true, cwd, agent }
    } catch {
      // Agent 侧失败不致命，继续问 sessionQuery。
    }
  }

  const query = asRecord(ctx.get('sessionQuery'))
  const observe = query?.['observeSession']
  if (typeof observe === 'function') {
    let observation: unknown
    try {
      // 不带 `projectionMode: 'none'`：历史会话的当前目录同样只在投影里。
      observation = await (observe as (id: string) => Promise<unknown>).call(query, sessionId)
      const cwd = cwdFromObserved(observation)
      if (cwd !== null) return { live: false, cwd }
    } catch {
      // 未知会话在这里 reject；交给调用方报错。
    } finally {
      releaseObservation(ctx, observation, sessionId)
    }
  }

  return null
}

/**
 * 释放观察体。
 *
 * 宿主为每次观察保留订阅，漏一次就是一条长期泄漏；它只暴露 `Symbol.dispose`，
 * 没有 `.dispose()`。
 *
 * 刻意不导出：调用方拿不到，也就不可能漏。将来真有别处需要 `observeSession`，
 * 那时再开 seam——一个 adapter 意味着假想 seam。
 */
function releaseObservation(ctx: RouteContext, observation: unknown, sessionId: string): void {
  const record = asRecord(observation)
  if (record === null) return
  try {
    const dispose = (record as Record<symbol, unknown>)[Symbol.dispose]
    if (typeof dispose === 'function') (dispose as () => void).call(observation)
  } catch (error) {
    ctx.logger.warn(`${ctx.label}: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
  }
}
