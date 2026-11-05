import { connectMcp, type ConnectionSpec, type McpConnection, type McpToolInfo } from './mcp-connection.js'

/** 池里的一条：连接 + 工具目录 + 引用计数。 */
interface Entry {
  readonly key: string
  readonly connection: McpConnection
  readonly tools: readonly McpToolInfo[]
  refs: number
}

/** 一次加载拿到的句柄。同一个 key 的多次 acquire 拿到同一份目录。 */
export interface PoolHandle {
  readonly key: string
  readonly connection: McpConnection
  readonly tools: readonly McpToolInfo[]
}

export interface PoolOptions {
  /** 连接工厂，测试可替换。 */
  readonly connect?: (key: string, spec: ConnectionSpec) => Promise<McpConnection>
  /** 列工具的超时。 */
  readonly listTimeoutMs?: number
}

export interface Pool {
  acquire(key: string, spec: ConnectionSpec): Promise<PoolHandle>
  release(handle: PoolHandle): void
  /** 当前常驻连接数。 */
  size(): number
  keys(): readonly string[]
  closeAll(): Promise<void>
}

interface Slot {
  readonly entry: Promise<Entry>
}

/**
 * 宿主级常驻连接池。
 *
 * 三条性质：
 * 1. **一个 key 一条连接**：同一台 server 被同一会话、别的会话、子代理同时加载，
 *    都复用同一条连接（stdio 就是同一个子进程）。并发的首次 acquire 也只连一次。
 * 2. **引用计数**：`release` 只减少计数，最后一个引用释放才真正 close。会话结束
 *    与 `mcp_unload` 走同一条路径。
 * 3. **失败不留垃圾**：连接或首次列工具失败时，槽位立刻删除并关闭已建立的连接。
 */
export function createPool(options: PoolOptions = {}): Pool {
  const connect = options.connect ?? ((key, spec) => connectMcp(key, spec))
  const slots = new Map<string, Slot>()
  const live = new Map<string, Entry>()

  async function open(key: string, spec: ConnectionSpec): Promise<Entry> {
    const connection = await connect(key, spec)
    try {
      const tools = await connection.listTools()
      const entry: Entry = { key, connection, tools, refs: 0 }
      live.set(key, entry)
      return entry
    } catch (error) {
      await connection.close().catch(() => undefined)
      throw error
    }
  }

  return {
    async acquire(key, spec) {
      let slot = slots.get(key)
      if (slot === undefined) {
        slot = { entry: open(key, spec) }
        slots.set(key, slot)
        // 失败时删掉槽位，下一次 acquire 重新尝试，而不是记住失败。
        void slot.entry.catch(() => {
          if (slots.get(key) === slot) slots.delete(key)
        })
      }
      const entry = await slot.entry
      entry.refs += 1
      return { key: entry.key, connection: entry.connection, tools: entry.tools }
    },
    release(handle) {
      const entry = live.get(handle.key)
      if (entry === undefined) return
      entry.refs -= 1
      if (entry.refs > 0) return
      live.delete(entry.key)
      slots.delete(entry.key)
      void entry.connection.close().catch(() => undefined)
    },
    size() {
      return live.size
    },
    keys() {
      return [...live.keys()]
    },
    async closeAll() {
      const entries = [...live.values()]
      live.clear()
      slots.clear()
      await Promise.allSettled(entries.map((entry) => entry.connection.close()))
    },
  }
}
