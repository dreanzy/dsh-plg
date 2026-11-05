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

/** 凭证形状的环境变量名：绝不透传给子进程。 */
const CREDENTIAL_SHAPED = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/iu

/**
 * 子进程环境：父进程里像凭证、或 `DSH_*` 的变量一律丢掉，再加上声明里显式给的。
 *
 * 理由：stdio server 是任意第三方程序，把宿主的密钥顺手递给它等于把凭据交给
 * 一个只承诺「做 MCP」的进程。显式声明要传的，由用户在配置里写。
 */
export function buildChildEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (name.startsWith('DSH_')) continue
    if (CREDENTIAL_SHAPED.test(name)) continue
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
 * 连上一台 MCP server。
 *
 * 连接失败一律抛出原始错误：调用方要据此告诉模型「这台连不上」，而不是给一个
 * 空工具列表让它以为服务器没有工具。
 */
export async function connectMcp(key: string, spec: ConnectionSpec, options: { readonly timeoutMs?: number } = {}): Promise<McpConnection> {
  const client = new Client({ name: 'dsh-mcp-manager', version: '0.1.0' }, { capabilities: {} })
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