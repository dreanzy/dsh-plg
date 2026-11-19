import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** 一台 MCP server 的连接参数，形状与宿主 `dsh-mcp-client` 的 Config 对齐。 */
export type ConnectionSpec =
  | {
      readonly transport: 'stdio'
      readonly serverName: string
      readonly command: string
      readonly args?: readonly string[]
      readonly env?: Readonly<Record<string, string>>
      readonly cwd?: string
    }
  | {
      readonly transport: 'streamable-http'
      readonly serverName: string
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
    }

/** 一台 server 的工具摘要。 */
export interface McpToolInfo {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  /**
   * 上游声明的任务执行要求（MCP `Tool.execution.taskSupport`）。
   *
   * 宿主 `createMcpToolDefinition` 见到 `required` 会直接拒绝，而不是把调用发出去
   * 等上游挂起；本地不透传就等于把这个判断丢了。
   */
  readonly taskSupport?: 'required' | 'optional' | 'forbidden'
}

/** 一条活连接。 */
export interface McpConnection {
  readonly key: string
  /**
   * 会话代数：每重建一次底层会话就 +1。
   *
   * 池靠它判断缓存的工具目录是否过期。服务端重启后工具列表可能变了（插件升级、
   * 换项目），而池里的 `tools` 是首次连接时列的——不刷新的话，新工具永远看不到，
   * `mcp_call` 还会因为 `admitted` 检查用旧目录而拒绝它。
   */
  generation(): number
  /**
   * 底层传输是否还活着。
   *
   * stdio 子进程崩溃、HTTP 断开后连接对象仍在，池无从得知。没有这个判据时，
   * 后续 acquire 会一直返回死连接，每次 callTool 都报 Not connected，直到用户
   * 手动 unload——server 崩一次就永久废掉。
   */
  alive(): boolean
  listTools(): Promise<readonly McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<unknown>
  close(): Promise<void>
}

/**
 * 子进程能继承的环境变量白名单。
 *
 * 以前按名字黑名单过滤（含 KEY/TOKEN 就丢），但 `DATABASE_URL` 这类带密码的连接串会原样
 * 漏出去。stdio server 是任意第三方程序，只给启动必需项；别的由用户在配置的 env 里写。
 *
 * 代理与私有源（`HTTP_PROXY`、`UV_DEFAULT_INDEX` 一类）刻意不传：它们的值里常带凭据，
 * 而「哪台 server 该走哪个代理」只有用户知道，走配置的 `env` 显式声明。
 */
const PASSTHROUGH_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  // 启动器自己的安装位置：uvx / cargo / java / playwright 找不到这些就会去默认目录扑空。
  'UV_CACHE_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'UV_PYTHON_BIN_DIR',
  'UV_TOOL_DIR',
  'UV_TOOL_BIN_DIR',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'PLAYWRIGHT_BROWSERS_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

export function buildChildEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!PASSTHROUGH_ENV.has(name.toUpperCase())) continue
    env[name] = value
  }
  return { ...env, ...extra }
}

function createTransport(spec: ConnectionSpec) {
  if (spec.transport === 'stdio') {
    return new StdioClientTransport({
      command: spec.command,
      args: [...(spec.args ?? [])],
      env: buildChildEnv(spec.env),
      ...(spec.cwd === undefined || spec.cwd === '' ? {} : { cwd: spec.cwd }),
    })
  }
  return new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: { ...(spec.headers ?? {}) } },
  })
}

function timeoutOf(ms: number | undefined, fallback: number): number {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : fallback
}

/**
 * 从工具执行的 `exec` 里取取消信号。
 *
 * 宿主的 `exec` 形状没有公开契约；拿不到就返回空对象，调用照常进行。
 */
export function callOptionsFromExec(exec: unknown): { readonly signal?: AbortSignal } {
  const signal = (exec as { signal?: unknown } | undefined)?.signal
  return signal instanceof AbortSignal ? { signal } : {}
}

/**
 * 传输层已经不可用的错误码。
 *
 * 只收「重连可能成功」的那几个：服务端刚重启（ECONNREFUSED）、连接被断
 * （ECONNRESET / EPIPE）、超时（ETIMEDOUT）、undici 的 socket 错误。
 * DNS 解析失败（ENOTFOUND / EAI_AGAIN）刻意不收：重连只会再失败一次，
 * 白白多一次网络往返。
 */
const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
])

/**
 * 这条连接已经不可用了。
 *
 * 两类，SDK 都不处理，`onclose` 都不触发，`alive()` 都会一直报「活着」：
 *
 * 1. **服务端回收了 session**：Streamable HTTP 的 session 归服务端所有，空闲超时后
 *    直接丢弃，此后所有带旧 `Mcp-Session-Id` 的请求返回 404 与 `Session not found`。
 * 2. **传输层断了**：HTTP 没有长连接，服务端进程挂掉时客户端这边什么都不会发生，
 *    下一次请求才报 `fetch failed`（cause 里是 ECONNREFUSED 一类）。
 *
 * 两类都必须重建会话：不重建的话，池会一直交出这条死连接，每次调用都失败，
 * 直到进程重启。
 */
