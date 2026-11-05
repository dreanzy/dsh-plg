import { entryServerName, isMcpEntry, isSuppressed, release, suppress, type EntryLike } from './suppress.js'

/** 闸门要用到的宿主面。 */
export interface GateContext {
  get(name: string): unknown
  on(event: string, listener: (payload: unknown) => unknown): () => void
  logger: { warn(message: string): void }
}

export interface GateDeps {
  readonly context: GateContext
  /**
   * 某个 server 该不该挂载：`eager` 挂，其余不挂。
   *
   * 返回 `null` 表示**策略尚未就绪**（首次重算还没跑完）：此时什么都不做，
   * 等下一次 reconcile 再判。宁可晚一轮，也不要在空策略上把用户的 server 全摘掉。
   */
  readonly modeOf: (serverName: string) => 'eager' | 'dynamic' | 'lazy' | null
}

export interface Gate {
  /** 按当前策略重算全部 MCP 行：该挂的恢复，不该挂的摘掉。 */
  reconcile(): Promise<void>
  /** 订阅 `loader/entry-init`；返回解绑函数。 */
  attach(): () => void
  dispose(): void
  /** 自检：收到过多少次 entry-init，跑过几次重算。 */
  stats(): { readonly entryInitEvents: number; readonly reconciles: number }
}

function entriesOf(loader: unknown): readonly EntryLike[] {
  const face = loader as { entries?: () => Iterable<unknown> } | undefined
  if (typeof face?.entries !== 'function') return []
  return [...face.entries.call(loader)] as EntryLike[]
}

/**
 * 预加载闸门。
 *
 * 目标：`dynamic`/`lazy` 的行**根本不挂载**——`mcp-client` 不起进程、不注册工具。
 * 这样模型看不到它们，宿主的 `mcp-resources` 也没有目标 server 可访问，
 * 与「不挂载」路线语义一致。
 *
 * 三条纪律：
 * 1. **先遮蔽 `disabled` 再处置 fiber**，否则 Loader 会把 `disabled: true` 写回用户的配置。
 * 2. 闸门状态只存在于内存：遮蔽是实例自有属性，`delete` 即恢复。
 * 3. `loader/entry-init` 在 `options` 赋值前发出，必须等到下一个 microtask 再读。
 */
export function createGate(deps: GateDeps): Gate {
  let pending = false
  let queued = false
  let off: (() => void) | null = null
  let entryInitEvents = 0
  let reconciles = 0

  async function run(): Promise<void> {
    const loader = deps.context.get('loader')
    if (loader === undefined) return
    for (const entry of entriesOf(loader)) {
      if (!isMcpEntry(entry)) continue
      const serverName = entryServerName(entry)
      if (serverName === null) continue
      try {
        const mode = deps.modeOf(serverName)
        // 未就绪：保持现状，等下一次重算。
        if (mode === null) continue
        if (mode === 'eager') {
          await release(entry)
        } else {
          suppress(entry)
        }
      } catch (error) {
        deps.context.logger.warn(`dsh-mcp-manager: 处置 MCP 行失败（${serverName}）：${String(error)}`)
      }
    }
  }

  return {
    async reconcile() {
      if (pending) {
        queued = true
        return
      }
      pending = true
      reconciles += 1
      try {
        await run()
      } finally {
        pending = false
        if (queued) {
          queued = false
          await run().catch(() => undefined)
        }
      }
    },
    attach() {
      if (off !== null) return off
      try {
        off = deps.context.on('loader/entry-init', () => {
          entryInitEvents += 1
          // entry-init 时 options 还没填，下一个 microtask 才读得到 name 与 serverName。
          queueMicrotask(() => {
            void this.reconcile().catch(() => undefined)
          })
        })
      } catch (error) {
        deps.context.logger.warn(`dsh-mcp-manager: 订阅 loader/entry-init 失败：${String(error)}`)
        off = () => {}
      }
      return off
    },
    dispose() {
      off?.()
      off = null
    },
    stats() {
      return { entryInitEvents, reconciles }
    },
  }
}

/** 诊断用：当前被闸门摘掉的行。 */
export function suppressedServers(loader: unknown): readonly string[] {
  const out: string[] = []
  for (const entry of entriesOf(loader)) {
    if (!isSuppressed(entry)) continue
    const serverName = entryServerName(entry)
    if (serverName !== null) out.push(serverName)
  }
  return out.sort((left, right) => left.localeCompare(right))
}