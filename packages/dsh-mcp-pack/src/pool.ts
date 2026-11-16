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
  /** 池已关闭：`open` 在飞时被 `closeAll` 打断，恢复后不能再把连接塞回 `live`。 */
  let closed = false

  async function open(key: string, spec: ConnectionSpec): Promise<Entry> {
    const connection = await connect(key, spec)
    let handed = false
    try {
      const tools = await connection.listTools()
      // 两个 await 之间池可能已被关闭：这条连接没人认领，必须自己关掉，
      // 否则 stdio 下就是一个永不退出的子进程。
      if (closed) throw new Error('连接池已关闭，本次连接作废')
      const entry: Entry = { key, connection, tools, refs: 0 }
      live.set(key, entry)
      handed = true
      return entry
    } catch (error) {
      // 只关一次：closed 分支抛出的错误也会走到这里。
      if (!handed) await connection.close().catch(() => undefined)
      throw error
    }
  }

  const acquire = async (key: string, spec: ConnectionSpec): Promise<PoolHandle> => {
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
      // await 期间这条 entry 可能已被 release 关掉（refs 归零、从 live 摘除）。
      // 此时拿到的是一条死连接：重开一次，而不是把 refs 加到一个没人管的 entry 上。
      if (live.get(key) !== entry) {
        if (slots.get(key) === slot) slots.delete(key)
        return await acquire(key, spec)
      }
      // 底层传输已断（子进程崩溃、HTTP 断开）：摘掉重连，而不是把死连接交出去。
      // 没有这一条，server 崩一次就永久废掉，每次调用都报 Not connected。
      if (!entry.connection.alive()) {
        live.delete(key)
        if (slots.get(key) === slot) slots.delete(key)
        void entry.connection.close().catch(() => undefined)
        return await acquire(key, spec)
      }
      entry.refs += 1
      return { key: entry.key, connection: entry.connection, tools: entry.tools }
  }

  return {
    acquire,
    release(handle) {
      const entry = live.get(handle.key)
      if (entry === undefined) return
      // 只释放属于当前 entry 的 handle：旧 handle 二次 release 会减到新 entry 的
      // refs 上，提前关掉别的会话正在用的连接。
      if (handle.connection !== entry.connection) return
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
      closed = true
      const entries = [...live.values()]
      live.clear()
      slots.clear()
      await Promise.allSettled(entries.map((entry) => entry.connection.close()))
    },
  }
}
