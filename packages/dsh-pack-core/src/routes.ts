/**
 * 面板路由的注册骨架。
 *
 * 四个插件各有自己的面板，但注册路径是同一套：取 `connection.fetch.register`、
 * 把 handler 包成 `fetch` 处理器、收集 disposer、卸载时逐个释放。
 *
 * 一条硬约束住在这里：**HTTP 状态恒为 200**，错误只走信封里的 `code`。前端只认
 * 信封；非 2xx 会让它丢掉 body，面板就只剩一句「请求失败」。
 *
 * 这条不变式原先只写在四份注释里，没有任何测试守护——mcp 的原型链 op 报
 * `internal` 而不是 `bad-request` 就是这么漏掉的。
 */

import type { Envelope } from './protocol.js'

/** 一条路由的注册规格。宿主按完整 pathname 匹配。 */
export interface FetchRouteSpec {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response>
}

/** 宿主 `connection.fetch` 的最小面。 */
export interface FetchFace {
  register(spec: FetchRouteSpec): () => unknown
}

/** 一条路由的处理函数：吃已解析的 body，吐信封。 */
export type RouteHandler = (body: Record<string, unknown> | null) => Promise<Envelope<unknown>>

/**
 * 信封 → Response。
 *
 * 状态码恒为 200：前端只认信封里的 `code`，非 2xx 会让它丢掉 body。
 * `cache-control: no-store` 是必须的——面板每次打开都要读最新策略。
 */
export function toResponse(envelope: Envelope<unknown>): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 把 handler 包成 `fetch` 处理器。
 *
 * 两件事：
 * 1. body 解析失败一律当 `null`——空体合法，全局读取不需要任何入参。
 * 2. handler 抛错转成 `internal` 信封，不让异常冒泡成 500。
 */
export function wrap(handler: RouteHandler): (request: Request) => Promise<Response> {
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
        error: { code: 'internal', message: `路由处理失败：${String(error)}` },
      })
    }
  }
}

/**
 * 取连接服务的 `fetch.register`。
 *
 * 无 `connection` 服务（无 GUI 的 profile）或服务存在但没有 `fetch` 都返回 `null`：
 * 那是「没有面板入口」，不是故障，调用方只 warn。
 *
 * `ctx.get` 必须包 try/catch：对取不到的**已声明**服务它会抛错，不是返回
 * `undefined`。`connection` 在四个包的 `inject` 里都声明了，取不到就抛，
 * 不包的话整个 `apply` 会失败。
 */
export function readFetchFace(ctx: { get(name: string): unknown }): FetchFace | null {
  let connection: unknown
  try {
    connection = ctx.get('connection')
  } catch {
    return null
  }
  if (typeof connection !== 'object' || connection === null) return null
  const fetchFace = (connection as Record<string, unknown>)['fetch']
  if (typeof fetchFace !== 'object' || fetchFace === null) return null
  const register = (fetchFace as Record<string, unknown>)['register']
  if (typeof register !== 'function') return null
  return {
    register: (spec: FetchRouteSpec) => (register as (value: FetchRouteSpec) => () => unknown).call(fetchFace, spec),
  }
}

/**
 * 按表注册路由，返回一个释放函数。
 *
 * `routes` 与 `handlers` 同键：加一条路由只改两处，而这里保证它们不会错位。
 * 单条注册失败只 warn 并继续——一条路由坏了不该让另外两条也起不来。
 *
 * 释放函数逐个 try/catch：宿主返回的 disposer 可能是同步函数，也可能返回 Promise；
 * 两者都要处理，且任何一个失败都不能挡住后面的。
 */
export function registerRoutes(
  face: FetchFace,
  routes: Readonly<Record<string, string>>,
  handlers: Readonly<Record<string, RouteHandler>>,
  onError: (path: string, error: unknown) => void,
): () => void {
  const disposers: Array<() => unknown> = []
  for (const [key, path] of Object.entries(routes)) {
    const handler = handlers[key]
    if (handler === undefined) continue
    try {
      disposers.push(face.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: wrap(handler) }))
    } catch (error) {
      onError(path, error)
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
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
  }
}