function isConnectionLost(error: unknown): boolean {
  const record = error as { message?: unknown; cause?: { code?: unknown } } | null | undefined
  if (record === null || record === undefined) return false
  const message = typeof record.message === 'string' ? record.message : ''
  // 只认服务端这句明确的语义。单看 404 不够：URL 写错、路径不存在也是 404，
  // 那种情况重连一次仍然失败，只会把真实错误盖成第二次的同一个错误。
  if (/session not found/iu.test(message)) return true
  if (!/fetch failed/iu.test(message)) return false
  const code = record.cause?.code
  return typeof code === 'string' && CONNECTION_LOST_CODES.has(code)
}

/** 一条底层会话。`dead` 只属于它自己：重连后旧会话的 onclose 不能污染新会话。 */
interface Session {
  readonly client: Client
  dead: boolean
}

/**
 * 连上一台 MCP server。
 *
 * 连接失败一律抛出原始错误：调用方要据此告诉模型「这台连不上」，而不是给一个
 * 空工具列表让它以为服务器没有工具。
 *
 * 连接**自愈**：服务端回收 session 后，下一次调用会重建会话并重试一次。没有这一条，
 * 一次空闲超时就让这台 server 永久废掉——池的 `alive()` 判据看不见 session 失效，
 * 只会一直把这条死连接交出去。
 */
export async function connectMcp(key: string, spec: ConnectionSpec, options: { readonly timeoutMs?: number } = {}): Promise<McpConnection> {
  const deadline = timeoutOf(options.timeoutMs, 30_000)
  let current: Session | null = null
  let connecting: Promise<Session> | null = null
  let closed = false
  /** 会话代数：每次重建 +1，池据此判断工具目录是否过期。 */
  let generation = 0

  const open = async (): Promise<Session> => {
    const client = new Client({ name: 'dsh-mcp-pack', version: '0.1.0' }, { capabilities: {} })
    const session: Session = { client, dead: false }
    // 先挂 onclose 再 connect：连接期间的关闭也要记下来。
    client.onclose = () => {
      session.dead = true
    }
    await client.connect(createTransport(spec))
    return session
  }

  /**
   * 取一条可用会话，必要时重连。
   *
   * 并发调用共享同一次重连：`connecting` 是单飞的，否则 N 个并发调用会各建一条
   * 连接，前 N-1 条立刻变成没人认领的孤儿。
   */
  const ensure = async (): Promise<Session> => {
    if (closed) throw new Error('连接已关闭')
    if (current !== null && !current.dead) return current
    if (connecting === null) {
      connecting = open().then(
        (session) => {
          connecting = null
          // 建好时连接可能已被 close：这条没人认领，自己关掉，别塞回 current。
          if (closed) {
            void session.client.close().catch(() => undefined)
            throw new Error('连接已关闭')
          }
          current = session
          generation += 1
          return session
        },
        (error: unknown) => {
          connecting = null
          throw error
        },
      )
    }
    return await connecting
  }

  /** 作废一条会话：标记、摘掉、关掉。 */
  const drop = (session: Session): void => {
    session.dead = true
    if (current === session) current = null
    void session.client.close().catch(() => undefined)
  }

  /**
   * 跑一次请求，连接失效时重建并重试一次。
   *
   * 只重试一次——重连后仍失败说明不是连接的问题，再试只会放大故障。
   */
  const withSession = async <T>(request: (session: Session) => Promise<T>): Promise<T> => {
    const session = await ensure()
    try {
      return await request(session)
    } catch (error) {
      if (!isConnectionLost(error)) throw error
      drop(session)
      return await request(await ensure())
    }
  }

  // 首次连接失败要抛给调用方：池据此判断「这台连不上」。
  await ensure()

  return {
    key,
    generation: () => generation,
    alive: () => !closed && (connecting !== null || (current !== null && !current.dead)),
    async listTools() {
      const result = await withSession((session) => session.client.listTools(undefined, { timeout: deadline }))
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(tool.execution?.taskSupport === undefined ? {} : { taskSupport: tool.execution.taskSupport }),
      }))
    },
    async callTool(name, args, callOptions = {}) {
      // 第二参数是 **zod result schema**，不是 options。传一个普通对象进去，
      // SDK 会去调 `resultSchema.safeParse`，报 "safeParse is not a function"。
      // options 必须放第三个参数。
      return await withSession((session) =>
        session.client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutOf(callOptions.timeoutMs, 60_000),
          ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
        }),
      )
    },
    async close() {
      closed = true
      const session = current
      current = null
      if (session !== null) await session.client.close()
      if (connecting !== null) {
        // 在飞的连接没人认领，等它建好再关掉，否则就是一条永不退出的子进程。
        void connecting.then((late) => late.client.close()).catch(() => undefined)
      }
    },
  }
}