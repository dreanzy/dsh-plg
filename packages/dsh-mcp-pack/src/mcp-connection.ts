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
}

/** 一条活连接。 */
export interface McpConnection {
  readonly key: string
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
 * 连上一台 MCP server。
 *
 * 连接失败一律抛出原始错误：调用方要据此告诉模型「这台连不上」，而不是给一个
 * 空工具列表让它以为服务器没有工具。
 */
export async function connectMcp(key: string, spec: ConnectionSpec, options: { readonly timeoutMs?: number } = {}): Promise<McpConnection> {
  const client = new Client({ name: 'dsh-mcp-pack', version: '0.1.0' }, { capabilities: {} })
  await client.connect(createTransport(spec))
  const deadline = timeoutOf(options.timeoutMs, 30_000)

  return {
    key,
    async listTools() {
      const result = await client.listTools(undefined, { timeout: deadline })
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      }))
    },
    async callTool(name, args, callOptions = {}) {
      // 第二参数是 **zod result schema**，不是 options。传一个普通对象进去，
      // SDK 会去调 `resultSchema.safeParse`，报 "safeParse is not a function"。
      // options 必须放第三个参数。
      return await client.callTool({ name, arguments: args }, undefined, {
        timeout: timeoutOf(callOptions.timeoutMs, 60_000),
        ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
      })
    },
    async close() {
      await client.close()
    },
  }
}