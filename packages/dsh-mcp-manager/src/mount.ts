import type { ServerDef } from './servers.js'

/** Cordis 上下文里挂载插件用到的面。 */
export interface PluginHost {
  plugin(plugin: unknown, config?: unknown): unknown
}

/** 宿主 `dsh-mcp-client` 模块里挂载所需的导出。 */
export interface McpClientModule {
  readonly name?: unknown
  readonly inject?: unknown
  readonly apply?: unknown
}

/** 一条已挂载的托管 server。 */
export interface MountHandle {
  readonly serverName: string
  readonly dispose: () => void
}

/** 把定义翻成宿主 `Config` 的形状。 */
export function mountConfig(serverName: string, def: ServerDef): Record<string, unknown> {
  if (def.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName,
      command: def.command,
      args: [...def.args],
      env: { ...def.env },
      cwd: def.cwd,
    }
  }
  return {
    transport: 'streamable-http',
    serverName,
    url: def.url,
    headers: { ...def.headers },
  }
}

/**
 * 运行时挂载一台托管的 MCP server。
 *
 * 走 `ctx.plugin` 而不是往组合里写行：托管定义完全归本插件所有，不进 Loader 的
 * entry 树，也就不受闸门影响——它挂不挂由我们直接决定。这也意味着**不碰用户的
 * `cordis.patch.yml`**，与「闸门绝不写回」是同一条底线。
 *
 * `apply` 交给宿主自己执行，我们不 await：`mcp-client` 的 apply 会连接 server，
 * 慢的那台不该卡住插件启动。连接失败由它自己重试。
 */
export function mountMcpServer(
  host: PluginHost,
  module: unknown,
  serverName: string,
  def: ServerDef,
): MountHandle {
  const face = module as McpClientModule | null
  if (face === null || typeof face !== 'object' || typeof face.apply !== 'function') {
    throw new Error('宿主 dsh-mcp-client 模块缺少 apply，无法运行时挂载')
  }
  const handle = host.plugin(
    { name: face.name, inject: face.inject, apply: face.apply },
    mountConfig(serverName, def),
  )
  return {
    serverName,
    dispose() {
      try {
        const disposable = handle as { dispose?: unknown } | null
        if (typeof disposable?.dispose === 'function') (disposable.dispose as () => unknown).call(handle)
      } catch {
        // 卸载失败只影响这一次，没有可回滚的状态。
      }
    },
  }
}
